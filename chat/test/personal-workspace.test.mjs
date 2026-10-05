import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import sharp from "sharp";
import { Store } from "../src/store.mjs";
import { PersonalConnections } from "../src/personal-connections.mjs";
import { publicAddress, personalRequest } from "../src/personal-http.mjs";
import { Attachments, extractFile } from "../src/attachments.mjs";
import { Shares } from "../src/shares.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";
import { loadConfig } from "../src/config.mjs";
import { Auth } from "../src/auth.mjs";
import { createApplication } from "../src/server.mjs";
import { sourcePdf } from "./fixtures/pdf.mjs";

function setup(t, request) {
    const directory = mkdtempSync(join(tmpdir(), "personal-workspace-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = {
        ...loadConfig(),
        enabled: true,
        dataDir: directory,
        providerEncryptionKey: "ab".repeat(32),
        allowWrites: true,
    };
    const store = new Store(join(directory, "conversations"));
    return {
        directory,
        config,
        store,
        connections: new PersonalConnections(config, { request }),
        attachments: new Attachments(store),
        shares: new Shares(store),
    };
}
const github = {
    kind: "github",
    label: "My models",
    url: "https://github.com/alice/models.git",
    branch: "draft/renal",
    token: "private-test-token",
};

test("personal CKMs deduplicate enterprise URLs and remain encrypted and owner-bound", (t) => {
    const { connections, directory } = setup(t);
    const ckm = { kind: "ckm", label: "Regional", url: "https://MODELS.example/ckm/rest/", token: "private-token" };
    const enterprise = [{ id: "regional", kind: "ckm", url: "https://models.example/ckm/rest", scope: "enterprise" }];
    assert.equal(connections.add("alice", ckm, enterprise).duplicate, true);
    assert.deepEqual(connections.list("alice"), []);
    const added = connections.add("alice", ckm).connection;
    assert.equal(connections.add("alice", ckm).duplicate, true);
    assert.equal(connections.list("alice").length, 1);
    assert.deepEqual(connections.list("bob"), []);
    assert.throws(() => connections.get("bob", added.id), /not found/);
    assert.throws(() => connections.remove("bob", added.id), /not found/);
    const file = readdirSync(join(directory, "connections"))[0];
    assert.doesNotMatch(readFileSync(join(directory, "connections", file), "utf8"), /private-token|Regional/);
    assert.doesNotMatch(JSON.stringify(added), /private-token/);
    assert.throws(() => connections.add("alice", { ...ckm, url: "https://user:password@models.example/" }));
    connections.remove("alice", added.id);
    assert.deepEqual(connections.list("alice"), []);
});

test("repository access updates keep the selected ID and never return or replace another owner's token", (t) => {
    const { connections } = setup(t);
    const saved = connections.add("alice", { ...github, token: undefined }).connection;
    const other = connections.add("bob", { ...github, token: "bob-token" }).connection;
    const result = connections.add("alice", { ...github, token: "alice-updated-token" });
    assert.equal(result.updated, true);
    assert.equal(result.connection.id, saved.id);
    assert.equal(result.connection.authenticated, true);
    assert.equal(connections.list("alice").length, 1);
    assert.equal(connections.get("alice", saved.id).token, "alice-updated-token");
    assert.equal(connections.get("bob", other.id).token, "bob-token");
    assert.doesNotMatch(JSON.stringify(result), /alice-updated-token/);
    connections.add("alice", { ...github, token: undefined });
    assert.equal(connections.get("alice", saved.id).token, "alice-updated-token");
});

test("personal HTTP denies local, reserved, mapped IPv6 and non-HTTPS targets", async () => {
    for (const address of [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "fe80::1",
        "fc00::1",
    ])
        assert.equal(publicAddress(address), false, address);
    assert.equal(publicAddress("8.8.8.8"), true);
    assert.throws(() => personalRequest("https://127.0.0.1/test"));
    assert.throws(() => personalRequest("http://example.org/test"));
    await assert.rejects(personalRequest("https://localhost/test"), /could not complete/);
});

test("personal CKM requests bind only the owner's token and return source provenance", async (t) => {
    const calls = [];
    const { connections } = setup(t, async (url, options) => {
        calls.push({ url, ...options });
        return { status: 200, text: url.includes("?") ? JSON.stringify([{ cid: "123.4.5" }]) : "archetype content" };
    });
    const source = connections.add("alice", {
        kind: "ckm",
        label: "Private",
        url: "https://models.example/ckm/rest/",
        token: "alice-ckm",
    }).connection.id;
    const result = await connections.ckm("alice", { source, kind: "archetypes", keyword: "renal care" });
    assert.equal(result.content[0].cid, "123.4.5");
    assert.match(calls[0].url, /search-text=renal\+care/);
    assert.equal(calls[0].token, "alice-ckm");
    assert.doesNotMatch(JSON.stringify(result), /alice-ckm/);
    await connections.ckm("alice", { source, kind: "templates", cid: "123.4.5" });
    assert.match(calls[1].url, /v1\/templates\/123.4.5\/oet$/);
    await assert.rejects(connections.ckm("bob", { source, kind: "archetypes", keyword: "renal" }), /not found/);
    await assert.rejects(connections.ckm("alice", { source, kind: "archetypes", cid: "../secrets" }));
    assert.equal(calls.length, 2);
});

for (const kind of ["github", "gitlab"])
    test(`${kind} saves use the exact branch, owner token and revision and refuse stale updates`, async (t) => {
        const calls = [],
            revision = "a".repeat(40);
        const { connections } = setup(t, async (url, options) => {
            calls.push({ url, ...options });
            return {
                status: 200,
                text: options.method
                    ? "{}"
                    : JSON.stringify({
                          type: "file",
                          encoding: "base64",
                          content: Buffer.from("old draft").toString("base64"),
                          sha: revision,
                          last_commit_id: revision,
                      }),
            };
        });
        const repo = connections.add("alice", {
            ...github,
            kind,
            url: kind === "github" ? github.url : "https://gitlab.com/team/subgroup/models",
        }).connection;
        const args = {
            repository: repo.id,
            path: "templates/kidney.oet",
            content: "<template/>",
            message: "Draft renal care",
            expectedRevision: revision,
        };
        await assert.rejects(connections.publish("bob", args), /not found/);
        await assert.rejects(connections.publish("alice", { ...args, expectedRevision: null }), /changed/);
        assert.equal(calls.filter((call) => call.method).length, 0);
        const saved = await connections.publish("alice", args);
        assert.equal(saved.status, "DRAFT");
        const write = calls.at(-1);
        assert.equal(write.token, "private-test-token");
        assert.equal(write.body.branch, "draft/renal");
        assert.equal(kind === "github" ? write.body.sha : write.body.actions[0].last_commit_id, revision);
        assert.match(
            write.url,
            kind === "github"
                ? /api.github.com\/repos\/alice\/models\/contents\/templates\/kidney.oet$/
                : /api\/v4\/projects\/team%2Fsubgroup%2Fmodels\/repository\/commits$/,
        );
        for (const path of [
            "../bad.xml",
            ".github/workflows/test.yml",
            "a/../bad.xml",
            "a//b.xml",
            "script.js",
            "file.constructor",
            "aql",
        ])
            await assert.rejects(connections.publish("alice", { ...args, path }));
    });

test("text, PDF and spreadsheets are extracted with exact originals and explicit binary/partial status", async (t) => {
    const { attachments, store, directory } = setup(t);
    const conversation = store.create("alice");
    const item = await attachments.add(
        "alice",
        conversation,
        "renal.csv",
        Buffer.from("field,unit\ncreatinine,mmol/L\n"),
    );
    assert.equal(item.status, "ready");
    assert.match(attachments.read("alice", conversation, { attachment: item.id }).text, /creatinine/);
    assert.equal(attachments.bytes("alice", conversation, item.id).toString(), "field,unit\ncreatinine,mmol/L\n");
    assert.throws(() => attachments.read("alice", store.create("alice"), { attachment: item.id }), /not found/);
    const binary = await attachments.add("alice", conversation, "image.bin", Buffer.from([0, 1, 2, 255]));
    assert.equal(binary.status, "unsupported");
    assert.equal(binary.characters, 0);
    const long = await attachments.add("alice", conversation, "long.txt", Buffer.from("a".repeat(250000)));
    assert.equal(long.status, "partial");
    assert.equal(attachments.read("alice", conversation, { attachment: long.id }).nextOffset, 12000);
    assert.throws(() => attachments.read("alice", conversation, { attachment: item.id, offset: -1 }));
    for (const bookType of ["xlsx", "xls", "ods"]) {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            book,
            XLSX.utils.aoa_to_sheet([
                ["Requirement", "Unit"],
                ["Urine volume", "mL"],
            ]),
            "Renal evidence",
        );
        const path = join(directory, "sheet." + bookType);
        writeFileSync(path, XLSX.write(book, { type: "buffer", bookType }));
        const result = await extractFile(path, "sheet." + bookType);
        assert.equal(result.status, "ready", result.note);
        assert.match(result.text, /Renal evidence[\s\S]*Urine volume/);
    }
    const pdfPath = join(directory, "publication.pdf");
    const pdf = sourcePdf();
    writeFileSync(pdfPath, pdf);
    const extractedPdf = await extractFile(pdfPath, "publication.pdf");
    assert.equal(extractedPdf.status, "ready", extractedPdf.note);
    assert.match(extractedPdf.text, /\[Page 1\][\s\S]*Renal publication evidence/);
    writeFileSync(pdfPath, Buffer.concat([Buffer.from("\ufeff"), pdf]));
    const prefixedPdf = await extractFile(pdfPath, "publication.PDF");
    assert.equal(prefixedPdf.status, "ready", prefixedPdf.note);
    assert.match(prefixedPdf.text, /Renal publication evidence/);
    writeFileSync(pdfPath, "not a PDF");
    const brokenPdf = await extractFile(pdfPath, "publication.pdf");
    assert.equal(brokenPdf.status, "failed");
    assert.match(brokenPdf.note, /PDF could not be read/);
    const docx = await extractFile(fileURLToPath(new URL("./fixtures/source.docx", import.meta.url)), "source.docx");
    assert.equal(docx.status, "ready", docx.note);
    assert.match(docx.text, /Synthetic renal care requirements/);
    const dir = attachments.directory("alice", conversation.id);
    store.delete("alice", conversation.id);
    assert.equal(existsSync(dir), false);
});

