import { spawn } from "node:child_process";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    existsSync,
    readdirSync,
    lstatSync,
    renameSync,
    openSync,
    fsyncSync,
    closeSync,
    rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { ProviderStore } from "./provider-store.mjs";
import { problem } from "./personal-http.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = /^[a-f0-9]{64}$/;
function read(file) {
    if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 8 * 1048576)
        throw problem("Kafka capture metadata is invalid.", 503);
    return JSON.parse(readFileSync(file, "utf8"));
}
function durable(file, bytes) {
    const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temp, file);
    const parent = openSync(dirname(file), "r");
    try {
        fsyncSync(parent);
    } finally {
        closeSync(parent);
    }
}
export class KafkaSources {
    constructor(config, core, processing, { launcher = spawn, store, runtimeFingerprint } = {}) {
        this.config = config;
        this.core = core;
        this.processing = processing;
        this.launcher = launcher;
        this.store = store;
        this.active = new Map();
        this.captures = new Map();
        this.runtimeFingerprint =
            runtimeFingerprint ||
            (() =>
                hash(
                    ["Modeller.Kafka.dll", "Modeller.Core.dll", "Confluent.Kafka.dll", "Modeller.Kafka.deps.json"]
                        .map((name) => hash(readFileSync(join(dirname(config.integrationKafkaReader), name))))
                        .join("\n"),
                ));
        this.root = join(config.dataDir, "kafka-sources");
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
    key() {
        const file = this.core.configuration?.operationalKeyFile;
        if (!file || !existsSync(file)) return null;
        const key = readFileSync(file);
        if (key.length !== 32) throw problem("The original integration encryption key is required.", 503);
        return Buffer.from(
            hkdfSync("sha256", key, Buffer.from("modeller-kafka-vault/v1"), Buffer.from("owner-bound-kafka"), 32),
        ).toString("hex");
    }
    vault() {
        if (this.store) return this.store;
        const key = this.key();
        if (!key) return null;
        this.store = new ProviderStore(join(this.root, "profiles"), key, ["sources"]);
        return this.store;
    }
    all(owner) {
        return this.vault()?.get(owner, "sources")?.credential || [];
    }
    save(owner, items) {
        if (!this.vault()) throw problem("Kafka credential encryption is unavailable.", 503);
        this.vault().set(owner, "sources", items);
    }
    visible(item) {
        return {
            id: item.id,
            sourceId: item.sourceId,
            projectId: item.projectId,
            displayName: item.displayName,
            identityDomain: item.identityDomain,
            revision: item.revision,
            enabled: item.enabled,
            valueFormat: item.valueFormat,
            topic: item.profile.topic,
            clusterId: item.profile.clusterId,
            topicId: item.profile.topicId,
            credentialConfigured: true,
            readOnlyTopicData: true,
            offsetAcknowledgment: "AFTER_DURABLE_PRIVATE_INTAKE",
            installationQualified: false,
            lastCapture: item.lastCapture || null,
        };
    }
    async authorise(session, projectId, action = "configure") {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(projectId || "")) throw problem("Choose a project.");
        return this.core.request(session, "POST", "/api/v1/integration/projects/" + projectId + "/source-access", {
            action,
        });
    }
    async list(session, projectId) {
        await this.authorise(session, projectId, "inspect");
        return {
            items: this.all(this.processing.owner(session))
                .filter((item) => item.projectId === projectId)
                .map((item) => this.visible(item)),
            credentialsReturned: false,
        };
    }
    async preview(session, input) {
        if (!input) throw problem("Invalid Kafka source configuration.");
        await this.authorise(session, input.projectId);
        const allowed = [
            "projectId",
            "displayName",
            "identityDomain",
            "valueFormat",
            "brokers",
            "topic",
            "authentication",
            "username",
            "password",
            "caPem",
            "certificatePem",
            "keyPem",
            "maximumMessages",
            "comment",
        ];
        if (
            !input ||
            Object.keys(input).some((key) => !allowed.includes(key)) ||
            typeof input.displayName !== "string" ||
            !input.displayName.trim() ||
            input.displayName.length > 100 ||
            typeof input.identityDomain !== "string" ||
            !input.identityDomain ||
            input.identityDomain.length > 256 ||
            /[\r\n\0]/.test(input.identityDomain) ||
            typeof input.comment !== "string" ||
            input.comment.trim().length < 8
        )
            throw problem("Provide the source identity, topic contract and authorisation reason.");
        if (
            ![
                "json-envelope",
                "json",
                "fhir-json",
                "openehr-json",
                "hl7-v2",
                "hl7-v2-xml",
                "hl7-v3",
                "cda",
                "csv",
                "xml",
            ].includes(input.valueFormat) ||
            !Array.isArray(input.brokers) ||
            input.brokers.length < 1 ||
            input.brokers.length > 8 ||
            input.brokers.some((b) => typeof b !== "string" || b.length > 256) ||
            !/^([A-Za-z0-9._-]{1,249})$/.test(input.topic || "") ||
            input.topic.startsWith("__") ||
            input.topic === "." ||
            input.topic === ".." ||
            !["tls", "plain", "scram-sha-256", "scram-sha-512"].includes(input.authentication) ||
            !Number.isInteger(input.maximumMessages) ||
            input.maximumMessages < 1 ||
            input.maximumMessages > 100
        )
            throw problem("Choose a bounded Kafka topic and supported payload format.");
        for (const field of ["username", "password", "caPem", "certificatePem", "keyPem"])
            if (
                input[field] !== undefined &&
                input[field] !== null &&
                (typeof input[field] !== "string" || input[field].length > 65536)
            )
                throw problem("Kafka credential material exceeds its limit.");
        const owner = this.processing.owner(session),
            sourceId = randomBytes(32).toString("hex");
        const profile = {
            brokers: input.brokers,
            topic: input.topic,
            groupId: "modeller-" + sourceId,
            authentication: input.authentication,
            username: input.username || null,
            password: input.password || null,
            caPem: input.caPem || null,
            certificatePem: input.certificatePem || null,
            keyPem: input.keyPem || null,
            startPosition: "earliest",
            maximumMessages: input.maximumMessages,
            maximumBytes: 16777216,
        };
        const value = {
            id: sourceId,
            sourceId,
            projectId: input.projectId,
            displayName: input.displayName,
            identityDomain: input.identityDomain,
            valueFormat: input.valueFormat,
            profile,
            revision: 1,
            enabled: true,
            identityIssuer: session.reviewIdentity?.issuer || null,
            runtimeSha256: this.runtimeFingerprint(),
            lastSequence: "0",
            afterOffsets: null,
            comment: input.comment,
        };
        const result = this.processing.ticket(owner, "kafka-source", value);
        return {
            ...result,
            summary: {
                sourceId,
                projectId: input.projectId,
                displayName: input.displayName,
                identityDomain: input.identityDomain,
                valueFormat: input.valueFormat,
                brokers: profile.brokers,
                topic: profile.topic,
                groupId: profile.groupId,
                tlsVerification: "REQUIRED",
                authentication: profile.authentication,
                credentialConfigured: true,
                configurationSha256: hash(JSON.stringify(profile)),
                startPosition: "EARLIEST_RETAINED",
                maximumMessages: profile.maximumMessages,
                commitPolicy: "ONLY_AFTER_DURABLE_PRIVATE_INTAKE",
                mappingApproval: "SEPARATE",
                comment: input.comment,
            },
        };
    }
    pendingRoot(owner, item) {
        const dir = join(this.processing.root, owner, "kafka-pending", item.id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }
    sourceRoot(owner, item) {
        const dir = join(this.processing.root, owner, "kafka-snapshots", item.sourceId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }
    async command(operation, owner, item, directory, onReady) {
        if (this.active.size >= 2 || this.processing.active.size + this.processing.inspectionRequests >= 2)
            throw problem("Private processing capacity is busy.", 429);
        this.processing.inspectionRequests++;
        return new Promise((resolve, reject) => {
            const child = this.launcher(this.config.integrationKafkaReader, [operation, directory], {
                env: {
                    PATH: process.env.PATH,
                    LANG: "C.UTF-8",
                    DOTNET_ENVIRONMENT: "Production",
                    DOTNET_EnableDiagnostics: "0",
                    DOTNET_GCHeapHardLimit: "0x10000000",
                },
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
            });
            this.active.set(item.id, child);
            let stdout = "",
                stderr = "",
                ready = null,
                publicationError = null,
                ended = false;
            child.stdin.on("error", () => {});
            child.stdin.write(
                JSON.stringify({ profile: item.profile, afterOffsets: item.afterOffsets || null }) + "\n",
            );
            const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
            timer.unref();
            const access = setInterval(() => {
                try {
                    if (this.canOperateOwner && !this.canOperateOwner(owner, item.identityIssuer))
                        child.kill("SIGTERM");
                    const current = this.all(owner).find((p) => p.id === item.id);
                    if (operation === "capture" && (!current?.enabled || current.runtimeSha256 !== item.runtimeSha256))
                        child.kill("SIGTERM");
                } catch {
                    child.kill("SIGTERM");
                }
            }, 1000);
            access.unref();
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
                if (stdout.length > 262144) {
                    child.kill("SIGTERM");
                    return;
                }
                if (operation === "capture" && !ready) {
                    const line = stdout.split("\n")[0];
                    try {
                        const value = JSON.parse(line);
                        if (value.ready) {
                            ready = Promise.resolve()
                                .then(() => onReady())
                                .then((result) => {
                                    child.stdin.end("DURABLY_ACCEPTED\n");
                                    return result;
                                })
                                .catch((error) => {
                                    publicationError = error;
                                    child.kill("SIGTERM");
                                });
                        }
                    } catch {
                        /* Wait for a complete line. */
                    }
                }
            });
            child.stderr.on("data", (chunk) => {
                if (stderr.length < 256) stderr += chunk.toString();
            });
            const end = async (code) => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                clearInterval(access);
                this.active.delete(item.id);
                this.processing.inspectionRequests--;
                if (ready) await ready;
                if (publicationError) return reject(publicationError);
                if (operation === "capture" && ready) {
                    const receipt = read(join(directory, "manifest.json"));
                    return resolve({ manifest: receipt, brokerCommitted: code === 0 });
                }
                if (code !== 0)
                    return reject(
                        problem(
                            /^[A-Z0-9_]+\s*$/.test(stderr) ? stderr.trim() : "Kafka connection or capture failed.",
                            503,
                        ),
                    );
                try {
                    resolve(JSON.parse(stdout.trim()));
                } catch {
                    reject(problem("Kafka reader returned an invalid response.", 503));
                }
            };
            child.once("exit", end);
            child.once("error", () => end(1));
        });
    }
    async commit(session, confirmation) {
        const item = this.processing.take(session, confirmation, "kafka-source");
        await this.authorise(session, item.projectId);
        const owner = this.processing.owner(session),
            items = this.all(owner);
        if (items.length >= 128) throw problem("Kafka source limit reached.", 429);
        const directory = join(this.pendingRoot(owner, item), "discovery");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        try {
            const result = await this.command("discover", owner, item, directory);
            if (!result.tlsVerified || !result.clusterId || !result.topicId)
                throw problem("Kafka source identity verification failed.", 503);
            item.profile.clusterId = result.clusterId;
            item.profile.topicId = result.topicId;
            item.partitions = result.partitions;
            this.save(owner, [...items, item]);
            return this.visible(item);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
    connections(owner, project) {
        return this.all(owner)
            .filter(
                (item) =>
                    item.enabled &&
                    (!project || item.projectId === project) &&
                    (!this.canOperateOwner || this.canOperateOwner(owner, item.identityIssuer)),
            )
            .map((item) => ({
                id: item.sourceId,
                root: this.sourceRoot(owner, item),
                format: item.valueFormat === "json-envelope" ? "json" : item.valueFormat,
                identityDomain: item.identityDomain,
                projects: [item.projectId],
                owners: [owner],
                displayName: item.displayName,
                kafka: true,
                ordered: true,
                profileId: item.id,
                incremental: true,
            }));
    }
    materialise(owner, project, sourceId) {
        const key = owner + ":" + sourceId;
        if (this.captures.has(key)) return this.captures.get(key);
        const promise = this.capture(owner, project, sourceId).finally(() => this.captures.delete(key));
        this.captures.set(key, promise);
        return promise;
    }
    async publish(owner, item, directory) {
        const manifest = read(join(directory, "manifest.json"));
        if (
            manifest.clusterId !== item.profile.clusterId ||
            manifest.topicId !== item.profile.topicId ||
            manifest.topic !== item.profile.topic ||
            !Array.isArray(manifest.items) ||
            manifest.items.length > 100
        )
            throw problem("Kafka capture source identity changed.", 409);
        const items = this.all(owner),
            current = items.find((p) => p.id === item.id);
        if (!current?.enabled || current.runtimeSha256 !== this.runtimeFingerprint())
            throw problem("Kafka approval or runtime changed; review the source again.", 409);
        const root = this.sourceRoot(owner, current),
            key = this.key(),
            received = new ProviderStore(join(root, ".received"), key, ["event"]);
        for (const event of manifest.items) {
            if (
                !id.test(event.eventId) ||
                event.file !== "message-" + event.eventId + ".bin" ||
                !id.test(event.sha256) ||
                !id.test(event.envelopeSha256) ||
                !Number.isInteger(event.partition) ||
                event.partition < 0 ||
                typeof event.offset !== "string" ||
                !/^[0-9]+$/.test(event.offset) ||
                hash(
                    JSON.stringify([
                        manifest.clusterId,
                        manifest.topicId,
                        manifest.topic,
                        String(event.partition),
                        event.offset,
                    ]),
                ) !== event.eventId
            )
                throw problem("Kafka capture evidence failed integrity checks.", 503);
            const rawPath = join(directory, event.file),
                envelopePath = join(directory, "envelope-" + event.eventId + ".json");
            for (const path of [rawPath, envelopePath]) {
                const stat = lstatSync(path);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216)
                    throw problem("Kafka capture file is invalid.", 503);
            }
            const original = readFileSync(rawPath);
            if (original.length !== event.bytes || hash(original) !== event.sha256)
                throw problem("Kafka original changed before durable receipt.", 503);
            const input =
                current.valueFormat === "json-envelope"
                    ? readFileSync(join(directory, "envelope-" + event.eventId + ".json"))
                    : original;
            if (current.valueFormat === "json-envelope" && hash(input) !== event.envelopeSha256)
                throw problem("Kafka source envelope changed.", 503);
            const existing = received.get(event.eventId, "event")?.credential;
            if (existing && (existing.sourceSha256 !== hash(input) || existing.originalSha256 !== event.sha256))
                throw problem("Kafka event identity was reused with different content.", 409);
            const sequence = existing?.sequence || (BigInt(current.lastSequence || "0") + 1n).toString();
            if (BigInt(sequence) > BigInt(current.lastSequence || "0")) current.lastSequence = sequence;
            const extension =
                {
                    "fhir-json": "json",
                    "openehr-json": "json",
                    "json-envelope": "json",
                    "hl7-v2": "hl7",
                    "hl7-v2-xml": "xml",
                    "hl7-v3": "xml",
                    cda: "xml",
                }[current.valueFormat] || current.valueFormat;
            const file = "event-" + sequence.padStart(20, "0") + "-" + event.eventId + "." + extension;
            if (!existing) {
                if (this.processing.checkOwnerQuota(owner) + input.length + original.length * 2 + 65536 > 512 * 1048576)
                    throw problem("Private Kafka intake storage is full.", 413);
                received.set(event.eventId, "event", {
                    sequence,
                    file,
                    sourceSha256: hash(input),
                    originalSha256: event.sha256,
                    originalBase64: original.toString("base64"),
                    metadata: event,
                    ready: false,
                });
            }
            if (!existing?.ready) {
                if (input.length < 1)
                    throw problem(
                        "A tombstone in a raw message format requires envelope handling or operator disposition.",
                        409,
                    );
                durable(join(root, file), input);
                received.set(event.eventId, "event", {
                    sequence,
                    file,
                    sourceSha256: hash(input),
                    originalSha256: event.sha256,
                    originalBase64: original.toString("base64"),
                    metadata: event,
                    ready: true,
                });
            }
        }
        for (const [partition, offset] of Object.entries(manifest.nextOffsets || {}))
            if (
                !/^[0-9]+$/.test(partition) ||
                typeof offset !== "string" ||
                !/^[0-9]+$/.test(offset) ||
                BigInt(offset) < BigInt(current.afterOffsets?.[partition] || "0")
            )
                throw problem("Kafka checkpoint is not monotonic.", 503);
        current.afterOffsets = manifest.nextOffsets;
        current.lastCapture = {
            at: new Date().toISOString(),
            records: manifest.items.length,
            bytes: manifest.items.reduce((sum, event) => sum + event.bytes, 0),
            tombstones: manifest.items.filter((event) => event.tombstone).length,
            pendingOnDisk: true,
        };
        this.save(owner, items);
        return current.lastCapture;
    }
    async capture(owner, project, sourceId) {
        let item = this.all(owner).find((p) => p.sourceId === sourceId && p.projectId === project && p.enabled);
        if (!item) throw problem("Kafka source access changed.", 403);
        if (item.runtimeSha256 !== this.runtimeFingerprint())
            throw problem("The Kafka adapter changed; a new reviewed source configuration is required.", 409);
        if (this.canOperateOwner && !this.canOperateOwner(owner, item.identityIssuer))
            throw problem("Kafka source operator access was revoked.", 403);
        const pending = this.pendingRoot(owner, item);
        for (const name of readdirSync(pending).filter((name) => /^capture-[a-f0-9]{32}$/.test(name))) {
            const directory = join(pending, name);
            if (existsSync(join(directory, "manifest.json"))) {
                const identity = await this.command("discover", owner, item, directory);
                if (identity.clusterId !== item.profile.clusterId || identity.topicId !== item.profile.topicId)
                    throw problem("Kafka source identity changed; preserved capture requires review.", 409);
                await this.publish(owner, item, directory);
                rmSync(directory, { recursive: true, force: true });
            } else if (readdirSync(directory).length === 0) {
                rmSync(directory, { recursive: true });
            } else
                throw problem(
                    "An interrupted Kafka capture requires operator review; preserved inputs were not discarded.",
                    409,
                );
        }
        item = this.all(owner).find((p) => p.id === item.id);
        if (this.processing.checkOwnerQuota(owner) + 64 * 1048576 > 512 * 1048576)
            throw problem("Private Kafka capture needs storage headroom before reading more data.", 413);
        const directory = join(pending, "capture-" + randomBytes(16).toString("hex"));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        let result;
        try {
            result = await this.command("capture", owner, item, directory, () => this.publish(owner, item, directory));
        } catch (error) {
            if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true });
            throw error;
        }
        const items = this.all(owner),
            current = items.find((p) => p.id === item.id);
        current.lastCapture.brokerCommitConfirmed = result.brokerCommitted;
        this.save(owner, items);
        rmSync(directory, { recursive: true, force: true });
        return { records: result.manifest.items.length, brokerCommitted: result.brokerCommitted };
    }
    async refresh(session, input) {
        await this.authorise(session, input.projectId, "extract");
        return this.materialise(this.processing.owner(session), input.projectId, input.sourceId);
    }
    async setEnabled(session, input) {
        await this.authorise(session, input.projectId);
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((p) => p.id === input.id && p.projectId === input.projectId);
        if (!item || item.revision !== input.expectedRevision || typeof input.enabled !== "boolean")
            throw problem("Reload the Kafka source before changing it.", 409);
        item.enabled = input.enabled;
        item.revision++;
        this.save(owner, items);
        return this.visible(item);
    }
    close() {
        for (const child of this.active.values()) child.kill("SIGTERM");
    }
}
