import { ChannelInbox } from "./channel-inbox.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
    constants,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    readdirSync,
    existsSync,
    lstatSync,
    unlinkSync,
    openSync,
    closeSync,
    fsyncSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { problem } from "./personal-http.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function sourceFingerprint(source) {
    const part = (value) => Buffer.byteLength(value, "utf8") + ":" + value;
    const array = (values) => values.length + ":" + values.map(part).join("");
    return hash(
        "modeller-source-connection/v1\n" +
            [
                source.id,
                source.root,
                source.format,
                source.identityDomain || "",
                source.trustPatientRegistration ? "true" : "false",
                array(source.projects),
                array(source.owners),
            ]
                .map(part)
                .join(""),
    );
}
const LIMIT = 16 * 1024 * 1024;
const ids = /^[a-f0-9]{64}$/;
const projectId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const terminal = new Set(["COMPLETED", "COMPLETED_WITH_FAILURES"]);
function json(file) {
    if (lstatSync(file).size > 8 * 1024 * 1024) throw problem("Stored integration metadata exceeds the limit.", 503);
    return JSON.parse(readFileSync(file, "utf8"));
}
function save(file, value) {
    const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    const fd = openSync(temp, "r");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temp, file);
    const parent = openSync(resolve(file, ".."), "r");
    try {
        fsyncSync(parent);
    } finally {
        closeSync(parent);
    }
}
function fields(value, allowed) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        throw problem("Invalid integration fields.");
}