test("share snapshots omit originals, remain fixed, and expire on revocation, deletion and retention", (t) => {
    const { store, shares } = setup(t);
    const conversation = store.create("alice");
    conversation.messages = [{ role: "user", content: "Draft requirements", tools: [{ token: "never-share" }] }];
    conversation.attachments = [{ name: "private.pdf", id: "private" }];
    const link = shares.create("alice", conversation);
    conversation.messages.push({ role: "assistant", content: "Later message" });
    store.save("alice", conversation);
    assert.equal(shares.get(link.token).messages.length, 1);
    assert.doesNotMatch(JSON.stringify(shares.get(link.token)), /private.pdf|never-share|Later message/);
    shares.revoke("alice", conversation);
    assert.throws(() => shares.get(link.token), /not found/);
    const next = shares.create("alice", conversation);
    store.delete("alice", conversation.id);
    assert.throws(() => shares.get(next.token), /not found/);
    const stale = store.create("alice"),
        staleLink = shares.create("alice", stale);
    const old = new Date(Date.now() - 31 * 86400000);
    utimesSync(store.path("alice", stale.id), old, old);
    assert.throws(() => shares.get(staleLink.token), /not found/);
});

test("selecting a personal repository disables enterprise writes and cannot publish to a different repository", async (t) => {
    const f = setup(t);
    const repo = f.connections.add("alice", github).connection;
    const conversation = f.store.create("alice");
    conversation.repository = repo.id;
    const workspace = new WorkspaceTools(
        { tools: async () => [{ name: "model_artifact_save" }, { name: "model_validate" }] },
        f.connections,
        f.attachments,
        "alice",
        conversation,
        new AbortController().signal,
        true,
    );
    const tools = await workspace.tools();
    assert.equal(
        tools.some((t) => t.name === "model_artifact_save"),
        false,
    );
    assert.equal(
        tools.some((t) => t.name === "personal_repository_save"),
        true,
    );
    await assert.rejects(
        workspace.call("personal_repository_save", {
            repository: "someone-else",
            path: "draft.xml",
            content: "draft",
            message: "draft",
            expectedRevision: null,
        }),
        /selected repository/,
    );
    assert.match(workspace.context([{ role: "user", content: "Make a model" }])[0].content, /draft\/renal/);
    assert.doesNotMatch(
        JSON.stringify(workspace.context([{ role: "user", content: "Make a model" }])),
        /private-test-token/,
    );
});

