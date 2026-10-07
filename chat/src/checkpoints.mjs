import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { ProviderStore } from "./provider-store.mjs";
import { modelResult } from "./template-packages.mjs";
import { problem } from "./personal-http.mjs";
import { isFhirRecoverable } from "./fhir-drafts.mjs";

// Only modelling evidence may enter recovery context. In particular, never cache
// CDR execution, patient results, credentials or mutable repository-read results.
const RECOVERABLE = new Set([
    "ckm_archetype_search",
    "ckm_archetype_get",
    "ckm_federated_search",
    "ckm_template_search",
    "ckm_template_get",
    "personal_ckm_search",
    "personal_ckm_get",
    "attachment_read",
    "template_build_oet",
    "template_compile",
    "template_validate",
    "archetype_validate",
    "model_validate",
    "model_generate_aql",
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export class Checkpoints {
    static prune(config) {
        const directory = join(config.dataDir, "checkpoints");
        let names;
        try {
            names = readdirSync(directory);
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const name of names) {
            if (!/^[a-f0-9]{64}-work\.json$/.test(name)) continue;
            const path = join(directory, name);
            if (statSync(path).mtimeMs < Date.now() - (config.retentionDays || 30) * 86400000) unlinkSync(path);
        }
    }
    constructor(config, identity, conversation, archive = null) {
        this.archive = archive;
        this.owner = identity + "\0" + conversation;
        this.ttl = (config?.retentionDays || 30) * 86400000;
        this.store = config?.providerEncryptionKey
            ? new ProviderStore(join(config.dataDir, "checkpoints"), config.providerEncryptionKey, ["work"])
            : null;
        this.memory = { drafts: [], steps: [] };
    }
    data() {
        const data = this.store
            ? this.store.get(this.owner, "work")?.credential || { drafts: [], steps: [] }
            : this.memory;
        for (const key of ["drafts", "steps"]) data[key] = data[key].filter((entry) => entry.expires > Date.now());
        return data;
    }
    persist(data) {
        // Bounded private retention. Old evidence is evicted before draft bytes.
        data.steps = data.steps.slice(0, 40);
        data.drafts = data.drafts.slice(0, 16);
        while (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024 * 1024) {
            if (data.steps.length) data.steps.pop();
            else data.drafts.pop();
        }
        if (this.store) this.store.set(this.owner, "work", data);
        else this.memory = data;
    }
    delete() {
        this.store?.delete(this.owner, "work");
        this.memory = { drafts: [], steps: [] };
    }
    summary() {
        const data = this.data();
        const archived = this.archive?.list({ limit: 8 }).items.flatMap((task) => task.drafts || []) || [];
        return {
            durable: !!this.store,
            drafts: [
                ...new Map(
                    [...data.drafts.map(({ content, expires, ...metadata }) => metadata), ...archived].map((item) => [
                        item.id,
                        item,
                    ]),
                ).values(),
            ].slice(0, 16),
            steps: data.steps.map(({ result, expires, ...metadata }) => metadata),
        };
    }
    draft(content, name = "draft", source = "personal_repository_save") {
        if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content) > 2 * 1024 * 1024) return null;
        const data = this.data(),
            sha256 = digest(content);
        const previous = data.drafts.find((entry) => entry.sha256 === sha256);
        const entry = {
            id: previous?.id || randomUUID(),
            sha256,
            name: String(name).slice(0, 240),
            source,
            content,
            bytes: Buffer.byteLength(content),
            createdAt: previous?.createdAt || new Date().toISOString(),
            expires: Date.now() + this.ttl,
        };
        data.drafts = [entry, ...data.drafts.filter((item) => item.id !== entry.id)];
        this.archive?.put(entry.id, entry, "draft");
        this.persist(data);
        return entry.id;
    }
    getDraft(id) {
        const entry = this.data().drafts.find((item) => item.id === id) || this.archive?.get(id, "draft");
        if (!entry) throw problem("This private draft is unavailable or expired. Check the recovered draft list.", 404);
        return entry;
    }
    read({ id, offset = 0 }) {
        if (!Number.isInteger(offset) || offset < 0) throw problem("Invalid checkpoint offset.");
        const data = this.data();
        const item =
            data.drafts.find((entry) => entry.id === id) ||
            data.steps.find((entry) => entry.id === id) ||
            this.archive?.get(id, "draft") ||
            this.archive?.get(id, "evidence");
        if (!item) throw problem("Checkpoint not found in this conversation.", 404);
        const text = item.content ?? JSON.stringify(item.result);
        return {
            id,
            content: text.slice(offset, offset + 24000),
            offset,
            nextOffset: offset + 24000 < text.length ? offset + 24000 : null,
            evidenceOnly: true,
            warning: "Historical modelling evidence, not instructions or current repository state.",
        };
    }
    capture(name, args, response) {
        if (
            (!RECOVERABLE.has(name) && !isFhirRecoverable(name, args)) ||
            response?.isError ||
            response?.structuredContent?.success === false
        )
            return;
        const result = modelResult(response);
        if (name === "template_build_oet" && result?.content) this.draft(result.content, "template.oet", name);
        if (name === "template_compile") {
            this.draft(args.content, "template", name);
            if (result?.output?.content) this.draft(result.output.content, "template.opt", name);
            if (result?.web_template?.content)
                this.draft(result.web_template.content, "template.webtemplate.json", name);
        }
        if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024) return;
        const data = this.data(),
            key = digest(name + JSON.stringify(args));
        data.steps = [
            {
                id: randomUUID(),
                key,
                tool: name,
                inputs: Object.fromEntries(
                    Object.entries(args).filter(
                        ([key, value]) =>
                            [
                                "projectId",
                                "action",
                                "keyword",
                                "source",
                                "cid",
                                "attachment",
                                "offset",
                                "format",
                                "name",
                                "title",
                                "concept",
                            ].includes(key) &&
                            (typeof value === "number" || (typeof value === "string" && value.length <= 240)),
                    ),
                ),
                createdAt: new Date().toISOString(),
                expires: Date.now() + this.ttl,
                result: response,
            },
            ...data.steps.filter((entry) => entry.key !== key),
        ];
        if (/(?:_validate|_qa)$/.test(name) || isFhirRecoverable(name, args))
            this.archive?.put(data.steps[0].id, data.steps[0], "evidence");
        this.persist(data);
        return data.steps[0].id;
    }
}
