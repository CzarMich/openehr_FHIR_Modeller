import { spawn } from "node:child_process";
import { createHash, randomBytes, hkdfSync } from "node:crypto";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
    renameSync,
    rmSync,
    existsSync,
    openSync,
    closeSync,
    fsyncSync,
    readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { ProviderStore } from "./provider-store.mjs";
import { problem } from "./personal-http.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const idPattern = /^[a-f0-9]{64}$/;
export const vendorConnectors = [
    ["sqlserver", "Microsoft SQL Server"],
    ["oracle", "Oracle Database"],
    ["postgresql", "PostgreSQL"],
    ["mysql", "MySQL"],
    ["mariadb", "MariaDB"],
    ["sap-hana", "SAP HANA"],
    ["epic-clarity-sqlserver", "Epic Clarity (SQL Server)"],
    ["epic-clarity-oracle", "Epic Clarity (Oracle)"],
    ["epic-fhir", "Epic FHIR API"],
    ["fhir-api", "FHIR API"],
    ["sap-bw", "SAP BW OData"],
    ["clinical-rest-api", "Clinical REST API"],
].map(([id, label]) => ({ id, label, readOnly: true }));
export class VendorSources {
    constructor(config, core, processing, { launcher = spawn, store, runtimeFingerprint } = {}) {
        this.config = config;
        this.core = core;
        this.processing = processing;
        this.launcher = launcher;
        this.runtimeFingerprint =
            runtimeFingerprint ||
            (() =>
                hash(
                    [
                        "Modeller.Extraction.dll",
                        "Modeller.Database.dll",
                        "Modeller.Core.dll",
                        "Modeller.Extraction.deps.json",
                    ]
                        .map((name) => hash(readFileSync(join(dirname(this.config.integrationExtractor), name))))
                        .join("\n"),
                ));
        this.active = new Map();
        this.root = join(config.dataDir, "vendor-adapters");
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        for (const name of readdirSync(this.root).filter((name) => /^request-[A-Za-z0-9]{6}$/.test(name)))
            rmSync(join(this.root, name), { recursive: true, force: true });
        this.store = store || null;
    }
    vault() {
        if (this.store) return this.store;
        const path = this.core.configuration?.operationalKeyFile;
        if (!path || !existsSync(path)) return null;
        const key = readFileSync(path);
        if (key.length !== 32) throw problem("The source encryption key is invalid.", 503);
        const derived = Buffer.from(
            hkdfSync("sha256", key, Buffer.from("modeller-source-vault/v1"), Buffer.from("owner-bound-profiles"), 32),
        );
        this.store = new ProviderStore(join(this.root, "profiles"), derived.toString("hex"), ["sources"]);
        return this.store;
    }