async function httpFixture(t, run, requestRemote, callModel) {
    const f = setup(t, requestRemote);
    const auth = new Auth(f.config);
    for (const identity of ["alice", "bob"])
        auth.sessions.set(identity, { identity, name: identity, csrf: identity, expires: Date.now() + 60000 });
    const server = createApplication(f.config, {
        ...f,
        auth,
        provider: { run },
        mcpFactory: () => ({
            tools: async () => [],
            call:
                callModel ||
                (async () => ({ structuredContent: { sources: { default: "https://ckm.example/rest/" } } })),
        }),
    });
    server.connectionsCheckingInterval = 100;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    f.config.origin = "http://127.0.0.1:" + server.address().port;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const request = (path, { method = "GET", user = "alice", data, bytes, csrf = true, name = "evidence.csv" } = {}) =>
        fetch(f.config.origin + "/chat/api/" + path, {
            method,
            headers: {
                ...(user ? { Cookie: "ModellingSession=" + user } : {}),
                Origin: f.config.origin,
                ...(csrf ? { "X-CSRF-Token": user } : {}),
                "Content-Type": bytes ? "application/octet-stream" : "application/json",
                "X-File-Name": encodeURIComponent(name),
            },
            body: bytes || (data === undefined ? undefined : JSON.stringify(data)),
        });
    return { ...f, request };
}

test(
    "a 5.8 MiB PDF upload can finish after thirty seconds without an empty HTTP timeout",
    { timeout: 45000 },
    async (t) => {
        const f = await httpFixture(t, async () => "Draft");
        const chat = await (await f.request("conversations", { method: "POST", data: { provider: "codex" } })).json();
        const bytes = sourcePdf(Math.floor(5.8 * 1024 * 1024));
        const result = await new Promise((resolve, reject) => {
            const req = httpRequest(
                f.config.origin + "/chat/api/conversations/" + chat.id + "/attachments",
                {
                    method: "POST",
                    headers: {
                        Cookie: "ModellingSession=alice",
                        Origin: f.config.origin,
                        "X-CSRF-Token": "alice",
                        "Content-Type": "application/octet-stream",
                        "Content-Length": bytes.length,
                        "X-File-Name": "large-publication.pdf",
                    },
                },
                (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(chunk));
                    response.on("end", () =>
                        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
                    );
                },
            );
            req.on("error", reject);
            req.write(bytes.subarray(0, bytes.length / 2));
            const timer = setTimeout(() => req.end(bytes.subarray(Math.floor(bytes.length / 2))), 31000);
            t.after(() => {
                clearTimeout(timer);
                req.destroy();
            });
        });
        assert.equal(result.status, 201, result.body);
        const item = JSON.parse(result.body);
        assert.equal(item.status, "ready", item.note);
        assert.equal(item.size, bytes.length);
        const saved = f.store.get("alice", chat.id);
        assert.deepEqual(f.attachments.bytes("alice", saved, item.id), bytes);
        assert.match(f.attachments.read("alice", saved, { attachment: item.id }).text, /Renal publication evidence/);
    },
);

