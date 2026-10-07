import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { problem } from "./personal-http.mjs";

export const UPLOAD_LIMIT = 10 * 1024 * 1024;
export function extractFile(path, name) {
    return new Promise((resolve) => {
        const child = fork(fileURLToPath(new URL("./extract-worker.mjs", import.meta.url)), [], {
            execArgv: ["--max-old-space-size=192"],
            env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(result);
        };
        const failed = () =>
            finish({
                text: "",
                status: "failed",
                note: "Original saved. Extraction exceeded its time or memory limit, or the file could not be read.",
            });
        const timer = setTimeout(failed, 20000);
        child.on("error", failed);
        child.on("exit", failed);
        child.on("message", finish);
        child.send({ path, name });
    });
}

export class Attachments {
    constructor(store, extractor = extractFile) {
        this.store = store;
        this.extractor = extractor;
    }
    directory(identity, id) {
        return this.store.path(identity, id).slice(0, -5);
    }
    async add(identity, conversation, name, bytes) {
        if (typeof name !== "string" || !name.trim() || name.length > 180 || /[\/\\\x00-\x1f\x7f]/.test(name))
            throw problem("Use a filename without directory separators or control characters.");
        if (!bytes.length || bytes.length > UPLOAD_LIMIT) throw problem("Choose a nonempty file of up to 10 MiB.", 413);
        const items = conversation.attachments || [];
        if (items.length >= 10 || items.reduce((sum, item) => sum + item.size, 0) + bytes.length > 30 * 1024 * 1024)
            throw problem(
                "A conversation supports 10 files and 30 MiB in total. Remove a file or start a new chat.",
                413,
            );
        const id = randomUUID(),
            directory = this.directory(identity, conversation.id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, id + ".bin"), bytes, { mode: 0o600, flag: "wx" });
        try {
            const extracted = await this.extractor(join(directory, id + ".bin"), name);
            writeFileSync(join(directory, id + ".txt"), extracted.text, { mode: 0o600, flag: "wx" });
            if (extracted.image)
                writeFileSync(join(directory, id + ".image.jpg"), Buffer.from(extracted.image.data, "base64"), {
                    mode: 0o600,
                    flag: "wx",
                });
            const item = {
                id,
                name,
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                status: extracted.status,
                note: extracted.note,
                characters: extracted.text.length,
                ...(extracted.image
                    ? {
                          image: {
                              mimeType: "image/jpeg",
                              width: extracted.image.width,
                              height: extracted.image.height,
                          },
                      }
                    : {}),
            };
            conversation.attachments = [...items, item];
            this.store.save(identity, conversation);
            return item;
        } catch (error) {
            conversation.attachments = items;
            for (const extension of [".bin", ".txt", ".image.jpg"]) {
                try {
                    unlinkSync(join(directory, id + extension));
                } catch (cleanup) {
                    if (cleanup.code !== "ENOENT") throw cleanup;
                }
            }
            throw error;
        }
    }
    get(conversation, id) {
        const item = conversation.attachments?.find((item) => item.id === id);
        if (!item) throw problem("Attachment not found.", 404);
        return item;
    }
    bytes(identity, conversation, id) {
        this.get(conversation, id);
        return readFileSync(join(this.directory(identity, conversation.id), id + ".bin"));
    }
    preview(identity, conversation, id) {
        const item = this.get(conversation, id);
        if (!item.image || item.status !== "image") throw problem("Image preview not found.", 404);
        return readFileSync(join(this.directory(identity, conversation.id), id + ".image.jpg"));
    }
    images(identity, conversation) {
        return (conversation.attachments || [])
            .filter((item) => item.image && item.status === "image")
            .map((item) => ({
                id: item.id,
                name: item.name,
                ...item.image,
                data: this.preview(identity, conversation, item.id).toString("base64"),
            }));
    }
    read(identity, conversation, args) {
        const item = this.get(conversation, args.attachment),
            offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > item.characters)
            throw problem("Choose a valid text offset.");
        const text = readFileSync(join(this.directory(identity, conversation.id), item.id + ".txt"), "utf8");
        return {
            ...item,
            offset,
            text: text.slice(offset, offset + 12000),
            nextOffset: offset + 12000 < text.length ? offset + 12000 : null,
        };
    }
    remove(identity, conversation, id) {
        const item = this.get(conversation, id);
        for (const extension of [".bin", ".txt", ...(item.image ? [".image.jpg"] : [])])
            unlinkSync(join(this.directory(identity, conversation.id), id + extension));
        conversation.attachments = conversation.attachments.filter((item) => item.id !== id);
        this.store.save(identity, conversation);
    }
}