    all(owner) {
        if (!this.vault())
            throw problem("Source credential encryption is unavailable. Start the integration service.", 503);
        return this.store.get(owner, "sources")?.credential || [];
    }
    save(owner, items) {
        this.store.set(owner, "sources", items);
    }
    reviewProfile(profile) {
        const visible = { ...profile };
        delete visible.password;
        if (visible.authentication) {
            visible.authentication = { ...visible.authentication };
            for (const key of ["token", "password", "clientSecret", "privateKeyPem"])
                delete visible.authentication[key];
        }
        return visible;
    }
    visible(item) {
        return {
            id: item.id,
            sourceId: item.sourceId,
            revision: item.revision,
            projectId: item.projectId,
            displayName: item.displayName,
            connector: item.profile.connector,
            identityDomain: item.identityDomain,
            enabled: item.enabled,
            planConfirmed: !!item.planSha256,
            allowAgentMetadata: item.allowAgentMetadata === true,
            captureMode: item.cursor ? "append-only" : "bounded-snapshot",
            configurationSha256: item.configurationSha256,
            lastDiscovery: item.lastDiscovery || null,
            readOnly: true,
            technicalConnectionVerified: !!item.lastDiscovery,
            installationQualified: false,
        };
    }
    get(owner, id, project) {
        if (!idPattern.test(id || "")) throw problem("Choose a source connection.");
        const item = this.all(owner).find((item) => item.id === id && (!project || item.projectId === project));
        if (!item) throw problem("Source connection not found.", 404);
        return item;
    }
    async authorise(session, projectId, action) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(projectId || "")) throw problem("Choose a project.");
        return this.core.request(session, "POST", "/api/v1/integration/projects/" + projectId + "/source-access", {
            action,
        });
    }
    async list(session, projectId) {
        await this.authorise(session, projectId, "inspect");
        return {
            connectors: vendorConnectors,
            items: this.all(this.processing.owner(session))
                .filter((item) => item.projectId === projectId)
                .map((item) => this.visible(item)),
            clinicalDatabasePolicy: "READ ONLY",
            credentialsReturned: false,
        };
    }
    async command(operation, request, stillCurrent) {
        if (this.active.size >= 2) throw problem("Source adapters are busy.", 429);
        const key = randomBytes(16).toString("hex");
        this.active.set(key, null);
        const directory = mkdtempSync(join(this.root, "request-"));
        const input = join(directory, "request.json"),
            output = join(directory, "output");
        writeFileSync(
            input,
            JSON.stringify({ ...request, originalKeyFile: this.core.configuration?.operationalKeyFile }),
            { mode: 0o600, flag: "wx" },
        );
        try {
            await new Promise((resolve, reject) => {
                const child = this.launcher(this.config.integrationExtractor, [operation, input, output], {
                    env: {
                        PATH: process.env.PATH,
                        LANG: "C.UTF-8",
                        HTTP_CA_BUNDLE: process.env.HTTP_CA_BUNDLE,
                        MODELLER_HANA_ODBC_DRIVER: process.env.MODELLER_HANA_ODBC_DRIVER,
                        MODELLER_ORACLE_TNS_ADMIN: process.env.MODELLER_ORACLE_TNS_ADMIN,
                        DOTNET_ENVIRONMENT: "Production",
                        DOTNET_EnableDiagnostics: "0",
                        DOTNET_GCHeapHardLimit: "0x20000000",
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                });
                this.active.set(key, child);
                let error = "",
                    ended = false,
                    force;
                let stopping = false;
                const stop = () => {
                    if (stopping) return;
                    stopping = true;
                    child.kill("SIGTERM");
                    force = setTimeout(() => child.kill("SIGKILL"), 5000);
                    force.unref();
                };
                const timer = setTimeout(stop, 610000);
                timer.unref();
                const monitor = setInterval(() => {
                    try {
                        if (stillCurrent && !stillCurrent()) stop();
                    } catch {
                        stop();
                    }
                }, 1000);
                monitor.unref();
                child.stdout.resume();
                child.stderr.on("data", (chunk) => {
                    if (error.length < 256) error += chunk.toString();
                });
                const end = (code) => {
                    if (ended) return;
                    ended = true;
                    clearTimeout(timer);
                    clearInterval(monitor);
                    clearTimeout(force);
                    if (code === 0) resolve();
                    else
                        reject(
                            problem(
                                "Source adapter: " +
                                    (/^[A-Z0-9_]+\s*$/.test(error) ? error.trim() : "SOURCE_ADAPTER_UNAVAILABLE"),
                                422,
                            ),
                        );
                };
                child.once("exit", end);
                child.once("error", () => end(1));
            });
            const result = JSON.parse(readFileSync(join(output, "result.json"), "utf8"));
            return { result, directory, output };
        } catch (error) {
            rmSync(directory, { recursive: true, force: true });
            throw error;
        } finally {
            this.active.delete(key);
            if (existsSync(input)) rmSync(input);
        }
    }
    async previewProfile(session, input) {
        await this.authorise(session, input.projectId, "configure");
        if (
            !vendorConnectors.some((c) => c.id === input.profile?.connector) ||
            typeof input.displayName !== "string" ||
            !input.displayName.trim() ||
            input.displayName.length > 128 ||
            typeof input.identityDomain !== "string" ||
            !input.identityDomain.trim() ||
            input.identityDomain.length > 256
        )
            throw problem("Provide the connector, source name and stable identity domain.");
        const owner = this.processing.owner(session),
            profile = { ...input.profile, tenant: owner, projects: [input.projectId] };
        if (JSON.stringify(profile).length > 65536) throw problem("Source profile is too large.");
        const check = await this.command("validate", { profile });
        rmSync(check.directory, { recursive: true, force: true });
        const value = {
            projectId: input.projectId,
            displayName: input.displayName.trim(),
            identityDomain: input.identityDomain.trim(),
            identityIssuer: session.reviewIdentity?.issuer,
            allowAgentMetadata: input.allowAgentMetadata === true,
            profile,
        };
        const ticket = this.processing.ticket(owner, "vendor-profile", value);
        ticket.summary = {
            projectId: value.projectId,
            displayName: value.displayName,
            connector: profile.connector,
            identityDomain: value.identityDomain,
            allowAgentMetadata: value.allowAgentMetadata,
            configurationSha256: hash(JSON.stringify(profile)),
            readOnly: true,
            connection: this.reviewProfile(profile),
            credentials: "ENCRYPTED_NOT_RETURNED",
        };
        return ticket;
    }
    async commitProfile(session, token) {
        const value = this.processing.take(session, token, "vendor-profile");
        await this.authorise(session, value.projectId, "configure");
        const owner = this.processing.owner(session),
            items = this.all(owner);
        if (items.length >= 128) throw problem("Source connection limit reached.");
        const item = {
            ...value,
            id: randomBytes(32).toString("hex"),
            revision: 1,
            enabled: true,
            configurationSha256: hash(JSON.stringify(value.profile)),
            createdAt: new Date().toISOString(),
        };
        items.push(item);
        this.save(owner, items);
        return this.visible(item);
    }
    async discover(session, input) {
        await this.authorise(session, input.projectId, "discover");
        return this.discoverMetadata(this.processing.owner(session), input);
    }
    async discoverMetadata(owner, input) {
        const item = this.get(owner, input.id, input.projectId);
        if (!item.enabled) throw problem("Source connection is disabled.", 409);
        const check = await this.command("discover", { profile: item.profile });
        try {
            const metadata = check.result;
            const query = typeof input.query === "string" ? input.query.toLowerCase() : "",
                after = Number.isInteger(input.afterTableId) ? input.afterTableId : 0;
            const tablePage = metadata.tables
                ?.filter(
                    (table) =>
                        (Number.isInteger(input.tableId) ? table.id === input.tableId : table.id > after) &&
                        (!query ||
                            table.name.toLowerCase().includes(query) ||
                            table.schema.toLowerCase().includes(query) ||
                            table.columns.some((column) => column.name.toLowerCase().includes(query))),
                )
                .slice(0, 25);
            const items = this.all(owner),
                current = items.find((x) => x.id === item.id);
            if (current.configurationSha256 !== item.configurationSha256 || !current.enabled)
                throw problem("Source configuration changed.", 409);
            current.lastDiscovery = {
                at: new Date().toISOString(),
                fingerprint:
                    metadata.schemaFingerprint ||
                    metadata.capabilitySha256 ||
                    metadata.metadataSha256 ||
                    hash(JSON.stringify(metadata)),
                tableCount: metadata.tables?.length || 0,
            };
            this.save(owner, items);
            return {
                connection: this.visible(current),
                metadata: tablePage
                    ? {
                          ...metadata,
                          declaredKeyCount: metadata.keys?.length || 0,
                          keys: Number.isInteger(input.tableId)
                              ? (metadata.keys || [])
                                    .filter((key) => key.fromTable === input.tableId || key.toTable === input.tableId)
                                    .slice(0, 100)
                              : [],
                          tables: tablePage.map((table) => {
                              if (!Number.isInteger(input.tableId))
                                  return {
                                      id: table.id,
                                      schema: table.schema,
                                      name: table.name,
                                      columnCount: table.columns.length,
                                      hasPrimaryKey: table.columns.some((column) => column.keyOrdinal > 0),
                                  };
                              const columns = table.columns
                                  .filter(
                                      (column) =>
                                          column.id > (Number.isInteger(input.afterColumnId) ? input.afterColumnId : 0),
                                  )
                                  .slice(0, 100);
                              return {
                                  ...table,
                                  columns,
                                  columnCount: table.columns.length,
                                  nextAfterColumnId: columns.length === 100 ? columns.at(-1).id : null,
                              };
                          }),
                          nextAfterTableId: tablePage.length === 25 ? tablePage.at(-1).id : null,
                          columnPageLimit: 100,
                      }
                    : metadata,
                patientRowsIncluded: false,
            };
        } finally {
            rmSync(check.directory, { recursive: true, force: true });
        }
    }
    async agentMetadata(session, input) {
        if (!["list", "discover"].includes(input.action) || typeof input.projectId !== "string")
            throw problem("Choose a metadata action and project.");
        await this.core.request(session, "GET", "/api/v1/integration/projects/" + input.projectId);
        const owner = this.processing.owner(session);
        if (input.action === "list")
            return {
                items: this.all(owner)
                    .filter(
                        (item) =>
                            item.enabled &&
                            item.projectId === input.projectId &&
                            item.allowAgentMetadata &&
                            (!this.canOperateOwner || this.canOperateOwner(owner, item.identityIssuer)),
                    )
                    .map((item) => ({ id: item.id, name: item.displayName, connector: item.profile.connector })),
                metadataOnly: true,
                patientRowsIncluded: false,
            };
        const item = this.get(owner, input.sourceId, input.projectId);
        if (
            !item.enabled ||
            !item.allowAgentMetadata ||
            (this.canOperateOwner && !this.canOperateOwner(owner, item.identityIssuer))
        )
            throw problem("This source has not been shared for agent metadata discovery.", 403);
        const result = await this.discoverMetadata(owner, { ...input, id: item.id });
        if (!this.get(owner, item.id, input.projectId).allowAgentMetadata)
            throw problem("Metadata sharing was revoked.", 403);
        return {
            sourceId: item.id,
            connector: item.profile.connector,
            metadata: result.metadata,
            metadataOnly: true,
            patientRowsIncluded: false,
            clinicalMeaning: "UNRESOLVED",
        };
    }
    async previewPlan(session, input) {
        await this.authorise(session, input.projectId, "configure");
        const owner = this.processing.owner(session),
            item = this.get(owner, input.id, input.projectId);
        if (!item.enabled || !item.lastDiscovery)
            throw problem("Discover this source before reviewing its read plan.", 409);
        if (typeof input.comment !== "string" || !input.comment.trim() || input.comment.length > 4000)
            throw problem("Record the source window, grain and selection rationale.");
        const api = ["epic-fhir", "fhir-api", "sap-bw", "clinical-rest-api"].includes(item.profile.connector);
        if (
            (api && !item.profile.readPaths.includes(input.readPath)) ||
            (!api && (!input.plan || input.plan.schemaFingerprint !== item.lastDiscovery.fingerprint))
        )
            throw problem("Use the exact discovered schema or an approved API read path.");
        if (JSON.stringify(input).length > 131072) throw problem("Source read plan is too large.");
        if (
            !api &&
            (input.plan?.filters || []).some(
                (filter) => typeof filter.value === "number" && !Number.isSafeInteger(filter.value),
            )
        )
            throw problem("Use quoted decimal and large integer filter values to preserve exact source values.");
        const cursor = input.cursor || null;
        if (
            cursor &&
            (api ||
                input.appendOnlyAcknowledged !== true ||
                !Number.isInteger(cursor.table) ||
                !Number.isInteger(cursor.column) ||
                typeof cursor.field !== "string")
        )
            throw problem(
                "Append-only capture requires a unique numeric key and explicit confirmation of strictly increasing committed visibility.",
            );
        const checked = await this.command("check-plan", {
            profile: item.profile,
            plan: api ? null : input.plan,
            readPath: api ? input.readPath : null,
            cursor,
        });
        rmSync(checked.directory, { recursive: true, force: true });
        const value = {
            projectId: input.projectId,
            id: item.id,
            revision: item.revision,
            configurationSha256: item.configurationSha256,
            runtimeSha256: this.runtimeFingerprint(),
            cursor,
            plan: api ? null : input.plan,
            readPath: api ? input.readPath : null,
            comment: input.comment,
        };
        const ticket = this.processing.ticket(owner, "vendor-plan", value);
        ticket.summary = {
            projectId: input.projectId,
            source: item.displayName,
            connector: item.profile.connector,
            plan: value.plan,
            readPath: value.readPath,
            comment: value.comment,
            cursor,
            adapterRuntimeSha256: value.runtimeSha256,
            readOnly: true,
            patientRowsIncluded: false,
            warning:
                "Authorises this bounded private read only. Models and mapping require separate human confirmation.",
        };
        return ticket;
    }
    async commitPlan(session, token) {
        const value = this.processing.take(session, token, "vendor-plan");
        await this.authorise(session, value.projectId, "configure");
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((x) => x.id === value.id);
        if (
            !item ||
            !item.enabled ||
            item.revision !== value.revision ||
            item.configurationSha256 !== value.configurationSha256
        )
            throw problem("Source changed; review the plan again.", 409);
        if (item.planSha256)
            throw problem(
                "Create a new source connection for a revised read plan; existing channels retain their reviewed source.",
                409,
            );
        if (value.runtimeSha256 !== this.runtimeFingerprint())
            throw problem("The source adapter changed. Review its plan again.", 409);
        item.runtimeSha256 = value.runtimeSha256;
        item.cursor = value.cursor;
        item.plan = value.plan;
        item.readPath = value.readPath;
        item.planSha256 = hash(
            JSON.stringify({
                plan: value.plan,
                runtimeSha256: value.runtimeSha256,
                cursor: value.cursor,
                readPath: value.readPath,
                configurationSha256: item.configurationSha256,
            }),
        );
        item.sourceId = hash(item.id + "\n" + item.planSha256);
        item.revision++;
        item.review = { actor: owner, comment: value.comment, at: new Date().toISOString() };
        this.save(owner, items);
        mkdirSync(this.sourceRoot(owner, item), { recursive: true, mode: 0o700 });
        return this.visible(item);
    }
    sourceRoot(owner, item) {
        return join(this.processing.root, owner, "vendor-snapshots", item.sourceId);
    }
    connections(owner, project) {
        if (!this.vault()) return [];
        return this.all(owner)
            .filter(
                (item) =>
                    item.enabled &&
                    item.sourceId &&
                    (!this.canOperateOwner || this.canOperateOwner(owner, item.identityIssuer)) &&
                    (!project || item.projectId === project),
            )
            .map((item) => ({
                id: item.sourceId,
                root: this.sourceRoot(owner, item),
                format: ["epic-fhir", "fhir-api"].includes(item.profile.connector) ? "fhir-json" : "json",
                identityDomain: item.identityDomain,
                projects: [item.projectId],
                owners: [owner],
                displayName: item.displayName,
                vendor: true,
                profileId: item.id,
            }));
    }
    capturePin(item) {
        return hash(
            JSON.stringify({
                profile: item.profile,
                sourceId: item.sourceId,
                plan: item.plan,
                cursor: item.cursor,
                runtime: item.runtimeSha256,
                enabled: item.enabled,
                after: item.lastCursorJson ?? null,
                identityDomain: item.identityDomain,
            }),
        );
    }
    async materialise(owner, project, sourceId) {
        const item = this.all(owner).find((x) => x.sourceId === sourceId && x.projectId === project && x.enabled);
        if (!item) throw problem("Source connection or approved read plan changed.", 403);
        if (this.canOperateOwner && !this.canOperateOwner(owner, item.identityIssuer))
            throw problem("Source operator access was revoked.", 403);
        if (item.runtimeSha256 !== this.runtimeFingerprint())
            throw problem("The source adapter version changed; a newly reviewed source read plan is required.", 409);
        this.processing.checkOwnerQuota(owner);
        const pin = this.capturePin(item);
        const check = await this.command(
            "extract",
            {
                profile: item.profile,
                plan: item.plan,
                readPath: item.readPath,
                cursor: item.cursor,
                afterJson: item.lastCursorJson ?? null,
            },
            () =>
                this.capturePin(this.get(owner, item.id, project)) === pin &&
                (!this.canOperateOwner || this.canOperateOwner(owner, item.identityIssuer)),
        );
        try {
            const current = this.get(owner, item.id, project);
            if (this.capturePin(current) !== pin) throw problem("Source connection changed during extraction.", 409);
            if (!check.result.complete || check.result.readOnly !== true || !Number.isInteger(check.result.records))
                throw problem("Source snapshot is incomplete.", 503);
            if (check.result.records === 0) return { records: 0, file: null };
            if (
                item.cursor &&
                (typeof check.result.nextCursorJson !== "string" || check.result.nextCursorJson.length > 1024)
            )
                throw problem("Source cursor evidence is missing or invalid.", 503);
            const bytes = readFileSync(join(check.output, "records.json"));
            if (bytes.length > 16 * 1024 * 1024)
                throw problem(
                    "Source snapshot exceeds the private intake bound; narrow the approved source window.",
                    413,
                );
            if (hash(bytes) !== check.result.sha256) throw problem("Source snapshot integrity failed.", 503);
            const root = this.sourceRoot(owner, item);
            mkdirSync(root, { recursive: true, mode: 0o700 });
            const received = join(root, ".received", check.result.sha256);
            mkdirSync(received, { recursive: true, mode: 0o700 });
            for (const name of readdirSync(check.output).filter((name) =>
                /^received-[a-f0-9]{64}\.encrypted$/.test(name),
            )) {
                const target = join(received, name);
                if (!existsSync(target)) renameSync(join(check.output, name), target);
            }
            const file = "snapshot-" + check.result.sha256 + ".json",
                target = join(root, file);
            // Keep metadata outside the intake filename pattern. Publish only after originals and provenance are durable.
            writeFileSync(
                join(received, "capture-" + hash(JSON.stringify(check.result)) + ".manifest"),
                JSON.stringify({
                    ...check.result,
                    sourceId: item.sourceId,
                    configurationSha256: item.configurationSha256,
                    planSha256: item.planSha256,
                }),
                { mode: 0o600 },
            );
            const manifest = join(received, "capture-" + hash(JSON.stringify(check.result)) + ".manifest");
            const manifestFd = openSync(manifest, "r");
            try {
                fsyncSync(manifestFd);
            } finally {
                closeSync(manifestFd);
            }
            if (!existsSync(target)) renameSync(join(check.output, "records.json"), target);
            for (const path of [received, root]) {
                const fd = openSync(path, "r");
                try {
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
            }
            if (item.cursor) {
                if (check.result.nextCursorJson === null || check.result.nextCursorJson === undefined)
                    throw problem("Source cursor evidence is missing.", 503);
                const items = this.all(owner),
                    current = items.find((entry) => entry.id === item.id);
                if (this.capturePin(current) !== pin)
                    throw problem("Source changed before its cursor checkpoint.", 409);
                current.lastCursorJson = check.result.nextCursorJson;
                current.lastCapture = { at: new Date().toISOString(), sha256: check.result.sha256 };
                this.save(owner, items);
            }

            return { records: check.result.records, file, sha256: check.result.sha256 };
        } finally {
            rmSync(check.directory, { recursive: true, force: true });
        }
    }
    async refresh(session, input) {
        await this.authorise(session, input.projectId, "extract");
        this.processing.checkQuota(session);
        const item = this.get(this.processing.owner(session), input.id, input.projectId);
        if (!item.sourceId) throw problem("Confirm a read plan first.");
        return this.materialise(this.processing.owner(session), input.projectId, item.sourceId);
    }
    async disable(session, input) {
        await this.authorise(session, input.projectId, "configure");
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((x) => x.id === input.id && x.projectId === input.projectId);
        if (!item || item.revision !== input.expectedRevision) throw problem("Source changed.", 409);
        item.enabled = false;
        item.revision++;
        item.disabledAt = new Date().toISOString();
        this.save(owner, items);
        return this.visible(item);
    }
    async metadataAccess(session, input) {
        await this.authorise(session, input.projectId, "configure");
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((item) => item.id === input.id && item.projectId === input.projectId);
        if (!item || item.revision !== input.expectedRevision || typeof input.allow !== "boolean")
            throw problem("Source changed. Review metadata access again.", 409);
        item.allowAgentMetadata = input.allow;
        item.revision++;
        item.metadataAccessHistory = [
            ...(item.metadataAccessHistory || []),
            { actor: owner, allowed: input.allow, at: new Date().toISOString() },
        ].slice(-256);
        this.save(owner, items);
        return this.visible(item);
    }
    async enable(session, input) {
        await this.authorise(session, input.projectId, "configure");
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((x) => x.id === input.id && x.projectId === input.projectId);
        if (!item || item.revision !== input.expectedRevision) throw problem("Source changed.", 409);
        item.enabled = true;
        item.revision++;
        item.enabledAt = new Date().toISOString();
        this.save(owner, items);
        return this.visible(item);
    }
    close() {
        for (const child of this.active.values()) child?.kill("SIGTERM");
    }
}