test("repository creation is owner-scoped and stale message destinations never reach the provider", async (t) => {
    let calls = 0;
    const f = await httpFixture(t, async ({ messages, callTool }) => {
        calls++;
        const { structuredContent: context } = await callTool("personal_connections", {});
        assert.equal(context.selectedRepository, repo.id);
        assert.match(messages.at(-1).content, /github.com\/alice\/models/);
        return "Selected repository confirmed";
    });
    const repo = f.connections.add("alice", github).connection;
    assert.equal(
        (await f.request("conversations", { method: "POST", user: "bob", data: { repository: repo.id } })).status,
        404,
    );
    assert.equal(f.store.list("bob").length, 0);
    const created = await f.request("conversations", { method: "POST", data: { repository: repo.id } });
    assert.equal(created.status, 201);
    const conversation = await created.json();
    assert.equal(f.store.get("alice", conversation.id).repository, repo.id);
    const path = "conversations/" + conversation.id + "/messages";
    const stale = await f.request(path, { method: "POST", data: { content: "Save these drafts", repository: null } });
    assert.equal(stale.status, 409);
    assert.equal(calls, 0);
    assert.equal(f.store.get("alice", conversation.id).messages.length, 0);
    const response = await f.request(path, {
        method: "POST",
        data: { content: "Save these drafts", repository: repo.id },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(f.store.get("alice", conversation.id).messages.at(-1).content, "Selected repository confirmed");
    assert.equal(calls, 1);
});

test("HTTP uploads feed the provider through tools, enforce ownership/CSRF, and sharing remains read-only", async (t) => {
    let attachmentId;
    const f = await httpFixture(t, async ({ messages, callTool }) => {
        assert.match(messages.at(-1).content, /evidence.csv/);
        const result = await callTool("attachment_read", { attachment: attachmentId });
        assert.match(result.structuredContent.text, /renal/);
        return "Source-grounded draft";
    });
    const conversation = f.store.create("alice"),
        base = "conversations/" + conversation.id;
    const bytes = Buffer.from("concept\nrenal");
    assert.equal((await f.request(base + "/attachments", { method: "POST", bytes, csrf: false })).status, 403);
    assert.equal((await f.request(base + "/attachments", { method: "POST", bytes, user: "bob" })).status, 404);
    const added = await f.request(base + "/attachments", { method: "POST", bytes });
    assert.equal(added.status, 201);
    attachmentId = (await added.json()).id;
    assert.equal((await f.request(base + "/attachments/" + attachmentId, { user: "bob" })).status, 404);
    assert.deepEqual(Buffer.from(await (await f.request(base + "/attachments/" + attachmentId)).arrayBuffer()), bytes);
    const turn = await f.request(base + "/messages", { method: "POST", data: { content: "Model these requirements" } });
    assert.match(await turn.text(), /"type":"done"/);
    const link = await (await f.request(base + "/share", { method: "POST", data: {} })).json();
    assert.equal((await f.request("shares/" + link.token, { user: "" })).status, 401);
    const snapshot = await (await f.request("shares/" + link.token, { user: "bob" })).json();
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.attachments, undefined);
    assert.equal((await f.request(base + "/share", { method: "DELETE", user: "bob" })).status, 404);
    await f.request(base + "/share", { method: "DELETE" });
    assert.equal((await f.request("shares/" + link.token, { user: "bob" })).status, 404);
});

test("personal commits wait for owner confirmation of the destination and cannot execute after cancellation", async (t) => {
    let repository;
    const writes = [];
    const f = await httpFixture(
        t,
        async ({ callTool }) => {
            await callTool("personal_repository_save", {
                repository,
                path: "AKI/templates/opt/renal.opt",
                content: "<draft/>",
                message: "Draft renal model",
                expectedRevision: null,
            });
            return "Committed draft";
        },
        async (url, options) => {
            if (options.method) {
                writes.push({ url, ...options });
                return { status: 201, text: "{}" };
            }
            return { status: 404, text: "{}" };
        },
    );
    repository = f.connections.add("alice", github).connection.id;
    for (const approved of [false, true]) {
        const conversation = f.store.create("alice");
        conversation.repository = repository;
        conversation.folder = "AKI";
        f.store.save("alice", conversation);
        const base = "conversations/" + conversation.id;
        const response = await f.request(base + "/messages", { method: "POST", data: { content: "Save this draft" } });
        const reader = response.body.getReader();
        let content = "",
            approval;
        while (!approval) {
            const part = await reader.read();
            assert.equal(part.done, false);
            content += new TextDecoder().decode(part.value);
            for (const line of content.split("\n"))
                if (line.startsWith("data: ")) {
                    const event = JSON.parse(line.slice(6));
                    if (event.type === "approval") approval = event;
                }
        }
        assert.equal(writes.length, 0);
        assert.equal(approval.arguments.destination.url, "https://github.com/alice/models");
        assert.equal(approval.arguments.destination.branch, "draft/renal");
        assert.doesNotMatch(JSON.stringify(approval), /private-test-token/);
        assert.equal(
            (
                await f.request(base + "/approval", {
                    user: "bob",
                    method: "POST",
                    data: { id: approval.id, approved: true },
                })
            ).status,
            404,
        );
        assert.equal(
            (await f.request(base + "/approval", { method: "POST", data: { id: approval.id, approved } })).status,
            200,
        );
        while (!(await reader.read()).done) {
            /* Drain the turn so persistence and cleanup finish. */
        }
        assert.equal(writes.length, approved ? 1 : 0);
        const saved = f.store.get("alice", conversation.id);
        assert.equal(saved.artifacts?.length || 0, approved ? 1 : 0);
        if (approved) {
            assert.equal(saved.artifacts[0].path, "AKI/templates/opt/renal.opt");
            assert.deepEqual(saved.artifacts[0].destination, {
                kind: "github",
                url: "https://github.com/alice/models",
                branch: "draft/renal",
            });
            assert.doesNotMatch(JSON.stringify(saved.artifacts), /private-test-token/);
        }
    }
});

test("an in-flight extraction blocks conflicting conversation mutations", async (t) => {
    const f = await httpFixture(t, async () => "Draft");
    let started, finish;
    const waiting = new Promise((resolve) => (started = resolve));
    f.attachments.extractor = () => {
        started();
        return new Promise((resolve) => (finish = resolve));
    };
    const conversation = f.store.create("alice"),
        base = "conversations/" + conversation.id;
    const upload = f.request(base + "/attachments", { method: "POST", bytes: Buffer.from("source") });
    await waiting;
    for (const [path, method, data] of [
        [base, "DELETE"],
        [base + "/messages", "POST", { content: "draft" }],
        [base + "/settings", "PUT", { repository: null }],
        [base + "/share", "POST", {}],
    ]) {
        assert.equal((await f.request(path, { method, data })).status, 409);
    }
    finish({ text: "source", status: "ready", note: "Extracted" });
    assert.equal((await upload).status, 201);
    assert.equal(f.store.get("alice", conversation.id).attachments.length, 1);
});

test("PNG and JPEG are prepared for vision while originals, limits and metadata remain protected", async (t) => {
    const { attachments, store, directory } = setup(t);
    const conversation = store.create("alice");
    for (const format of ["png", "jpeg"]) {
        const bytes = await sharp({ create: { width: 2600, height: 100, channels: 3, background: "#f0f4ff" } })
            .withExif({ IFD0: { Artist: "Private source metadata" } })
            [format]()
            .toBuffer();
        const item = await attachments.add("alice", conversation, "source." + format, bytes);
        assert.equal(item.status, "image");
        assert.equal(item.image.width, 2048);
        assert.equal(item.image.mimeType, "image/jpeg");
        assert.deepEqual(attachments.bytes("alice", conversation, item.id), bytes);
        const preview = attachments.preview("alice", conversation, item.id);
        const metadata = await sharp(preview).metadata();
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.format, "jpeg");
        assert.equal(attachments.images("alice", conversation).at(-1).data, preview.toString("base64"));
        assert.doesNotMatch(JSON.stringify(store.get("alice", conversation.id)), /Private source metadata|"data":/);
        assert.ok(existsSync(join(attachments.directory("alice", conversation.id), item.id + ".image.jpg")));
    }
    const invalid = await attachments.add("alice", conversation, "fake.png", Buffer.from("<svg>not a PNG</svg>"));
    assert.equal(invalid.status, "failed");
    assert.throws(() => attachments.preview("alice", conversation, invalid.id), /not found/);
    const oversized = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: "white" } })
        .png()
        .toBuffer();
    const limited = await attachments.add("alice", conversation, "too-many-pixels.png", oversized);
    assert.equal(limited.status, "failed");
    assert.equal(attachments.images("alice", conversation).length, 2);
    const first = conversation.attachments[0];
    attachments.remove("alice", conversation, first.id);
    assert.equal(existsSync(join(attachments.directory("alice", conversation.id), first.id + ".image.jpg")), false);
    assert.equal(attachments.images("alice", conversation).length, 1);
    store.delete("alice", conversation.id);
    assert.equal(existsSync(join(directory, "conversations", store.owner("alice"), conversation.id)), false);
});

