import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ProviderStore } from "./provider-store.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const DAY = 86400000;

// Disposable modelling artefacts only. Never place CDR results, queries,
// credentials or authorization decisions in this cache.
export class ModelCache {
    constructor(config = {}, { now = Date.now, maxBytes = 256 * 1024 * 1024, ttl = DAY } = {}) {
        this.now = now;
        this.maxBytes = maxBytes;
        this.ttl = ttl;
        if (!config.providerEncryptionKey || !config.dataDir) return;
        try {
            this.directory = join(config.dataDir, "model-cache");
            mkdirSync(this.directory, { recursive: true, mode: 0o700 });
            this.store = new ProviderStore(this.directory, config.providerEncryptionKey, ["model"]);
        } catch {
            // An unavailable cache must not prevent authoritative reads.
        }
    }
    key(identity, repo, ref, kind, path = "") {
        // Token changes invalidate private-source entries without persisting the token.
        return digest(
            JSON.stringify([
                "models-v1",
                identity,
                repo.id,
                repo.kind,
                repo.url,
                repo.branch,
                digest(repo.token || ""),
                ref,
                kind,
                path,
            ]),
        );
    }
    get(key) {
        if (!this.store) return null;
        try {
            const path = join(this.directory, this.store.id(key, "model") + ".json");
            if (statSync(path).size > 12 * 1024 * 1024) return null;
            const entry = this.store.get(key, "model")?.credential;
            if (!entry || entry.expires <= this.now()) {
                this.store.delete(key, "model");
                return null;
            }
            utimesSync(path, new Date(this.now()), new Date(this.now()));
            return entry.value;
        } catch {
            return null;
        }
    }
    set(key, value) {
        if (!this.store) return;
        try {
            const bytes = Buffer.byteLength(JSON.stringify(value));
            if (bytes > 8 * 1024 * 1024 || bytes * 1.5 > this.maxBytes) return;
            this.store.set(key, "model", { expires: this.now() + this.ttl, value });
            this.prune();
        } catch {
            // Corruption, disk pressure and eviction are cache misses, not data loss.
        }
    }
    prune() {
        if (!this.store) return;
        const entries = readdirSync(this.directory)
            .filter((name) => /^[a-f0-9]{64}-model\.json$/.test(name))
            .map((name) => {
                const path = join(this.directory, name);
                return { path, ...statSync(path) };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        let bytes = 0;
        for (let i = 0; i < entries.length; i++) {
            const item = entries[i];
            bytes += item.size;
            if (bytes > this.maxBytes || i >= 1024 || item.mtimeMs < this.now() - this.ttl) unlinkSync(item.path);
        }
    }
}
