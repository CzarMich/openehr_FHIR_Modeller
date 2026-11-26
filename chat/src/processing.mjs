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
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { problem } from "./personal-http.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
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
    renameSync(temp, file);
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
        this.root = join(config.dataDir, "processing");
        this.active = new Map();
        this.pending = new Map();
        this.channels = new Map();
        this.stable = new Map();
        this.ticking = false;
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
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
                if (channel.status === "RUNNING" || channel.status === "STOPPING") {
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
                    projects: [item.projectId],
                    owners: [owner],
                    displayName: item.displayName,
                    uploaded: true,
                });
            }
        return { sources, destinations, requireTerminology: configured.requireTerminology !== false };
    }
    checkQuota(session) {
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
        const root = join(this.root, this.owner(session));
        if (existsSync(root)) walk(root);
    }
    async upload(session, input, bytes) {
        this.checkQuota(session);
        fields(input, ["projectId", "format", "name"]);
        if (
            !projectId.test(input.projectId) ||
            !["csv", "json", "fhir-json", "xml", "xlsx"].includes(input.format) ||
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
            id = hash(input.projectId + "\n" + input.format + "\n" + digest);
        const directory = join(this.directory(session, "sources"), id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!existsSync(join(directory, "source.bin")))
            writeFileSync(join(directory, "source.bin"), bytes, { mode: 0o600, flag: "wx" });
        save(join(directory, "source.json"), {
            projectId: input.projectId,
            format: input.format,
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
            })),
            destinations: result.destinations.map((d) => ({
                id: d.id,
                displayName: d.displayName || d.id,
                resourceTypes: d.resourceTypes,
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
            : name.toLowerCase().endsWith("." + ({ "fhir-json": "json" }[source.format] || source.format));
    }
    async file(source, name) {
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
                buffer = Buffer.alloc(16384);
            let length = 0;
            for (;;) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                length += bytesRead;
                if (length > LIMIT) throw problem("The source file changed or exceeds its limit.");
                digest.update(buffer.subarray(0, bytesRead));
            }
            return { name, sha256: digest.digest("hex"), size: length };
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
        fields(input, ["projectId", "sourceId", "file"]);
        if (this.active.size + this.inspectors.size >= 2) throw problem("Processing workers are busy.", 429);
        await this.core.request(session, "GET", "/api/v1/integration/projects/" + input.projectId);
        if (!projectId.test(input.projectId)) throw problem("Choose a valid project.");
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
            sourceId: input.sourceId,
            file: input.file,
            sourceSha256: file.sha256,
            mode: "export",
            destinationId: null,
        });
        save(join(directory, "configuration.json"), this.configuration(owner, input.projectId));
        return new Promise((resolve, reject) => {
            const child = this.launcher(
                this.config.integrationWorker,
                ["inspect", join(directory, "configuration.json"), directory],
                {
                    env: {
                        PATH: process.env.PATH,
                        LANG: "C.UTF-8",
                        DOTNET_EnableDiagnostics: "0",
                        DOTNET_GCHeapHardLimit: "0x20000000",
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
    }
    async previewJob(session, input) {
        fields(input, ["projectId", "subject", "sourceId", "file", "mode", "destinationId"]);
        const owner = this.owner(session),
            mapping = await this.selection(session, input.projectId, input.subject),
            source = this.source(owner, input.projectId, input.sourceId);
        if (input.mode === "deliver" && !this.config.integrationAllowDelivery)
            throw problem("FHIR destination delivery is disabled.", 403);
        if (
            !["export", "deliver"].includes(input.mode) ||
            (input.mode === "deliver" &&
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Choose an authorised export or FHIR destination.", 403);
        if (input.mode === "deliver" && mapping.direction === "fhir-to-openehr")
            throw problem("Reverse mappings export openEHR; select a FHIR-producing mapping for delivery.");
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
            })),
        };
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
        };
        const id = hash(JSON.stringify({ ...request, file: undefined })),
            directory = this.jobDirectory(owner, id, true);
        if (!existsSync(join(directory, "request.json"))) save(join(directory, "request.json"), request);
        save(join(directory, "configuration.json"), this.configuration(owner, input.projectId));
        return { id, directory, request };
    }
    async commitJob(session, token) {
        this.checkQuota(session);
        if (this.active.size + this.inspectors.size >= 2) throw problem("Processing workers are busy.", 429);
        const input = this.take(session, token, "job"),
            owner = this.owner(session);
        await this.selection(session, input.projectId, input.subject);
        if (
            (await this.file(this.source(owner, input.projectId, input.sourceId), input.file)).sha256 !==
            input.sourceSha256
        )
            throw problem("The source changed. Inspect and confirm it again.", 409);
        if (
            input.mode === "deliver" &&
            (!this.config.integrationAllowDelivery ||
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Destination access changed. Review the run again.", 403);
        const job = this.createJob(owner, input);
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
        if (this.active.size + this.inspectors.size >= 2)
            throw problem("Two processing workers are active. Retry shortly.", 429);
        const state = this.status(owner, job.id);
        if (terminal.has(state.status) && !force) return state;
        const cancellation = join(job.directory, "cancel");
        if (existsSync(cancellation)) unlinkSync(cancellation);
        const env = {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            DOTNET_ENVIRONMENT: "Production",
            DOTNET_EnableDiagnostics: "0",
            DOTNET_GCHeapHardLimit: "0x20000000",
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
            const admitted = JSON.stringify(this.configuration(owner, job.request.projectId));
            const grantMonitor = setInterval(() => {
                try {
                    if (
                        JSON.stringify(this.configuration(owner, job.request.projectId)) === admitted &&
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
        if (!["export", "quarantine"].includes(kind)) throw problem("Unsupported download.");
        const file = join(directory, kind === "export" ? "export.ndjson" : "quarantine.ndjson");
        if (!existsSync(file)) throw problem("No completed export is available.", 409);
        return file;
    }
    channelDirectory(owner) {
        const directory = join(this.root, owner, "channels");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        return directory;
    }
    listChannels(session) {
        const owner = this.owner(session);
        return {
            items: [...this.channels.entries()]
                .filter(([key]) => key.startsWith(owner + ":"))
                .map(([, value]) => value),
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
        ]);
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
            throw problem("FHIR destination delivery is disabled.", 403);
        if (
            !["export", "deliver"].includes(input.mode) ||
            (input.mode === "deliver" &&
                !this.connections(owner, input.projectId).destinations.some((d) => d.id === input.destinationId))
        )
            throw problem("Choose an authorised destination.", 403);
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
            if (channel.mode === "deliver" && !this.config.integrationAllowDelivery)
                throw problem("FHIR destination delivery is disabled.", 403);
            await this.selection(session, channel.projectId, channel.subject);
            this.source(owner, channel.projectId, channel.sourceId);
            channel.status = "RUNNING";
            channel.error = null;
            channel.nextPoll = 0;
        } else if (action === "pause") {
            channel.status = channel.activeJob ? "STOPPING" : "STOPPED";
            if (channel.activeJob) this.cancel(session, channel.activeJob);
        } else throw problem("Unsupported channel action.");
        this.persist(channel);
        return channel;
    }
    async tick() {
        if (this.ticking || !this.core.ready) return;
        this.ticking = true;
        try {
            for (const channel of this.channels.values()) {
                if (channel.mode === "deliver" && !this.config.integrationAllowDelivery) {
                    channel.status = "PAUSED";
                    channel.error = "DELIVERY_DISABLED";
                    this.persist(channel);
                }
                if (
                    channel.status !== "RUNNING" ||
                    channel.activeJob ||
                    channel.nextPoll > this.clock() ||
                    this.active.size + this.inspectors.size >= 2
                )
                    continue;
                channel.nextPoll = this.clock() + channel.pollSeconds * 1000;
                try {
                    const source = this.source(channel.owner, channel.projectId, channel.sourceId),
                        names = readdirSync(source.root)
                            .filter((name) => this.matches(source, name))
                            .sort();
                    if (names.length > 10000) throw problem("Source discovery limit reached.");
                    for (const name of names) {
                        const stat = lstatSync(join(source.root, name));
                        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMIT) continue;
                        const stableKey = channel.owner + ":" + channel.id + ":" + name,
                            signature = stat.size + ":" + stat.mtimeMs + ":" + stat.ctimeMs + ":" + stat.ino;
                        if (channel.completedFiles?.[name] === signature) continue;
                        if (this.stable.get(stableKey) !== signature) {
                            this.stable.set(stableKey, signature);
                            continue;
                        }
                        const file = await this.file(source, name);
                        if (channel.acknowledged.includes(file.sha256)) {
                            channel.completedFiles ||= {};
                            channel.completedFiles[name] = signature;
                            this.persist(channel);
                            continue;
                        }
                        const job = this.createJob(channel.owner, {
                            ...channel,
                            file: name,
                            sourceSha256: file.sha256,
                        });
                        channel.activeJob = job.id;
                        this.persist(channel);
                        this.launch(job)
                            .then((state) => {
                                channel.activeJob = null;
                                if (
                                    state.status === "COMPLETED" ||
                                    (state.status === "COMPLETED_WITH_FAILURES" &&
                                        channel.failurePolicy === "quarantine-and-continue")
                                ) {
                                    channel.completedFiles ||= {};
                                    channel.completedFiles[name] = signature;
                                    channel.acknowledged.push(file.sha256);
                                    if (channel.acknowledged.length > 10000) {
                                        channel.status = "PAUSED";
                                        channel.error = "CHECKPOINT_RETENTION_LIMIT";
                                    }
                                } else if (channel.status !== "STOPPING") {
                                    channel.status = "PAUSED";
                                    channel.error = state.error || state.status;
                                }
                                if (channel.status === "STOPPING") channel.status = "STOPPED";
                                this.persist(channel);
                            })
                            .catch(() => {
                                channel.activeJob = null;
                                channel.status = "PAUSED";
                                channel.error = "WORKER_UNAVAILABLE";
                                this.persist(channel);
                            });
                        break;
                    }
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
        for (const active of this.active.values()) active.child.kill("SIGTERM");
    }
}