test("HTTP image previews and vision inputs remain owner-bound, follow later turns and exclude shared originals", async (t) => {
    let calls = 0;
    const f = await httpFixture(t, async ({ images, messages }) => {
        calls++;
        assert.equal(images.length, calls < 3 ? 1 : 0);
        if (images.length) {
            assert.equal(images[0].name, "clinical-note.png");
            assert.equal(images[0].mimeType, "image/jpeg");
            assert.equal((await sharp(Buffer.from(images[0].data, "base64")).metadata()).format, "jpeg");
            assert.match(messages.at(-1).content, /clinical-note.png/);
        }
        return "Synthetic image source checked";
    });
    const conversation = f.store.create("alice"),
        base = "conversations/" + conversation.id;
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: "white" } })
        .png()
        .toBuffer();
    const upload = await f.request(base + "/attachments", { method: "POST", name: "clinical-note.png", bytes });
    assert.equal(upload.status, 201);
    const item = await upload.json();
    const path = base + "/attachments/" + item.id;
    const preview = await f.request(path + "/preview");
    assert.equal(preview.headers.get("content-type"), "image/jpeg");
    assert.equal(preview.headers.get("cache-control"), "no-store");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await f.request(path + "/preview", { user: "bob" })).status, 404);
    assert.equal((await f.request(path + "/preview", { user: "" })).status, 401);
    assert.equal((await f.request(path + "/preview", { method: "DELETE" })).status, 404);
    for (const content of ["Read the image", "Use it for a draft"]) {
        const response = await f.request(base + "/messages", { method: "POST", data: { content } });
        assert.match(await response.text(), /"type":"done"/);
    }
    const saved = f.store.get("alice", conversation.id);
    assert.equal(saved.messages[0].attachments[0].id, item.id);
    assert.equal(saved.messages[2].attachments, undefined);
    assert.doesNotMatch(JSON.stringify(saved), /"data":/);
    const link = await (await f.request(base + "/share", { method: "POST", data: {} })).json();
    const snapshot = await (await f.request("shares/" + link.token, { user: "bob" })).json();
    assert.equal(snapshot.messages[0].attachments, undefined);
    assert.equal((await f.request(path, { method: "DELETE" })).status, 200);
    assert.equal((await f.request(path + "/preview")).status, 404);
    await (
        await f.request(base + "/messages", { method: "POST", data: { content: "Continue without the image" } })
    ).text();
    assert.equal(calls, 3);
});

test("interactive choices require the owner, valid options and CSRF, persist answers and reject replay", async (t) => {
    const answers = [];
    const f = await httpFixture(t, async ({ callTool }) => {
        const result = await callTool("request_user_choice", {
            question: "What is the intended use?",
            options: ["Clinical documentation", "AKI detection/staging", "Prediction-model dataset"],
        });
        answers.push(result.structuredContent);
        return "Decision received";
    });
    for (const stop of [false, true]) {
        const conversation = f.store.create("alice"),
            base = "conversations/" + conversation.id;
        const response = await f.request(base + "/messages", { method: "POST", data: { content: "Plan a template" } });
        const reader = response.body.getReader();
        let buffer = "",
            question;
        while (!question) {
            const part = await reader.read();
            assert.equal(part.done, false);
            buffer += new TextDecoder().decode(part.value);
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith("data: ")) {
                    const event = JSON.parse(frame.slice(6));
                    if (event.type === "choice") question = event;
                }
            }
        }
        const data = { id: question.id, selected: ["Clinical documentation"] };
        assert.equal((await f.request(base + "/choice", { method: "POST", user: "bob", data })).status, 404);
        assert.equal((await f.request(base + "/choice", { method: "POST", csrf: false, data })).status, 403);
        for (const selected of [[], ["unknown"], question.options.slice(0, 2)])
            assert.equal(
                (await f.request(base + "/choice", { method: "POST", data: { ...data, selected } })).status,
                400,
            );
        assert.equal(answers.length, stop ? 1 : 0);
        if (stop) await f.request(base + "/stop", { method: "POST" });
        else assert.equal((await f.request(base + "/choice", { method: "POST", data })).status, 200);
        while (!(await reader.read()).done) {
            /* Wait for persistence and turn cleanup. */
        }
        assert.equal((await f.request(base + "/choice", { method: "POST", data })).status, 409);
        assert.equal(answers.at(-1).cancelled, stop);
        const messages = f.store.get("alice", conversation.id).messages;
        assert.equal(messages.filter((message) => message.role === "user").length, stop ? 1 : 2);
        if (!stop) assert.match(messages[1].content, /My choice.*Clinical documentation/);
    }
});

