import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StaticAssets } from "../src/static-assets.mjs";

test("public asset caching saves warm transfers and invalidates changed release bytes", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "modeller-assets-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(
        join(root, "index.html"),
        '<link rel="stylesheet" href="/chat/style.css"><script src="/chat/app.js"></script>',
    );
    writeFileSync(join(root, "style.css"), "body { color: blue; }");
    writeFileSync(join(root, "app.js"), 'console.log("fixture");');
    const routes = {
        "/chat/": ["index.html", "text/html"],
        "/chat/style.css": ["style.css", "text/css"],
        "/chat/app.js": ["app.js", "text/javascript"],
    };
    let assets = new StaticAssets(root, routes);
    const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        const path = new URL(req.url, "http://local").pathname;
        if (routes[path]) return assets.send(req, res, path);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"private":true}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(origin + "/chat/");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    const stylesheet = html.match(/href="([^"]+)"/)[1];
    assert.match(stylesheet, /\?v=[a-f0-9]{64}$/);
    assert.match(html, /app\.js\?v=[a-f0-9]{64}/);
    const cold = await fetch(origin + stylesheet);
    assert.equal(cold.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(cold.headers.get("content-type"), "text/css");
    assert.equal((await cold.text()).length, Number(cold.headers.get("content-length")));
    const unchanged = await fetch(origin + stylesheet, {
        headers: { "If-None-Match": '"other", W/' + cold.headers.get("etag") },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    const legacy = await fetch(origin + "/chat/style.css");
    assert.equal(legacy.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    writeFileSync(join(root, "style.css"), "body { color: green; }");
    assets = new StaticAssets(root, routes); // New immutable image/process.
    const upgraded = await (await fetch(origin + "/chat/")).text();
    assert.notEqual(upgraded.match(/href="([^"]+)"/)[1], stylesheet);
    const stale = await fetch(origin + stylesheet, { headers: { "If-None-Match": cold.headers.get("etag") } });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.match(await stale.text(), /green/);
    const privateResponse = await fetch(origin + "/chat/api/session");
    assert.equal(privateResponse.headers.get("cache-control"), "no-store");
});
