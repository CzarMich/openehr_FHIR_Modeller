import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { problem } from "./personal-http.mjs";

export class Shares {
    constructor(store) {
        this.store = store;
        this.directory = join(store.directory, "shares");
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    prune() {
        for (const name of readdirSync(this.directory)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const path = join(this.directory, name);
            if (Date.now() - statSync(path).mtimeMs > 7 * 86400000) unlinkSync(path);
        }
    }
    revoke(identity, conversation) {
        if (conversation.share) {
            try {
                unlinkSync(join(this.directory, conversation.share.digest + ".json"));
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            delete conversation.share;
            this.store.save(identity, conversation);
        }
    }
    create(identity, conversation) {
        this.revoke(identity, conversation);
        const token = randomBytes(32).toString("base64url"),
            digest = createHash("sha256").update(token).digest("hex"),
            expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
        const snapshot = {
            title: conversation.title,
            messages: conversation.messages.map(({ role, content }) => ({ role, content })),
            createdAt: new Date().toISOString(),
            expiresAt,
        };
        writeFileSync(
            join(this.directory, digest + ".json"),
            JSON.stringify({ owner: this.store.owner(identity), id: conversation.id, snapshot }),
            { mode: 0o600, flag: "wx" },
        );
        conversation.share = { digest, expiresAt };
        this.store.save(identity, conversation);
        return { token, expiresAt };
    }
    get(token) {
        try {
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid");
            const digest = createHash("sha256").update(token).digest("hex");
            const { owner, id, snapshot } = JSON.parse(readFileSync(join(this.directory, digest + ".json"), "utf8"));
            const path = join(this.store.directory, owner, id + ".json");
            const source = JSON.parse(readFileSync(path, "utf8"));
            if (
                source.share?.digest !== digest ||
                Date.parse(snapshot.expiresAt) <= Date.now() ||
                Date.now() - statSync(path).mtimeMs > this.store.retentionMs
            )
                throw new Error("Expired");
            return snapshot;
        } catch {
            throw problem("Shared conversation not found or expired.", 404);
        }
    }
}