test("private chat projects create, rename, group, move and safely remove conversations", async (t) => {
    const f = await httpFixture(t, async () => "Draft");
    assert.equal(
        (await f.request("projects", { method: "POST", csrf: false, data: { name: "Kidney care" } })).status,
        403,
    );
    const created = await f.request("projects", { method: "POST", data: { name: " Kidney care " } });
    assert.equal(created.status, 201);
    const project = await created.json();
    assert.equal(project.name, "Kidney care");
    assert.deepEqual((await (await f.request("projects", { user: "bob" })).json()).projects, []);
    for (const method of ["PUT", "DELETE"])
        assert.equal(
            (
                await f.request("projects/" + project.id, {
                    user: "bob",
                    method,
                    ...(method === "PUT" ? { data: { name: "Stolen" } } : {}),
                })
            ).status,
            404,
        );
    assert.equal((await f.request("projects", { method: "POST", data: { name: "kidney care" } })).status, 409);
    for (const name of ["", "a".repeat(81), "bad\nname"])
        assert.equal((await f.request("projects", { method: "POST", data: { name } })).status, 400);
    const repository = f.connections.add("alice", github).connection.id;
    assert.equal(
        (await f.request("conversations", { method: "POST", user: "bob", data: { project: project.id } })).status,
        404,
    );
    const chat = await (
        await f.request("conversations", { method: "POST", data: { project: project.id, repository } })
    ).json();
    const base = "conversations/" + chat.id;
    const source = await (
        await f.request(base + "/attachments", { method: "POST", bytes: Buffer.from("field\ncreatinine") })
    ).json();
    const turn = await f.request(base + "/messages", { method: "POST", data: { content: "Keep my evidence" } });
    await turn.text();
    const before = f.store.get("alice", chat.id);
    await f.request("projects/" + project.id, { method: "PUT", data: { name: "Renal models" } });
    assert.equal(f.store.projects("alice")[0].name, "Renal models");
    const second = await (await f.request("projects", { method: "POST", data: { name: "Research" } })).json();
    const moved = await (await f.request(base + "/settings", { method: "PUT", data: { project: second.id } })).json();
    assert.equal(moved.project, second.id);
    assert.equal(moved.repository, repository);
    assert.deepEqual(moved.messages, before.messages);
    assert.deepEqual(moved.attachments, before.attachments);
    await f.request(base + "/settings", { method: "PUT", data: { repository: null } });
    assert.equal(f.store.get("alice", chat.id).project, second.id);
    assert.equal((await f.request(base + "/settings", { method: "PUT", data: { project: "../outside" } })).status, 404);
    const listed = await (await f.request("conversations")).json();
    assert.equal(listed.conversations[0].project, second.id);
    assert.equal(listed.projects.length, 2);
    const reloaded = new Store(f.store.directory);
    assert.equal(reloaded.projects("alice").length, 2);
    assert.equal(reloaded.get("alice", chat.id).project, second.id);
    assert.equal((await f.request("projects/" + second.id, { method: "DELETE" })).status, 200);
    const unfiled = f.store.get("alice", chat.id);
    assert.equal(unfiled.project, null);
    assert.deepEqual(unfiled.messages, before.messages);
    assert.deepEqual(f.attachments.bytes("alice", unfiled, source.id), Buffer.from("field\ncreatinine"));
    assert.equal((await f.request(base + "/settings", { method: "PUT", data: { project: second.id } })).status, 404);
});