export class ProcessingWorkspace {
    constructor(config, core, { launcher = spawn, clock = Date.now } = {}) {
        this.config = config;
        this.core = core;
        this.launcher = launcher;
        this.clock = clock;
        this.inspectors = new Map();
        this.originalDownloads = new Set();
        this.inspectionRequests = 0;
        this.root = join(config.dataDir, "processing");
        this.active = new Map();
        this.pending = new Map();
        this.channels = new Map();
        this.stable = new Map();
        this.ticking = false;
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        this.inbox = new ChannelInbox(join(this.root, "channel-inbox.sqlite"));
        this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
        this.timer.unref();
        for (const owner of readdirSync(this.root).filter((name) => ids.test(name))) {
            const directory = join(this.root, owner, "channels");
            if (!existsSync(directory)) continue;
            for (const name of readdirSync(directory).filter(
                (name) => ids.test(name.slice(0, -5)) && name.endsWith(".json"),
            )) {
                const channel = json(join(directory, name));
                // Restart requires an explicit resume; pending data and checkpoints remain intact.
                if (channel.status === "RUNNING" || channel.status === "STOPPING" || channel.activeJob) {
                    if (channel.activeJob) channel.interruptedJob = channel.activeJob;
                    channel.activeJob = null;
                    channel.activeJobs = [];
                    channel.status = "INTERRUPTED";
                    save(join(directory, name), channel);
                }
                this.channels.set(owner + ":" + channel.id, channel);
            }
        }
    }
    owner(session) {
        if (typeof session?.identity !== "string") throw problem("Sign in to use integrations.", 401);
        return hash(session.identity);
    }
    directory(session, kind) {
        const folder = join(this.root, this.owner(session), kind);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        return folder;
    }
    connections(owner, project) {
        let configured = this.config.integrationConnectionsFile
            ? json(this.config.integrationConnectionsFile)
            : { sources: [], destinations: [], requireTerminology: true };
        fields(configured, ["sources", "destinations", "requireTerminology"]);
        for (const kind of ["sources", "destinations"]) {
            const ids = (configured[kind] || []).map((item) => item.id);
            if (new Set(ids).size !== ids.length)
                throw problem("Registered connection identifiers must be unique across the installation.", 503);
        }
        const allowed = (item) =>
            Array.isArray(item.owners) &&
            item.owners.includes(owner) &&
            Array.isArray(item.projects) &&
            (!project || item.projects.includes(project));
        const sources = (configured.sources || []).filter(allowed),
            destinations = (configured.destinations || []).filter(allowed);
        const uploads = join(this.root, owner, "sources");
        if (existsSync(uploads))
            for (const name of readdirSync(uploads).filter((name) => ids.test(name))) {
                const item = json(join(uploads, name, "source.json"));
                if (project && item.projectId !== project) continue;
                sources.push({
                    id: name,
                    root: join(uploads, name),
                    format: item.format,
                    identityDomain: item.identityDomain || null,
                    projects: [item.projectId],
                    owners: [owner],
                    displayName: item.displayName,
                    uploaded: true,
                });
            }
        if (this.kafka) sources.push(...this.kafka.connections(owner, project));
        if (this.vendor) sources.push(...this.vendor.connections(owner, project));
        if (this.destinations) destinations.push(...this.destinations.connections(owner, project));
        return { sources, destinations, requireTerminology: configured.requireTerminology !== false };
    }
    checkQuota(session) {
        return this.checkOwnerQuota(this.owner(session));
    }
    checkOwnerQuota(owner) {
        let total = 0,
            entries = 0;
        const walk = (directory) => {
            for (const name of readdirSync(directory)) {
                if (++entries > 50000) throw problem("Private workspace storage limit reached.", 413);
                const path = join(directory, name),
                    stat = lstatSync(path);
                if (stat.isSymbolicLink()) throw problem("Invalid private storage.", 503);
                if (stat.isDirectory()) walk(path);
                else total += stat.size;
                if (total > 512 * 1024 * 1024)
                    throw problem(
                        "Private workspace storage limit reached. Ask the operator to archive completed jobs.",
                        413,
                    );
            }
        };
        const root = join(this.root, owner);
        if (existsSync(root)) walk(root);
        return total;
    }
    async upload(session, input, bytes) {
        this.checkQuota(session);
        fields(input, ["projectId", "format", "name", "identityDomain"]);
        if (
            !projectId.test(input.projectId) ||
            ![
                "csv",
                "json",
                "fhir-json",
                "openehr-json",
                "xml",
                "xlsx",
                "hl7-v2",
                "hl7-v2-xml",
                "hl7-v3",
                "cda",
            ].includes(input.format) ||
            typeof input.identityDomain !== "string" ||
            !input.identityDomain.trim() ||
            input.identityDomain.length > 256 ||
            /[\r\n\0]/.test(input.identityDomain) ||
            typeof input.name !== "string" ||
            input.name.length > 180 ||
            /[\r\n\0]/.test(input.name) ||
            !Buffer.isBuffer(bytes) ||
            bytes.length < 1 ||
            bytes.length > LIMIT
        )
            throw problem("Choose a supported private source file within 16 MiB.");
        await this.core.request(session, "GET", "/api/v1/integration/projects/" + input.projectId);
        const owner = this.owner(session),
            digest = hash(bytes),
            id = hash(input.projectId + "\n" + input.format + "\n" + input.identityDomain + "\n" + digest);
        const directory = join(this.directory(session, "sources"), id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!existsSync(join(directory, "source.bin")))
            writeFileSync(join(directory, "source.bin"), bytes, { mode: 0o600, flag: "wx" });
        save(join(directory, "source.json"), {
            projectId: input.projectId,
            format: input.format,
            identityDomain: input.identityDomain,
            displayName: basename(input.name),
            sha256: digest,
        });
        return {
            id,
            format: input.format,
            displayName: basename(input.name),
            sha256: digest,
            file: "source.bin",
            private: true,
        };
    }
    listConnections(session, project) {
        const result = this.connections(this.owner(session), project);
        return {
            ownerScope: this.owner(session),
            sources: result.sources.map((s) => ({
                id: s.id,
                format: s.format,
                displayName: s.displayName || s.id,
                projects: s.projects,
                uploaded: !!s.uploaded,
                identityDomain: s.identityDomain || null,
                trustPatientRegistration: !!s.trustPatientRegistration,
                captureMode: s.kafka
                    ? "kafka-durable-offsets"
                    : s.vendor
                      ? s.incremental
                          ? "incremental"
                          : "admitted-snapshots-only"
                      : "folder",
            })),
            destinations: result.destinations.map((d) => ({
                standard: d.standard || "fhir",
                id: d.id,
                displayName: d.displayName || d.id,
                resourceTypes: d.resourceTypes,
                readResourceTypes: d.readResourceTypes || null,
                projects: d.projects,
            })),
            databaseDrivers: [],
            clinicalDatabasePolicy: "READ_ONLY",
            requireTerminology: result.requireTerminology,
        };
    }
    source(owner, project, id) {
        return (
            this.connections(owner, project).sources.find((s) => s.id === id) ||
            (() => {
                throw problem("Source is unavailable for this identity/project.", 403);
            })()
        );
    }
    matches(source, name) {
        return source.uploaded
            ? name === "source.bin"
            : name.toLowerCase().endsWith(
                  "." +
                      ({
                          "fhir-json": "json",
                          "openehr-json": "json",
                          "hl7-v2": "hl7",
                          "hl7-v2-xml": "xml",
                          "hl7-v3": "xml",
                          cda: "xml",
                      }[source.format] || source.format),
              );
    }
    async file(source, name, capture = false) {
        if (
            typeof name !== "string" ||
            !this.matches(source, name) ||
            name !== basename(name) ||
            name.length > 180 ||
            name === "." ||
            name === ".." ||
            /[\\\r\n\0]/.test(name)
        )
            throw problem("Choose a source file.");
        const path = join(resolve(source.root), name);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size < 1 || stat.size > LIMIT)
                throw problem("The source file exceeds its limit.");
            const digest = createHash("sha256"),
                buffer = Buffer.alloc(16384),
                chunks = [];
            let length = 0;
            for (;;) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                length += bytesRead;
                if (length > LIMIT) throw problem("The source file changed or exceeds its limit.");
                digest.update(buffer.subarray(0, bytesRead));
                if (capture) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
            return {
                name,
                sha256: digest.digest("hex"),
                size: length,
                ...(capture ? { bytes: Buffer.concat(chunks) } : {}),
            };
        } finally {
            await handle.close();
        }
    }
    files(session, project, id) {
        const source = this.source(this.owner(session), project, id),
            names = readdirSync(source.root);
        if (names.length > 10000) throw problem("Source discovery exceeds 10,000 entries.", 413);
        return {
            items: names
                .filter((name) => this.matches(source, name))
                .sort()
                .flatMap((name) => {
                    const stat = lstatSync(join(source.root, name));
                    return stat.isFile() && !stat.isSymbolicLink()
                        ? [{ name, size: stat.size, modified: stat.mtimeMs }]
                        : [];
                }),
        };
    }
    ticket(owner, kind, value) {
        for (const [key, item] of this.pending)
            if (item.expires < this.clock() || (item.owner === owner && item.kind === kind)) this.pending.delete(key);
        if (this.pending.size >= 128) throw problem("Integration confirmations are busy.", 429);
        const token = randomBytes(32).toString("hex");
        this.pending.set(token, { owner, kind, value, expires: this.clock() + 120000 });
        return { confirmation: token, confirmationRequired: true, kind, summary: value };
    }
    take(session, token, kind) {
        const item = this.pending.get(token);
        if (!item || item.owner !== this.owner(session) || item.kind !== kind || item.expires < this.clock())
            throw problem("This integration confirmation expired. Review it again.", 409);
        this.pending.delete(token);
        return item.value;
    }
    async selection(session, project, subject) {
        if (!projectId.test(project) || !ids.test(subject)) throw problem("Choose a valid mapping.");
        const mapping = await this.core.request(session, "GET", "/api/v1/integration/mappings/" + subject);
        if (mapping.project !== project || !mapping.mappingConfirmed)
            throw problem("Confirm the exact mapping and supplied models before running.", 409);
        return mapping;
    }
    async inspect(session, input) {
        fields(input, ["projectId", "sourceId", "file", "sourceContractKey"]);
        this.checkQuota(session);
        if (this.active.size + this.inspectionRequests >= 2) throw problem("Processing workers are busy.", 429);
        this.inspectionRequests++;
        try {
            await this.core.request(session, "GET", "/api/v1/integration/projects/" + input.projectId);
            if (!projectId.test(input.projectId)) throw problem("Choose a valid project.");
            if (input.sourceContractKey !== undefined) {
                if (!ids.test(input.sourceContractKey)) throw problem("Select a valid source contract.");
                const models = await this.core.request(
                    session,
                    "GET",
                    "/api/v1/integration/projects/" + input.projectId + "/models",
                );
                if (
                    !models.items.some(
                        (model) => model.key === input.sourceContractKey && model.standard === "source-contract",
                    )
                )
                    throw problem("The source contract does not belong to this project.", 403);
            }
            const owner = this.owner(session),
                source = this.source(owner, input.projectId, input.sourceId),
                file = await this.file(source, input.file);
            const id = randomBytes(32).toString("hex"),
                directory = join(this.directory(session, "inspections"), id);
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            save(join(directory, "request.json"), {
                owner,
                projectId: input.projectId,
                subject: "",
                ...(input.sourceContractKey ? { sourceContractKey: input.sourceContractKey } : {}),
                sourceId: input.sourceId,
                file: input.file,
                sourceSha256: file.sha256,
                mode: "export",
                destinationId: null,
            });
            save(join(directory, "configuration.json"), this.configuration(owner, input.projectId));
            return await new Promise((resolve, reject) => {
                const child = this.launcher(
                    this.config.integrationWorker,
                    ["inspect", join(directory, "configuration.json"), directory],
                    {
                        env: {
                            PATH: process.env.PATH,
                            LANG: "C.UTF-8",
                            HTTP_CA_BUNDLE: process.env.HTTP_CA_BUNDLE,
                            DOTNET_EnableDiagnostics: "0",
                            DOTNET_GCHeapHardLimit: "0x10000000",
                            MODELLER_APPROVAL_KEYS: JSON.stringify(this.core.keys),
                            MODELLER_APPROVAL_KEY_ID: this.config.reviewKeyId,
                        },
                        stdio: ["ignore", "pipe", "pipe"],
                        shell: false,
                    },
                );
                this.inspectors.set(id, child);
                let output = "",
                    error = "",
                    ended = false;
                const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
                timer.unref();
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    if (output.length > 262144) child.kill("SIGKILL");
                });
                child.stderr.on("data", (chunk) => {
                    if (error.length < 256) error += chunk.toString();
                });
                const end = (code) => {
                    if (ended) return;
                    ended = true;
                    this.inspectors.delete(id);
                    clearTimeout(timer);
                    if (code !== 0)
                        return reject(
                            problem(
                                "Source inspection failed (" +
                                    (/^[A-Z0-9_]+\s*$/.test(error) ? error.trim() : "SOURCE_INSPECTION_FAILED") +
                                    ").",
                                422,
                            ),
                        );
                    try {
                        resolve({
                            ...JSON.parse(output),
                            sourceId: input.sourceId,
                            sourceSha256: file.sha256,
                            recordValues: "NOT_INCLUDED",
                        });
                    } catch {
                        reject(problem("Source inspection returned incomplete metadata.", 503));
                    }
                };
                child.once("error", () => end(1));
                child.once("exit", end);
            });
        } finally {
            this.inspectionRequests--;
        }
    }
    async previewSourceTrust(session, input) {
        fields(input, ["projectId", "subject", "sourceId", "comment"]);
        if (typeof input.comment !== "string" || !input.comment.trim() || input.comment.length > 4000)
            throw problem("Record why this source is authoritative for patient registration.");
        const owner = this.owner(session),
            mapping = await this.selection(session, input.projectId, input.subject);
        const policy = JSON.parse(mapping.executionMapping).clinicalPolicy,
            configuration = this.configuration(owner, input.projectId);
        const source = configuration.sources.find((source) => source.id === input.sourceId);
        if (!source || !policy || source.identityDomain !== policy.identityDomain)
            throw problem("Select the exact source and a confirmed mapping with its identity domain.");
        return this.ticket(owner, "source-trust", {
            projectId: input.projectId,
            sourceId: input.sourceId,
            sourceSystem: policy.identityDomain,
            destinationId: policy.destinationId,
            connectionSha256: sourceFingerprint(source),
            comment: input.comment,
        });
    }
    async commitSourceTrust(session, token) {
        const value = this.take(session, token, "source-trust");
        const source = this.configuration(this.owner(session), value.projectId).sources.find(
            (source) => source.id === value.sourceId,
        );
        if (!source) throw problem("Source access changed. Review again.", 403);
        if (sourceFingerprint(source) !== value.connectionSha256)
            throw problem("Source configuration changed. Review again.", 409);
        return this.core.request(session, "POST", "/api/v1/integration/projects/" + value.projectId + "/source-trust", {
            sourceSystem: value.sourceSystem,
            destinationId: value.destinationId,
            connectionSha256: value.connectionSha256,
            comment: value.comment,
        });
    }
    async recoveryContext(session, jobId, record) {
        if (!Number.isInteger(record) || record < 1 || record > 10000)
            throw problem("Choose a record number from the private job report.");
        const owner = this.owner(session),
            directory = this.jobDirectory(owner, jobId),
            request = json(join(directory, "request.json"));
        this.source(owner, request.projectId, request.sourceId);
        const mapping = await this.selection(session, request.projectId, request.subject);
        const policy = JSON.parse(mapping.executionMapping).clinicalPolicy;
        if (!policy) throw problem("This historical job requires a newly reviewed clinical mapping.", 409);
        const rowFile = join(directory, "row-" + String(record - 1).padStart(6, "0") + ".json");
        if (!existsSync(rowFile)) throw problem("The private record checkpoint is unavailable.", 404);
        const row = json(rowFile);
        if (!ids.test(row.pendingId || "")) throw problem("This record has no durable queue admission.", 409);
        const scope = {
            sourceSystem: policy.identityDomain,
            destinationId: policy.destinationId,
            pendingId: row.pendingId,
        };
        const target = "/api/v1/integration/projects/" + request.projectId + "/pending/";
        const pending = await this.core.request(session, "POST", target + "inspect", scope);
        if (pending.sourceSha256 !== request.sourceSha256 || pending.mappingSubject !== request.subject)
            throw problem("The original source or mapping changed.", 409);
        return { request, pending, scope, target };
    }
    async previewPatientResolution(session, input) {
        fields(input, ["jobId", "record", "patientSystem", "patientValue", "comment"]);
        if (
            ![input.patientSystem, input.patientValue, input.comment].every(
                (value) => typeof value === "string" && value.trim(),
            ) ||
            input.patientSystem.length > 2000 ||
            input.patientValue.length > 512 ||
            input.comment.length > 4000
        )
            throw problem("Provide the verified assigning authority, patient identifier and review reason.");
        const context = await this.recoveryContext(session, input.jobId, input.record);
        if (context.pending.patientIdentityPresent)
            throw problem(
                "This record already has a patient identity; reassignment requires a separate clinical correction.",
                409,
            );
        return this.ticket(this.owner(session), "patient-resolution", {
            ...input,
            expectedRevision: context.pending.revision,
            sourceSha256: context.pending.sourceSha256,
            pendingId: context.pending.id,
            projectId: context.request.projectId,
            scope: context.scope,
        });
    }
    async commitPatientResolution(session, token) {
        const value = this.take(session, token, "patient-resolution"),
            context = await this.recoveryContext(session, value.jobId, value.record);
        if (
            context.pending.id !== value.pendingId ||
            context.pending.revision !== value.expectedRevision ||
            context.pending.sourceSha256 !== value.sourceSha256
        )
            throw problem("The held record changed. Review the identity decision again.", 409);
        return this.core.request(session, "POST", context.target + "resolve-patient", {
            ...context.scope,
            expectedRevision: value.expectedRevision,
            sourceSha256: value.sourceSha256,
            patientSystem: value.patientSystem,
            patientValue: value.patientValue,
            comment: value.comment,
        });
    }
    async previewRelationshipResolution(session, input) {
        fields(input, ["jobId", "record", "role", "identifierSystem", "identifierValue", "comment"]);
        if (
            ![input.role, input.identifierSystem, input.identifierValue, input.comment].every(
                (value) => typeof value === "string" && value.trim(),
            ) ||
            input.role.length > 64 ||
            input.identifierSystem.length > 2000 ||
            input.identifierValue.length > 512 ||
            input.comment.length > 4000
        )
            throw problem("Provide the missing source role, verified identifier and review reason.");
        const context = await this.recoveryContext(session, input.jobId, input.record);
        return this.ticket(this.owner(session), "relationship-resolution", {
            ...input,
            expectedRevision: context.pending.revision,
            sourceSha256: context.pending.sourceSha256,
            pendingId: context.pending.id,
        });
    }
    async commitRelationshipResolution(session, token) {
        const value = this.take(session, token, "relationship-resolution"),
            context = await this.recoveryContext(session, value.jobId, value.record);
        if (
            context.pending.id !== value.pendingId ||
            context.pending.revision !== value.expectedRevision ||
            context.pending.sourceSha256 !== value.sourceSha256
        )
            throw problem("The held relationship changed. Review it again.", 409);
        return this.core.request(session, "POST", context.target + "resolve-relationship", {
            ...context.scope,
            expectedRevision: value.expectedRevision,
            sourceSha256: value.sourceSha256,
            role: value.role,
            identifierSystem: value.identifierSystem,
            identifierValue: value.identifierValue,
            comment: value.comment,
        });
    }
    async previewRecovery(session, input) {
        fields(input, ["jobId", "record", "action", "comment"]);
        if (
            !["confirm", "retry-missing"].includes(input.action) ||
            typeof input.comment !== "string" ||
            !input.comment.trim() ||
            input.comment.length > 4000
        )
            throw problem("Choose a recovery action and record your reason.");
        const context = await this.recoveryContext(session, input.jobId, input.record);
        const result = await this.core.request(session, "POST", context.target + "recover", {
            ...context.scope,
            expectedRevision: context.pending.revision,
            sourceSha256: context.pending.sourceSha256,
            comment: input.comment,
            action: "check",
        });
        return this.ticket(this.owner(session), "recovery", {
            ...input,
            expectedRevision: result.revision,
            sourceSha256: context.pending.sourceSha256,
            pendingId: context.pending.id,
            projectId: context.request.projectId,
            scope: context.scope,
            destinationEvidence: result,
        });
    }
    async commitRecovery(session, token) {
        const value = this.take(session, token, "recovery"),
            context = await this.recoveryContext(session, value.jobId, value.record);
        if (
            context.pending.id !== value.pendingId ||
            context.pending.revision !== value.expectedRevision ||
            context.pending.sourceSha256 !== value.sourceSha256
        )
            throw problem("Recovery evidence changed. Check the destination again.", 409);
        return this.core.request(session, "POST", context.target + "recover", {
            ...context.scope,
            expectedRevision: value.expectedRevision,
            sourceSha256: value.sourceSha256,
            comment: value.comment,
            action: value.action,
        });
    }
    async previewJob(session, input) {
        fields(input, ["projectId", "subject", "sourceId", "file", "mode", "destinationId"]);
        const owner = this.owner(session),
            mapping = await this.selection(session, input.projectId, input.subject),
            source = this.source(owner, input.projectId, input.sourceId);
        if (input.mode === "deliver" && !this.config.integrationAllowDelivery)
            throw problem("Destination delivery is disabled.", 403);
        if (
            !["export", "deliver"].includes(input.mode) ||
            (input.mode === "deliver" &&
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Choose an authorised export or clinical destination.", 403);
        if (input.mode === "deliver") {
            const target = this.connections(owner, input.projectId).destinations.find(
                (d) => d.id === input.destinationId,
            );
            if (
                (["fhir-to-openehr", "source-to-openehr"].includes(mapping.direction) ? "openehr" : "fhir") !==
                (target.standard || "fhir")
            )
                throw problem("Choose a destination matching the mapping's target standard.", 409);
        }
        const file = await this.file(source, input.file);
        return this.ticket(owner, "job", { ...input, sourceSha256: file.sha256, mappingSha256: mapping.mappingSha256 });
    }
    configuration(owner, project) {
        const connections = this.connections(owner, project);
        return {
            ...this.core.configuration,
            requireTerminology: connections.requireTerminology,
            sources: connections.sources.map((s) => ({
                id: s.id,
                root: s.root,
                format: s.format,
                identityDomain: s.identityDomain || null,
                trustPatientRegistration: !!s.trustPatientRegistration,
                projects: s.projects,
                owners: s.owners,
            })),
            destinations: connections.destinations.map((d) => ({
                id: d.id,
                baseUrl: d.baseUrl,
                tokenFile: d.tokenFile,
                projects: d.projects,
                owners: d.owners,
                resourceTypes: d.resourceTypes,
                readResourceTypes: d.readResourceTypes || null,
                standard: d.standard || "fhir",
                openEhr: d.openEhr || null,
            })),
        };
    }
    connectionFingerprint(request) {
        const configuration = this.configuration(request.owner, request.projectId);
        return hash(
            JSON.stringify({
                ...configuration,
                sources: configuration.sources.filter((source) => source.id === request.sourceId),
                destinations: configuration.destinations.filter(
                    (destination) => request.mode === "deliver" && destination.id === request.destinationId,
                ),
            }),
        );
    }
    jobDirectory(owner, id, create = false) {
        if (!ids.test(owner) || !ids.test(id)) throw problem("Job not found.", 404);
        const directory = join(this.root, owner, "jobs", id);
        if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
        else if (!existsSync(join(directory, "request.json"))) throw problem("Job not found.", 404);
        return directory;
    }
    createJob(owner, input) {
        const request = {
            owner,
            projectId: input.projectId,
            subject: input.subject,
            sourceId: input.sourceId,
            file: input.file,
            sourceSha256: input.sourceSha256,
            mode: input.mode,
            destinationId: input.destinationId || null,
            intakeId: input.id || input.subject,
            ...(input.processingMode === "fifo"
                ? { strictOrder: true, stopOnRejected: input.failurePolicy === "pause" }
                : {}),
            ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        };
        const id = hash(JSON.stringify({ ...request, file: undefined })),
            directory = this.jobDirectory(owner, id, true);
        if (!existsSync(join(directory, "request.json"))) save(join(directory, "request.json"), request);
        if (input.sourceBytes && !existsSync(join(directory, "source-snapshot.bin"))) {
            if (hash(input.sourceBytes) !== request.sourceSha256)
                throw problem("The source changed before durable receipt.", 409);
            const file = join(directory, "source-snapshot.bin");
            writeFileSync(file, input.sourceBytes, { mode: 0o600, flag: "wx" });
            const fd = openSync(file, "r");
            try {
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            const parent = openSync(directory, "r");
            try {
                fsyncSync(parent);
            } finally {
                closeSync(parent);
            }
        }
        if (input.memoryMiB) save(join(directory, "runtime.json"), { memoryMiB: input.memoryMiB });
        save(join(directory, "configuration.json"), this.configuration(owner, input.projectId));
        return { id, directory, request };
    }
    async commitJob(session, token) {
        this.checkQuota(session);
        if (this.active.size + this.inspectionRequests >= 2) throw problem("Processing workers are busy.", 429);
        const input = this.take(session, token, "job"),
            owner = this.owner(session);
        await this.selection(session, input.projectId, input.subject);
        const received = await this.file(this.source(owner, input.projectId, input.sourceId), input.file, true);
        if (received.sha256 !== input.sourceSha256)
            throw problem("The source changed. Inspect and confirm it again.", 409);
        if (
            input.mode === "deliver" &&
            (!this.config.integrationAllowDelivery ||
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Destination access changed. Review the run again.", 403);
        const job = this.createJob(owner, { ...input, sourceBytes: received.bytes });
        this.launch(job).catch(() => {});
        return { id: job.id, ...this.status(owner, job.id) };
    }
    status(owner, id) {
        const directory = this.jobDirectory(owner, id),
            stateFile = join(directory, "state.json");
        const state = existsSync(stateFile)
            ? json(stateFile)
            : { status: this.active.has(owner + ":" + id) ? "RUNNING" : "PENDING" };
        return { id, ...state, active: this.active.has(owner + ":" + id) };
    }
    jobs(session) {
        const owner = this.owner(session),
            directory = this.directory(session, "jobs");
        return {
            items: readdirSync(directory)
                .filter((name) => ids.test(name))
                .sort()
                .map((id) => this.status(owner, id)),
        };
    }
    async launch(job, force = false) {
        const owner = job.request.owner,
            key = owner + ":" + job.id;
        if (this.active.has(key)) return this.active.get(key).promise;
        if (this.active.size + this.inspectionRequests >= 2)
            throw problem("Two processing workers are active. Retry shortly.", 429);
        const state = this.status(owner, job.id);
        if (terminal.has(state.status) && !force) return state;
        const cancellation = join(job.directory, "cancel");
        if (existsSync(cancellation)) unlinkSync(cancellation);
        const env = {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HTTP_CA_BUNDLE: process.env.HTTP_CA_BUNDLE,
            DOTNET_ENVIRONMENT: "Production",
            DOTNET_EnableDiagnostics: "0",
            DOTNET_GCHeapHardLimit:
                "0x" +
                (
                    (existsSync(join(job.directory, "runtime.json"))
                        ? json(join(job.directory, "runtime.json")).memoryMiB
                        : 256) * 1048576
                ).toString(16),
            MODELLER_APPROVAL_KEYS: JSON.stringify(this.core.keys),
            MODELLER_APPROVAL_KEY_ID: this.config.reviewKeyId,
        };
        const child = this.launcher(
            this.config.integrationWorker,
            ["run", join(job.directory, "configuration.json"), job.directory],
            { env, stdio: ["ignore", "pipe", "pipe"], shell: false },
        );
        const promise = new Promise((resolve) => {
            let stdout = "",
                stderr = "",
                ended = false;
            const timer = setTimeout(() => {
                writeFileSync(cancellation, "cancel", { mode: 0o600 });
                child.kill("SIGTERM");
            }, 1800000);
            timer.unref();
            const admitted = this.connectionFingerprint(job.request);
            const grantMonitor = setInterval(() => {
                try {
                    if (
                        this.connectionFingerprint(job.request) === admitted &&
                        (job.request.mode !== "deliver" || this.config.integrationAllowDelivery)
                    )
                        return;
                } catch {
                    /* A missing grant or unreadable configuration fails closed. */
                }
                writeFileSync(cancellation, "cancel", { mode: 0o600 });
                child.kill("SIGTERM");
            }, 1000);
            grantMonitor.unref();
            child.stdout.on("data", (chunk) => {
                if (stdout.length < 65536) stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk) => {
                if (stderr.length < 256) stderr += chunk.toString();
            });
            const end = (code = 1) => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                clearInterval(grantMonitor);
                this.active.delete(key);
                if (code !== 0 || !existsSync(join(job.directory, "state.json")))
                    save(join(job.directory, "state.json"), {
                        ...(existsSync(join(job.directory, "state.json"))
                            ? json(join(job.directory, "state.json"))
                            : {}),
                        status: "BLOCKED",
                        error: /^[A-Z0-9_]+\s*$/.test(stderr) ? stderr.trim() : "PROCESSING_INTERRUPTED",
                    });
                resolve(this.status(owner, job.id));
            };
            child.once("error", () => end(1));
            child.once("exit", end);
        });
        this.active.set(key, { child, promise });
        return promise;
    }
    async resume(session, id) {
        const owner = this.owner(session),
            directory = this.jobDirectory(owner, id),
            request = json(join(directory, "request.json"));
        await this.selection(session, request.projectId, request.subject);
        this.source(owner, request.projectId, request.sourceId);
        if (
            request.mode === "deliver" &&
            (!this.config.integrationAllowDelivery ||
                !this.connections(owner, request.projectId).destinations.some((d) => d.id === request.destinationId))
        )
            throw problem("Destination access changed.", 403);
        save(join(directory, "configuration.json"), this.configuration(owner, request.projectId));
        this.launch({ id, directory, request }, true).catch(() => {});
        return this.status(owner, id);
    }
    cancel(session, id) {
        const owner = this.owner(session),
            directory = this.jobDirectory(owner, id);
        writeFileSync(join(directory, "cancel"), "cancel", { mode: 0o600 });
        this.active.get(owner + ":" + id)?.child.kill("SIGTERM");
        return this.status(owner, id);
    }
    async original(session, id) {
        this.checkQuota(session);
        if (this.active.size + this.inspectionRequests >= 2) throw problem("Private workers are busy.", 429);
        const owner = this.owner(session),
            directory = this.jobDirectory(owner, id),
            request = json(join(directory, "request.json"));
        if (this.active.has(owner + ":" + id))
            throw problem("Wait for this job to stop before downloading its received source.", 409);
        const downloadKey = owner + ":" + id;
        if (this.originalDownloads.has(downloadKey)) throw problem("This received source is already downloading.", 409);
        this.inspectionRequests++;
        this.originalDownloads.add(downloadKey);
        let complete = false;
        try {
            this.source(owner, request.projectId, request.sourceId);
            await this.core.request(session, "GET", "/api/v1/integration/projects/" + request.projectId);
            const configuration = join(directory, "configuration.original.json");
            save(configuration, this.configuration(owner, request.projectId));
            await new Promise((resolve, reject) => {
                const child = this.launcher(this.config.integrationWorker, ["original", configuration, directory], {
                    env: {
                        PATH: process.env.PATH,
                        LANG: "C.UTF-8",
                        HTTP_CA_BUNDLE: process.env.HTTP_CA_BUNDLE,
                        DOTNET_EnableDiagnostics: "0",
                        DOTNET_GCHeapHardLimit: "0x10000000",
                        MODELLER_APPROVAL_KEYS: JSON.stringify(this.core.keys),
                        MODELLER_APPROVAL_KEY_ID: this.config.reviewKeyId,
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                });
                this.inspectors.set("original:" + owner + ":" + id, child);
                const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
                timer.unref();
                let error = "",
                    ended = false;
                child.stdout.resume();
                child.stderr.on("data", (chunk) => {
                    if (error.length < 256) error += chunk.toString();
                });
                const end = (code) => {
                    if (ended) return;
                    ended = true;
                    clearTimeout(timer);
                    this.inspectors.delete("original:" + owner + ":" + id);
                    if (code === 0) resolve();
                    else
                        reject(
                            problem(
                                "Private source retrieval failed (" +
                                    (/^[A-Z0-9_]+\s*$/.test(error) ? error.trim() : "HELD_SOURCE_UNAVAILABLE") +
                                    ").",
                                422,
                            ),
                        );
                };
                child.once("exit", end);
                child.once("error", () => end(1));
            });
            const file = join(directory, "received-source.bin"),
                stat = lstatSync(file);
            if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.size > LIMIT ||
                hash(readFileSync(file)) !== request.sourceSha256
            )
                throw problem("The received source failed its integrity check.", 503);
            complete = true;
            return file;
        } finally {
            this.inspectionRequests--;
            if (!complete) this.originalDownloads.delete(downloadKey);
        }
    }
    releaseOriginal(session, id) {
        this.originalDownloads.delete(this.owner(session) + ":" + id);
    }
    report(session, id) {
        const directory = this.jobDirectory(this.owner(session), id);
        return {
            job: this.status(this.owner(session), id),
            records: readdirSync(directory)
                .filter((name) => /^row-[0-9]{6}\.json$/.test(name))
                .sort()
                .map((name) => ({ record: Number(name.slice(4, 10)) + 1, ...json(join(directory, name)) })),
        };
    }
    download(session, id, kind = "export") {
        const directory = this.jobDirectory(this.owner(session), id);
        if (!["export", "quarantine", "patient-index"].includes(kind)) throw problem("Unsupported download.");
        const file = join(
            directory,
            kind === "export"
                ? "export.ndjson"
                : kind === "patient-index"
                  ? "patient-index.ndjson"
                  : "quarantine.ndjson",
        );
        if (!existsSync(file)) throw problem("No completed export is available.", 409);
        return file;
    }
    channelDirectory(owner) {
        const directory = join(this.root, owner, "channels");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        return directory;
    }
    channelResources(channel) {
        let rss = 0,
            measured = 0;
        for (const id of channel.activeJobs || []) {
            const child = this.active.get(channel.owner + ":" + id)?.child;
            if (!Number.isInteger(child?.pid)) continue;
            try {
                const match = readFileSync("/proc/" + child.pid + "/status", "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
                if (match) {
                    rss += Number(match[1]) / 1024;
                    measured++;
                }
            } catch {
                /* Process may have finished. */
            }
        }
        return {
            activeWorkers: channel.activeJobs?.length || 0,
            measuredWorkers: measured,
            workerRssMiB: measured ? Math.round(rss * 10) / 10 : null,
            managedHeapLimitMiB: channel.memoryMiB || 256,
        };
    }
    listChannels(session) {
        const owner = this.owner(session);
        return {
            items: [...this.channels.entries()]
                .filter(([key]) => key.startsWith(owner + ":"))
                .map(([, value]) => ({
                    ...value,
                    intake: this.inbox.summary(value.owner + ":" + value.id),
                    resources: this.channelResources(value),
                })),
        };
    }
    async previewChannel(session, input) {
        fields(input, [
            "id",
            "name",
            "projectId",
            "subject",
            "sourceId",
            "mode",
            "destinationId",
            "pollSeconds",
            "failurePolicy",
            "expectedRevision",
            "processingMode",
            "maxConcurrent",
            "memoryMiB",
            "maxQueued",
            "retryLimit",
        ]);
        input = { processingMode: "ready", maxConcurrent: 1, memoryMiB: 256, maxQueued: 1000, retryLimit: 3, ...input };
        if (
            !["fifo", "ready", "concurrent"].includes(input.processingMode) ||
            !Number.isInteger(input.maxConcurrent) ||
            input.maxConcurrent < 1 ||
            input.maxConcurrent > 2 ||
            (input.processingMode !== "concurrent" && input.maxConcurrent !== 1) ||
            ![128, 192, 256].includes(input.memoryMiB) ||
            !Number.isInteger(input.maxQueued) ||
            input.maxQueued < 1 ||
            input.maxQueued > 5000 ||
            !Number.isInteger(input.retryLimit) ||
            input.retryLimit < 0 ||
            input.retryLimit > 10
        )
            throw problem("Choose bounded channel ordering, memory, queue and retry settings.");
        if (
            typeof input.name !== "string" ||
            !input.name.trim() ||
            input.name.length > 100 ||
            !Number.isInteger(input.pollSeconds) ||
            input.pollSeconds < 5 ||
            input.pollSeconds > 3600 ||
            !["pause", "quarantine-and-continue"].includes(input.failurePolicy)
        )
            throw problem("Enter a channel name, schedule and failure policy.");
        const owner = this.owner(session),
            mapping = await this.selection(session, input.projectId, input.subject);
        this.source(owner, input.projectId, input.sourceId);
        if (input.mode === "deliver" && !this.config.integrationAllowDelivery)
            throw problem("Destination delivery is disabled.", 403);
        if (
            !["export", "deliver"].includes(input.mode) ||
            (input.mode === "deliver" &&
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Choose an authorised destination.", 403);
        if (input.mode === "deliver") {
            const target = this.connections(owner, input.projectId).destinations.find(
                (d) => d.id === input.destinationId,
            );
            if (
                (["fhir-to-openehr", "source-to-openehr"].includes(mapping.direction) ? "openehr" : "fhir") !==
                (target.standard || "fhir")
            )
                throw problem("Choose a destination matching the confirmed mapping direction.", 409);
        }
        if (input.id) {
            if (!ids.test(input.id)) throw problem("Invalid channel.");
            const previous = this.channels.get(owner + ":" + input.id);
            if (
                !previous ||
                previous.revision !== input.expectedRevision ||
                ["RUNNING", "STOPPING"].includes(previous.status)
            )
                throw problem("Stop and reload the channel before changing its mapping.", 409);
        }
        return this.ticket(owner, "channel", { ...input, mappingSha256: mapping.mappingSha256 });
    }
    async commitChannel(session, token) {
        const input = this.take(session, token, "channel"),
            owner = this.owner(session);
        await this.selection(session, input.projectId, input.subject);
        this.source(owner, input.projectId, input.sourceId);
        if (
            input.mode === "deliver" &&
            (!this.config.integrationAllowDelivery ||
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Destination access changed.", 403);
        const id = input.id || randomBytes(32).toString("hex"),
            key = owner + ":" + id,
            previous = this.channels.get(key);
        if (
            previous &&
            (previous.revision !== input.expectedRevision || ["RUNNING", "STOPPING"].includes(previous.status))
        )
            throw problem("The channel changed. Review it again.", 409);
        if (!previous && this.channels.size >= 128) throw problem("The installation channel limit was reached.", 429);
        const channel = {
            ...input,
            id,
            owner,
            revision: (previous?.revision || 0) + 1,
            status: "STOPPED",
            acknowledged: previous?.acknowledged || [],
            completedFiles: previous?.completedFiles || {},
            history: [
                ...(previous?.history || []),
                {
                    revision: (previous?.revision || 0) + 1,
                    subject: input.subject,
                    mappingSha256: input.mappingSha256,
                    sourceId: input.sourceId,
                    destinationId: input.destinationId || null,
                    mode: input.mode,
                    actor: owner,
                    at: new Date(this.clock()).toISOString(),
                },
            ].slice(-256),
        };
        delete channel.expectedRevision;
        this.persist(channel);
        return channel;
    }
    persist(channel) {
        this.channels.set(channel.owner + ":" + channel.id, channel);
        save(join(this.channelDirectory(channel.owner), channel.id + ".json"), channel);
    }
    async controlChannel(session, id, action) {
        const owner = this.owner(session),
            channel = this.channels.get(owner + ":" + id);
        if (!channel) throw problem("Channel not found.", 404);
        if (action === "start") {
            if (channel.status === "RUNNING") return channel;
            if (channel.status === "STOPPING" && channel.activeJob && this.active.has(owner + ":" + channel.activeJob))
                throw problem("Wait for the active job to stop before restarting the channel.", 409);
            if (channel.mode === "deliver" && !this.config.integrationAllowDelivery)
                throw problem("Destination delivery is disabled.", 403);
            await this.selection(session, channel.projectId, channel.subject);
            this.source(owner, channel.projectId, channel.sourceId);
            this.migrateInbox(channel);
            for (const entry of this.inbox.entries(owner + ":" + id, "BLOCKED")) {
                const state = this.status(owner, entry.job);
                if (state.status === "COMPLETED") this.inbox.finish(owner + ":" + id, entry.digest, "COMPLETED");
                else if (
                    state.status === "COMPLETED_WITH_FAILURES" &&
                    channel.failurePolicy === "quarantine-and-continue"
                )
                    this.inbox.finish(owner + ":" + id, entry.digest, "QUARANTINED");
                else throw problem("Resume or reconcile the blocked job before restarting its channel.", 409);
            }
            this.inbox.recover(owner + ":" + id);
            channel.activeJobs = [];
            channel.vendorExtracting = false;
            channel.status = "RUNNING";
            channel.error = null;
            channel.nextPoll = 0;
        } else if (action === "pause") {
            channel.status = channel.activeJobs?.length || channel.activeJob ? "STOPPING" : "STOPPED";
            for (const job of new Set([...(channel.activeJobs || []), channel.activeJob].filter(Boolean)))
                this.cancel(session, job);
        } else throw problem("Unsupported channel action.");
        this.persist(channel);
        return channel;
    }
    resumeHeld(channel) {
        if (!channel.waitingJobs?.length || channel.nextHeldRetry > this.clock()) return false;
        const id = channel.waitingJobs.shift();
        channel.nextHeldRetry = this.clock() + Math.max(5, channel.pollSeconds) * 1000;
        const directory = this.jobDirectory(channel.owner, id),
            request = json(join(directory, "request.json"));
        if (
            request.subject !== channel.subject ||
            request.sourceId !== channel.sourceId ||
            request.destinationId !== (channel.destinationId || null)
        )
            throw problem("Held work must retain its reviewed channel assignment.", 409);
        save(join(directory, "configuration.json"), this.configuration(channel.owner, channel.projectId));
        channel.activeJob = id;
        this.persist(channel);
        this.launch({ id, directory, request }, true)
            .then((state) => {
                channel.activeJob = null;
                if (state.status === "WAITING_DEPENDENCIES") channel.waitingJobs.push(id);
                else if (!terminal.has(state.status)) {
                    channel.status = "PAUSED";
                    channel.error = state.error || state.status;
                    channel.waitingJobs.push(id);
                }
                if (channel.status === "STOPPING") channel.status = "STOPPED";
                this.persist(channel);
            })
            .catch(() => {
                channel.activeJob = null;
                channel.waitingJobs.push(id);
                channel.status = "PAUSED";
                channel.error = "WORKER_UNAVAILABLE";
                this.persist(channel);
            });
        return true;
    }
    migrateInbox(channel) {
        const scope = channel.owner + ":" + channel.id;
        channel.processingMode ||= "ready";
        channel.maxConcurrent ||= 1;
        channel.memoryMiB ||= 256;
        channel.maxQueued ||= 1000;
        channel.retryLimit ??= 3;
        for (const digest of channel.acknowledged || []) {
            if (!this.inbox.find(scope, digest)) {
                this.inbox.enqueue(scope, digest, "legacy", this.clock());
                this.inbox.finish(scope, digest, "COMPLETED");
            }
        }
        for (const id of [...(channel.waitingJobs || []), channel.interruptedJob].filter(Boolean)) {
            const directory = this.jobDirectory(channel.owner, id),
                request = json(join(directory, "request.json"));
            const digest = request.sourceEventId || request.sourceSha256;
            if (!this.inbox.find(scope, digest)) {
                this.inbox.enqueue(scope, digest, id, this.clock());
                this.inbox.finish(scope, digest, "HELD");
            }
        }
        channel.waitingJobs = [];
        channel.interruptedJob = null;
    }
    dispatch(channel) {
        const maximum = channel.processingMode === "concurrent" ? channel.maxConcurrent : 1;
        const scope = channel.owner + ":" + channel.id;
        channel.activeJobs ||= [];
        while (
            channel.status === "RUNNING" &&
            channel.activeJobs.length < maximum &&
            this.active.size + this.inspectionRequests < 2
        ) {
            const item = this.inbox.claim(
                scope,
                channel.processingMode === "fifo" ? "fifo" : channel.preferHeld ? "held-first" : "ready",
                this.clock(),
            );
            if (!item) break;
            channel.preferHeld = item.previousState !== "HELD";
            const directory = this.jobDirectory(channel.owner, item.job),
                request = json(join(directory, "request.json"));
            if (
                request.subject !== channel.subject ||
                request.sourceId !== channel.sourceId ||
                request.destinationId !== (channel.destinationId || null)
            ) {
                this.inbox.finish(scope, item.digest, "BLOCKED", "ASSIGNMENT_CHANGED");
                channel.status = "PAUSED";
                channel.error = "ASSIGNMENT_CHANGED";
                this.persist(channel);
                break;
            }
            save(join(directory, "configuration.json"), this.configuration(channel.owner, channel.projectId));
            channel.waitingJobs = (channel.waitingJobs || []).filter((id) => id !== item.job);
            channel.activeJobs.push(item.job);
            channel.activeJob = channel.activeJobs[0];
            this.persist(channel);
            this.launch({ id: item.job, directory, request })
                .then((state) => {
                    channel.activeJobs = channel.activeJobs.filter((id) => id !== item.job);
                    channel.activeJob = channel.activeJobs[0] || null;
                    let status = "BLOCKED",
                        due = 0;
                    if (state.status === "COMPLETED") status = "COMPLETED";
                    else if (
                        state.status === "COMPLETED_WITH_FAILURES" &&
                        channel.failurePolicy === "quarantine-and-continue"
                    )
                        status = "QUARANTINED";
                    else if (state.status === "WAITING_DEPENDENCIES") {
                        status = "HELD";
                        due = this.clock() + channel.pollSeconds * 1000;
                        channel.waitingJobs ||= [];
                        if (!channel.waitingJobs.includes(item.job)) channel.waitingJobs.push(item.job);
                    } else if (
                        ["WORKER_UNAVAILABLE", "PROCESSING_INTERRUPTED", "ENGINE_COMPUTE_UNAVAILABLE"].includes(
                            state.error,
                        ) &&
                        item.attempts <= channel.retryLimit
                    ) {
                        status = "RETRY";
                        due = this.clock() + Math.min(300000, 1000 * 2 ** item.attempts);
                    } else if (channel.status === "STOPPING") status = "INTERRUPTED";
                    this.inbox.finish(scope, item.digest, status, state.error || null, due);
                    if (status === "BLOCKED") {
                        channel.status = "PAUSED";
                        channel.error = state.error || state.status;
                    }
                    if (channel.status === "STOPPING" && !channel.activeJobs.length) channel.status = "STOPPED";
                    this.persist(channel);
                })
                .catch(() => {
                    channel.activeJobs = channel.activeJobs.filter((id) => id !== item.job);
                    channel.activeJob = channel.activeJobs[0] || null;
                    this.inbox.finish(scope, item.digest, "BLOCKED", "WORKER_UNAVAILABLE");
                    channel.status = "PAUSED";
                    channel.error = "WORKER_UNAVAILABLE";
                    this.persist(channel);
                });
        }
    }
    async tick() {
        if (this.ticking || !this.core.ready) return;
        this.ticking = true;
        try {
            for (const channel of this.channels.values()) {
                if (channel.status !== "RUNNING") continue;
                if (channel.mode === "deliver" && !this.config.integrationAllowDelivery) {
                    channel.status = "PAUSED";
                    channel.error = "DELIVERY_DISABLED";
                    this.persist(channel);
                    continue;
                }
                try {
                    const source = this.source(channel.owner, channel.projectId, channel.sourceId);
                    this.dispatch(channel);
                    if (channel.nextPoll > this.clock()) continue;
                    channel.nextPoll = this.clock() + channel.pollSeconds * 1000;
                    const scope = channel.owner + ":" + channel.id,
                        summary = this.inbox.summary(scope);
                    const queued = Object.entries(summary.counts)
                        .filter(([state]) => !["COMPLETED", "QUARANTINED"].includes(state))
                        .reduce((sum, [, count]) => sum + count, 0);
                    if (queued >= channel.maxQueued) {
                        channel.backpressure = "QUEUE_CAPACITY";
                        this.persist(channel);
                        continue;
                    }
                    channel.backpressure = null;
                    if ((source.kafka || (source.vendor && source.incremental)) && !channel.vendorSnapshotReady) {
                        const adapter = source.kafka ? this.kafka : this.vendor;
                        if (!channel.vendorExtracting && adapter.active.size < 2) {
                            channel.vendorExtracting = true;
                            adapter
                                .materialise(channel.owner, channel.projectId, channel.sourceId)
                                .then(() => {
                                    channel.vendorExtracting = false;
                                    channel.vendorSnapshotReady = true;
                                    channel.nextPoll = 0;
                                    this.persist(channel);
                                })
                                .catch(() => {
                                    channel.vendorExtracting = false;
                                    channel.status = "PAUSED";
                                    channel.error = "SOURCE_CAPTURE_UNAVAILABLE";
                                    this.persist(channel);
                                });
                        }
                        continue;
                    }
                    channel.vendorSnapshotReady = false;
                    const names = readdirSync(source.root)
                        .filter((name) => this.matches(source, name))
                        .map((name) => ({ name, stat: lstatSync(join(source.root, name)) }))
                        .filter(({ stat }) => stat.isFile() && !stat.isSymbolicLink() && stat.size <= LIMIT)
                        .sort(
                            (a, b) =>
                                (source.ordered ? 0 : a.stat.mtimeMs - b.stat.mtimeMs) ||
                                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
                        );
                    if (names.length > 10000) throw problem("Source discovery limit reached.");
                    const present = new Set(names.map((item) => item.name));
                    for (const name of Object.keys(channel.completedFiles || {}))
                        if (!present.has(name)) {
                            delete channel.completedFiles[name];
                            this.stable.delete(scope + ":" + name);
                        }
                    let admitted = 0;
                    for (const { name, stat } of names) {
                        if (admitted >= Math.min(16, channel.maxQueued - queued)) break;
                        const signature = stat.size + ":" + stat.mtimeMs + ":" + stat.ctimeMs + ":" + stat.ino,
                            stableKey = scope + ":" + name;
                        if (channel.completedFiles?.[name] === signature) continue;
                        if (!source.vendor && !source.kafka && this.stable.get(stableKey) !== signature) {
                            this.stable.set(stableKey, signature);
                            continue;
                        }
                        const file = await this.file(source, name, true);
                        const sourceEventId = source.kafka ? /^event-[0-9]+-([a-f0-9]{64})\./.exec(name)?.[1] : null;
                        if (source.kafka && !sourceEventId) throw problem("Kafka input identity is invalid.", 409);
                        const intakeId = sourceEventId || file.sha256;
                        if (!this.inbox.find(scope, intakeId)) {
                            if (this.checkOwnerQuota(channel.owner) + file.bytes.length > 512 * 1048576)
                                throw problem("Private intake storage is full.", 413);
                            const job = this.createJob(channel.owner, {
                                ...channel,
                                file: name,
                                sourceSha256: file.sha256,
                                sourceBytes: file.bytes,
                                ...(sourceEventId ? { sourceEventId } : {}),
                            });
                            this.inbox.enqueue(scope, intakeId, job.id, this.clock());
                            admitted++;
                        }
                        channel.completedFiles ||= {};
                        channel.completedFiles[name] = signature;
                        this.persist(channel);
                    }
                    this.dispatch(channel);
                } catch {
                    channel.status = "PAUSED";
                    channel.error = "SOURCE_OR_CONNECTION_UNAVAILABLE";
                    this.persist(channel);
                }
            }
        } finally {
            this.ticking = false;
        }
    }
    close() {
        clearInterval(this.timer);
        for (const child of this.inspectors.values()) child.kill("SIGTERM");
        const pending = [...this.active.values()].map((active) => active.promise);
        for (const active of this.active.values()) active.child.kill("SIGTERM");
        if (!pending.length) {
            if (!this.inboxClosed) {
                this.inbox.close();
                this.inboxClosed = true;
            }
        } else
            return Promise.allSettled(pending).then(() => {
                if (!this.inboxClosed) {
                    this.inbox.close();
                    this.inboxClosed = true;
                }
            });
    }
}
