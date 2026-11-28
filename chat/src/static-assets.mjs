import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Only the server's explicit public-file allowlist enters this cache.
export class StaticAssets {
    constructor(root, routes) {
        this.routes = routes;
        this.files = new Map();
        for (const [path, [file, type]] of Object.entries(routes)) {
            const bytes = readFileSync(join(root, file));
            this.files.set(path, { bytes, type, hash: this.digest(bytes) });
        }
        for (const asset of this.files.values()) {
            if (!asset.type.startsWith("text/html")) continue;
            asset.bytes = Buffer.from(
                asset.bytes
                    .toString("utf8")
                    .replace(
                        /\b(href|src)=(['"])(\/chat\/[^'"?#]+\.(?:css|js))\2/g,
                        (match, attribute, quote, path) => {
                            const linked = this.files.get(path);
                            return linked ? `${attribute}=${quote}${path}?v=${linked.hash}${quote}` : match;
                        },
                    ),
            );
            asset.hash = this.digest(asset.bytes);
        }
    }
    digest(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
    }
    send(req, res, path) {
        const asset = this.files.get(path);
        const html = asset.type.startsWith("text/html");
        const version = new URL(req.url, "http://local").searchParams.get("v");
        const etag = `"${asset.hash}"`;
        res.setHeader("Content-Type", asset.type);
        res.setHeader(
            "Cache-Control",
            html
                ? "no-store"
                : version === asset.hash
                  ? "public, max-age=31536000, immutable"
                  : "public, max-age=0, must-revalidate",
        );
        if (!html) {
            res.setHeader("ETag", etag);
            if (
                (req.headers["if-none-match"] || "")
                    .split(",")
                    .some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")
            ) {
                res.writeHead(304);
                return res.end();
            }
        }
        res.setHeader("Content-Length", asset.bytes.length);
        res.writeHead(200);
        return res.end(asset.bytes);
    }
}