test("chat project moves and removal cannot race an active response", async (t) => {
    const f = await httpFixture(
        t,
        async ({ signal }) =>
            new Promise((resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
            ),
    );
    const project = f.store.saveProject("alice", "Protected");
    const conversation = f.store.create("alice", "codex", null, project.id);
    const base = "conversations/" + conversation.id;
    const turn = await f.request(base + "/messages", { method: "POST", data: { content: "Wait" } });
    assert.equal((await f.request(base + "/settings", { method: "PUT", data: { project: null } })).status, 409);
    assert.equal((await f.request("projects/" + project.id, { method: "DELETE" })).status, 409);
    await f.request(base + "/stop", { method: "POST" });
    await turn.text();
    assert.equal(f.store.get("alice", conversation.id).project, project.id);
});

test("project and profile destinations persist privately and existing chats keep their folder", async (t) => {
    const f = await httpFixture(t, async () => "Ready");
    const repository = f.connections.add("alice", github).connection.id;
    const otherRepository = f.connections.add("bob", github).connection.id;
    const projectResponse = await f.request("projects", { method: "POST", data: { name: "AKI", repository } });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    assert.equal(project.folder, "AKI");
    const enterprise = f.store.saveProject("alice", "Enterprise", null, { repository: null });
    f.store.saveDestination("alice", repository, "Temporary");
    f.store.saveProject("alice", "Enterprise renamed", enterprise.id);
    assert.equal(f.store.project("alice", enterprise.id).repository, null);
    f.store.deleteProject("alice", enterprise.id);

    for (const data of [
        { name: "Forbidden", repository: otherRepository },
        { name: "Escape", folder: "../AKI" },
    ]) {
        const response = await f.request("projects", { method: "POST", data });
        assert.ok([400, 404].includes(response.status));
    }
    assert.equal(f.store.projects("alice").length, 1);
    assert.deepEqual(f.store.destination("bob"), { repository: null, folder: "" });
    const created = await (await f.request("conversations", { method: "POST", data: { project: project.id } })).json();
    assert.equal(created.repository, repository);
    assert.equal(created.folder, "AKI");
    const base = "conversations/" + created.id;
    assert.equal(
        (await f.request(base + "/settings", { method: "PUT", csrf: false, data: { folder: "Other" } })).status,
        403,
    );
    assert.equal(
        (await f.request(base + "/settings", { method: "PUT", user: "bob", data: { folder: "Other" } })).status,
        404,
    );
    for (const folder of [
        "../AKI",
        "/AKI",
        ".github",
        "AKI/../other",
        "AKI//other",
        "AKI/.hidden",
        "AKI\\other",
        "x".repeat(201),
    ])
        assert.equal((await f.request(base + "/settings", { method: "PUT", data: { folder } })).status, 400, folder);
    const saved = await f.request(base + "/settings", { method: "PUT", data: { repository, folder: "Renal/AKI" } });
    assert.equal(saved.status, 200);
    const reloaded = new Store(f.store.directory);
    assert.deepEqual(reloaded.destination("alice"), { repository, folder: "Renal/AKI" });
    assert.deepEqual(reloaded.destination("alice", project.id), { repository, folder: "Renal/AKI" });
    const next = await (await f.request("conversations", { method: "POST", data: {} })).json();
    assert.equal(next.repository, repository);
    assert.equal(next.folder, "Renal/AKI");
    await f.request("projects/" + project.id, { method: "PUT", data: { name: "Renal care", folder: "New/AKI" } });
    assert.equal(f.store.get("alice", created.id).folder, "Renal/AKI");
    const projectChat = await (
        await f.request("conversations", { method: "POST", data: { project: project.id } })
    ).json();
    assert.equal(projectChat.folder, "New/AKI");
    assert.equal(
        (await f.request(base + "/messages", { method: "POST", data: { content: "Save", repository, folder: "AKI" } }))
            .status,
        409,
    );
    assert.equal(f.store.get("alice", created.id).messages.length, 0);
    await f.request("projects/" + project.id, { method: "DELETE" });
    assert.equal(f.store.get("alice", created.id).project, null);
    assert.equal(f.store.get("alice", created.id).folder, "Renal/AKI");
});

test("personal save discovery explains readiness and enforces the folder before any write", async (t) => {
    const remote = [];
    const f = setup(t, async (url, options) => {
        remote.push({ url, ...options });
        return { status: options.method ? 201 : 404, text: "{}" };
    });
    const repository = f.connections.add("alice", github).connection.id;
    const conversation = f.store.create("alice");
    const workspace = new WorkspaceTools(
        { tools: async () => [] },
        f.connections,
        f.attachments,
        "alice",
        conversation,
        AbortSignal.timeout(5000),
        true,
    );
    assert.ok((await workspace.tools()).some((tool) => tool.name === "personal_repository_save"));
    assert.match(
        (await workspace.call("personal_connections", {})).structuredContent.saveStatus.reason,
        /No personal repository selected/,
    );
    const args = {
        repository,
        path: "AKI/templates/opt/AKI_clinical_documentation.opt",
        content: "<template/>",
        expectedRevision: null,
        message: "Synthetic draft",
    };
    await assert.rejects(workspace.call("personal_repository_save", args), /No personal repository selected/);
    conversation.repository = repository;
    conversation.folder = "AKI";
    const status = (await workspace.call("personal_connections", {})).structuredContent.saveStatus;
    assert.equal(status.ready, true);
    assert.equal(status.folder, "AKI");
    for (const path of ["Other/template.opt", "AKI-other/template.opt", "AKI/../template.opt", ".github/draft.xml"])
        await assert.rejects(workspace.call("personal_repository_save", { ...args, path }));
    await assert.rejects(workspace.call("model_artifact_save", args), /Enterprise writes are unavailable/);
    assert.equal(remote.length, 0);
    const saved = (await workspace.call("personal_repository_save", args)).structuredContent;
    assert.equal(saved.saved, true);
    assert.equal(saved.path, args.path);
    assert.equal(remote.filter((call) => call.method).length, 1);
    assert.match(remote.at(-1).url, /\/contents\/AKI\/templates\/opt\/AKI_clinical_documentation.opt$/);
    conversation.repository = f.connections.add("alice", {
        ...github,
        url: "https://github.com/alice/public",
        token: undefined,
    }).connection.id;
    assert.match(workspace.saveStatus().reason, /Add a token/);
    workspace.allowWrites = false;
    assert.equal(
        (await workspace.tools()).some((tool) => tool.name === "personal_repository_save"),
        false,
    );
    assert.match(workspace.saveStatus().reason, /disabled/);
    assert.doesNotMatch(JSON.stringify(workspace.saveStatus()), /private-test-token/);
});

test("GitHub save refusals explain token permissions, persist privately and clear on an explicit access update", async (t) => {
    const f = setup(t, async (url, options) =>
        options.method
            ? {
                  status: 403,
                  text: JSON.stringify({ message: "Resource not accessible by personal access token private-secret" }),
              }
            : { status: 404, text: "{}" },
    );
    const connection = f.connections.add("alice", github).connection;
    const args = {
        repository: connection.id,
        path: "AKI/templates/oet/draft.oet",
        content: "<template/>",
        message: "Draft",
        expectedRevision: null,
    };
    await assert.rejects(
        f.connections.publish("alice", args),
        (error) =>
            error.accessCode === "GITHUB_CONTENTS_WRITE_REQUIRED" &&
            /Contents: Read and write/.test(error.message) &&
            !error.message.includes("private-secret"),
    );
    const workspace = new WorkspaceTools(
        {},
        f.connections,
        f.attachments,
        "alice",
        { repository: connection.id },
        new AbortController().signal,
        true,
    );
    assert.equal(workspace.saveStatus().ready, false);
    assert.match(workspace.saveStatus().reason, /Save connection/);
    assert.deepEqual(f.connections.list("bob"), []);
    assert.doesNotMatch(JSON.stringify(f.connections.list("alice")), /private-secret|private-test-token/);
    const updated = f.connections.add("alice", { ...github, token: undefined });
    assert.equal(updated.connection.id, connection.id);
    assert.equal(updated.updated, true);
    assert.equal(updated.connection.lastWriteError, undefined);
    assert.equal(f.connections.get("alice", connection.id).token, github.token);
    assert.equal(workspace.saveStatus().ready, true);
});

test("GitHub diagnostics separate rate limits, invalid credentials and protected branches without reflecting error bodies", async (t) => {
    for (const [status, message, pattern, code] of [
        [401, "Bad credentials private-secret", /valid token/, "GITHUB_TOKEN_INVALID"],
        [403, "API rate limit exceeded private-secret", /temporarily limited/, undefined],
        [
            422,
            "Changes must be made through a pull request. private-secret",
            /permitted branch/,
            "GITHUB_BRANCH_RESTRICTED",
        ],
    ]) {
        const f = setup(t, async () => ({ status, text: JSON.stringify({ message }) }));
        await assert.rejects(
            f.connections.remote(
                { kind: "github", url: "https://api.github.com/repos/alice/models", token: "private-token" },
                "/contents/draft.oet",
                { method: "PUT", body: {} },
            ),
            (error) =>
                pattern.test(error.message) && error.accessCode === code && !error.message.includes("private-secret"),
        );
    }
});

test("a failed request using an old token cannot invalidate a concurrently updated connection", async (t) => {
    let f;
    f = setup(t, async (url, options) => {
        if (!options.method) return { status: 404, text: "{}" };
        f.connections.add("alice", { ...github, token: "replacement-token" });
        return { status: 403, text: '{"message":"Resource not accessible by personal access token"}' };
    });
    const connection = f.connections.add("alice", github).connection;
    await assert.rejects(
        f.connections.publish("alice", {
            repository: connection.id,
            path: "draft.oet",
            content: "<template/>",
            message: "Draft",
            expectedRevision: null,
        }),
    );
    assert.equal(f.connections.get("alice", connection.id).token, "replacement-token");
    assert.equal(f.connections.list("alice")[0].lastWriteError, undefined);
});

test("template package confirmation covers all files and records every dependency for project moves", async (t) => {
    let repository,
        writes = 0;
    const dependency = { identifier: "openEHR-EHR-COMPOSITION.fixture.v1", content: "exact fixture ADL" };
    const f = await httpFixture(
        t,
        async ({ callTool }) => {
            await callTool("personal_repository_save", {
                repository,
                path: "AKI/templates/oet/fixture.oet",
                content: "<template/>",
                expectedRevision: null,
                message: "Save package",
                dependencies: [dependency],
            });
            return "Complete package saved";
        },
        async (url) => ({
            status: 200,
            text: JSON.stringify(url.includes("/git/ref/") ? { object: { sha: "b".repeat(40) } } : { tree: [] }),
        }),
        async () => ({
            structuredContent: {
                success: true,
                result: {
                    valid: true,
                    dependencies: [
                        {
                            identifier: dependency.identifier,
                            sha256: createHash("sha256").update(dependency.content).digest("hex"),
                        },
                    ],
                    output: { sha256: "a".repeat(64) },
                },
            },
        }),
    );
    repository = f.connections.add("alice", github).connection.id;
    f.connections.prepareBundle = async (identity, args, files) => {
        assert.equal(identity, "alice");
        return {
            base: "b".repeat(40),
            files: files.map((file) => ({ ...file, dependency: !!file.dependency, changed: true })),
        };
    };
    f.connections.publish = async (identity, args, signal, plan) => {
        assert.equal(plan.files.length, 3);
        writes++;
        return { saved: true, commit: "c".repeat(40), files: plan.files };
    };
    const conversation = f.store.create("alice", "codex", repository, null, "AKI");
    const base = "conversations/" + conversation.id;
    const response = await f.request(base + "/messages", {
        method: "POST",
        data: { content: "Save this template package" },
    });
    const reader = response.body.getReader();
    let text = "",
        approval;
    while (!approval) {
        const part = await reader.read();
        assert.equal(part.done, false);
        text += new TextDecoder().decode(part.value);
        approval = text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((event) => event.type === "approval");
    }
    assert.equal(writes, 0);
    assert.equal(approval.arguments.package.files.length, 3);
    assert.equal(approval.arguments.package.files[1].content, dependency.content);
    await f.request(base + "/approval", { method: "POST", data: { id: approval.id, approved: true } });
    while (!(await reader.read()).done) {
        /* Wait for the server to persist all receipts. */
    }
    assert.equal(writes, 1);
    const saved = f.store.get("alice", conversation.id);
    assert.equal(saved.artifacts.length, 3);
    assert.equal(saved.artifacts.find((item) => item.path.endsWith(".adl")).dependency, true);
    assert.doesNotMatch(JSON.stringify(saved.messages), /exact fixture ADL/);
});

for (const kind of ["github", "gitlab"])
    test(`${kind} an identical standalone artefact returns its hash without writing a new version`, async (t) => {
        let writes = 0;
        const f = setup(t, async (url, options) => {
            if (options.method) writes++;
            return {
                status: 200,
                text: JSON.stringify({
                    type: "file",
                    encoding: "base64",
                    content: Buffer.from("same archetype").toString("base64"),
                    sha: "a".repeat(40),
                    last_commit_id: "a".repeat(40),
                }),
            };
        });
        const repo = f.connections.add("alice", {
            ...github,
            kind,
            url: kind === "github" ? github.url : "https://gitlab.com/alice/models",
        }).connection;
        const result = await f.connections.publish("alice", {
            repository: repo.id,
            path: "archetypes/model.adl",
            content: "same archetype",
            expectedRevision: "a".repeat(40),
            message: "No change",
        });
        assert.equal(result.changed, false);
        assert.equal(result.change, "unchanged");
        assert.equal(result.sha256, createHash("sha256").update("same archetype").digest("hex"));
        assert.equal(writes, 0);
        await assert.rejects(
            f.connections.publish("alice", {
                repository: repo.id,
                path: "archetypes/model.adl",
                content: "same archetype",
                expectedRevision: "b".repeat(40),
                message: "Stale revision",
            }),
            /changed/,
        );
    });

test("large GitHub OPTs update the same path when the Contents API omits their body", async (t) => {
    const content = "<template>" + "x".repeat(1080000) + "</template>";
    const revision = createHash("sha1")
        .update("blob " + Buffer.byteLength(content) + "\0" + content)
        .digest("hex");
    let writes = 0;
    const f = setup(t, async (url, options) => {
        if (options.method) {
            writes++;
            assert.equal(options.body.sha, revision);
            return { status: 200, text: JSON.stringify({ commit: { sha: "c".repeat(40) } }) };
        }
        if (url.includes("/git/ref/"))
            return { status: 200, text: JSON.stringify({ object: { sha: "a".repeat(40) } }) };
        if (url.includes("/git/blobs/")) return { status: 200, text: content };
        return {
            status: 200,
            text: JSON.stringify({ type: "file", encoding: "none", sha: revision, size: Buffer.byteLength(content) }),
        };
    });
    const repo = f.connections.add("alice", github).connection;
    const args = {
        repository: repo.id,
        path: "templates/opt/large.opt",
        content: content.replace("xxx", "yyy"),
        message: "Update compiled draft",
        expectedRevision: revision,
    };
    const saved = await f.connections.publish("alice", args);
    assert.equal(saved.commit, "c".repeat(40));
    assert.equal(saved.path, args.path);
    assert.equal(saved.previousSha256, createHash("sha256").update(content).digest("hex"));
    assert.notEqual(saved.sha256, saved.previousSha256);
    assert.equal(writes, 1);
});
