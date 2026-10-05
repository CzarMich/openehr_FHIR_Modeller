import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Credentials are bound to both the verified browser identity and provider.
export class ProviderStore {
    constructor(directory, key, scopes = ["codex", "claude", "copilot"]) {
        if (!/^[a-f0-9]{64}$/.test(key || "")) throw new Error("Configure CHAT_PROVIDER_ENCRYPTION_KEY");
        this.directory = directory;
        this.key = Buffer.from(key, "hex");
        this.scopes = scopes;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    id(identity, provider) {
        if (!this.scopes.includes(provider)) throw new Error("Unknown provider");
        return createHash("sha256").update(identity).digest("hex") + "-" + provider;
    }
    get(identity, provider) {
        const id = this.id(identity, provider);
        let record;
        try {
            record = JSON.parse(readFileSync(join(this.directory, id + ".json"), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        return JSON.parse(
            Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8"),
        );
    }
    set(identity, provider, credential, revision = randomUUID()) {
        const id = this.id(identity, provider),
            iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(id));
        const data = Buffer.concat([cipher.update(JSON.stringify({ credential, revision })), cipher.final()]);
        const path = join(this.directory, id + ".json"),
            temp = path + "." + randomUUID();
        try {
            writeFileSync(
                temp,
                JSON.stringify({
                    iv: iv.toString("base64"),
                    tag: cipher.getAuthTag().toString("base64"),
                    data: data.toString("base64"),
                }),
                { mode: 0o600, flag: "wx" },
            );
            renameSync(temp, path);
        } finally {
            try {
                unlinkSync(temp);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        return revision;
    }
    delete(identity, provider) {
        try {
            unlinkSync(join(this.directory, this.id(identity, provider) + ".json"));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
}
