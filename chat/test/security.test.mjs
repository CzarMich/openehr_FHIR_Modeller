import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import * as oidc from "openid-client";
import { loadConfig } from "../src/config.mjs";
import { Auth, equal } from "../src/auth.mjs";
import { Store } from "../src/store.mjs";
import { createApplication } from "../src/server.mjs";
import { McpClient } from "../src/mcp.mjs";

async function fixture(t, { provider, mcp, reviews, cdr, reviewOnly = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "modelling-chat-"));
    const config = { ...loadConfig(), enabled: true, dataDir: directory, allowWrites: true, maxConcurrentTurns: 3 };
    if (reviewOnly) {
        config.enabled = false;
        config.reviewEnabled = true;
    }
    if (cdr) config.cdrEnabled = true;
    const auth = new Auth(config),
        store = new Store(directory);
    auth.sessions.set("alice", {
        identity: "issuer\nalice",
        name: "Alice",
        csrf: "alice-csrf",
        expires: Date.now() + 60000,
    });
    auth.sessions.set("bob", { identity: "issuer\nbob", name: "Bob", csrf: "bob-csrf", expires: Date.now() + 60000 });
    const tools = [
        { name: "ckm_sources", inputSchema: { type: "object" } },
        { name: "model_artifact_save", inputSchema: { type: "object" } },
    ];
    const calls = [];
    const service = mcp || {
        tools: async () => tools,
        call: async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: "text", text: "Real fixture result" }] };
        },
    };
    const defaultProvider = {
        run: async ({ onEvent, callTool }) => {
            await callTool("ckm_sources", {});
            onEvent({ type: "delta", text: "Grounded response" });
            return "Grounded response";
        },
    };
    const server = createApplication(config, {
        auth,
        store,
        provider: provider || defaultProvider,
        mcpFactory: () => service,
        ...(reviews ? { reviews } : {}),
        ...(cdr ? { cdr } : {}),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    // The production configuration is immutable; this test owns its explicitly injected configuration.
    config.origin = origin;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    });
    async function request(path, { user = "alice", method = "GET", data, csrf = true, originHeader = origin } = {}) {
        return fetch(origin + path, {
            method,
            headers: {
                ...(user ? { Cookie: "ModellingSession=" + user } : {}),
                ...(method === "GET"
                    ? {}
                    : {
                          "Content-Type": "application/json",
                          Origin: originHeader,
                          ...(csrf ? { "X-CSRF-Token": user + "-csrf" } : {}),
                      }),
            },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
    }
    return { request, store, auth, config, calls, origin };
}

test("Copilot connection and tool test require identity and CSRF, and a plain success claim cannot pass", async (t) => {
    const starts = [],
        runs = [];
    let invoke = true;
    const provider = {
        status: () => [{ id: "copilot", name: "Copilot Studio", connected: true }],
        assertConnected(identity, name) {
            assert.equal(name, "copilot");
            assert.equal(identity, "issuer\nalice");
        },
        copilot: {
            start: async (identity, settings) => {
                starts.push({ identity, settings });
                return { verificationUrl: "https://microsoft.com/devicelogin", userCode: "TEST-CODE" };
            },
        },
        run: async (options) => {
            runs.push(options);
            assert.equal(options.provider, "copilot");
            assert.deepEqual(
                options.tools.map((tool) => tool.name),
                ["workspace_connection_check"],
            );
            if (invoke) await options.callTool("workspace_connection_check", {});
            return "Successfully connected";
        },
        disconnect() {},
    };
    const f = await fixture(t, { provider });
    const settings = { tenantId: "tenant", clientId: "app", environmentId: "environment", schemaName: "agent" };
    const path = "/chat/api/providers/copilot";
    for (const endpoint of [path, path + "/test"]) {
        assert.equal((await f.request(endpoint, { user: null, method: "POST", data: {} })).status, 401);
        assert.equal((await f.request(endpoint, { csrf: false, method: "POST", data: {} })).status, 403);
    }
    assert.equal(
        (await f.request(path, { method: "POST", data: { ...settings, secret: "must-not-be-accepted" } })).status,
        400,
    );
    assert.equal((await f.request(path, { method: "POST", data: settings })).status, 200);
    assert.deepEqual(starts, [{ identity: "issuer\nalice", settings }]);
    const verified = await f.request(path + "/test", { method: "POST", data: {} });
    assert.equal(verified.status, 200);
    assert.equal((await verified.json()).verified, true);
    invoke = false;
    assert.equal((await f.request(path + "/test", { method: "POST", data: {} })).status, 409);
    assert.equal(f.calls.length, 0, "Connection checks must never reach enterprise MCP");
    const chat = await (
        await f.request("/chat/api/conversations", { method: "POST", data: { provider: "copilot" } })
    ).json();
    assert.equal(chat.provider, "copilot");
});

test("AQL drafting requires the browser identity and CSRF and never forwards query or result fields", async (t) => {
    let providerCalls = 0;
    const operations = [];
    const f = await fixture(t, {
        provider: {
            run: async ({ identity, messages, callTool }) => {
                providerCalls++;
                assert.equal(identity, "issuer\nalice");
                assert(!JSON.stringify(messages).includes("synthetic-private-canary"));
                await callTool("submit_aql", {
                    query: "SELECT m/name/value FROM COMPOSITION m LIMIT 100",
                    parameters: {},
                    explanation: "Checked model.",
                });
            },
        },
        cdr: {
            request: async (session, operation) => {
                assert.equal(session.identity, "issuer\nalice");
                operations.push(operation);
                if (operation === "inspect")
                    return {
                        valid: true,
                        identifier: "Synthetic",
                        inspection: { paths: [{ path: "/", rm_type: "COMPOSITION" }] },
                    };
                assert.equal(operation, "validate");
                return { valid: true, ast: { limit: 100 } };
            },
        },
    });
    const data = {
        provider: "codex",
        intent: "Return a model name",
        model: { content: "synthetic OPT", format: "opt14" },
        paths: [],
    };
    const path = "/chat/api/aql-draft";
    assert.equal((await f.request(path, { user: null, method: "POST", data })).status, 401);
    assert.equal((await f.request(path, { method: "POST", data, csrf: false })).status, 403);
    assert.equal(
        (await f.request(path, { method: "POST", data: { ...data, results: "synthetic-private-canary" } })).status,
        400,
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(operations, []);
    const response = await f.request(path, { method: "POST", data });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).executed, false);
    assert.equal(providerCalls, 1);
    assert.deepEqual(operations, ["inspect", "validate"]);
    assert.equal(f.store.list("issuer\nalice").length, 0, "drafting never creates a conversation");
});

test("configuration refuses non-TLS public origins, embedded credentials, missing OIDC and invalid limits", () => {
    assert.throws(() => loadConfig({ CHAT_PUBLIC_URL: "http://example.org" }));
    assert.throws(() => loadConfig({ CHAT_PUBLIC_URL: "https://user:password@example.org" }));
    assert.throws(() => loadConfig({ CHAT_ENABLED: "true" }));
    assert.throws(() => loadConfig({ CHAT_TURN_TIMEOUT_SECONDS: "invalid" }));
    assert.equal(
        loadConfig({
            CHAT_ENABLED: "true",
            CHAT_PROVIDER_ENCRYPTION_KEY: "cd".repeat(32),
            CHAT_LOCAL_IDENTITY_ENABLED: "true",
            CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY: "ab".repeat(32),
            CHAT_PUBLIC_URL: "https://models.example",
        }).identityEnabled,
        true,
    );
    assert.throws(
        () =>
            loadConfig({
                CHAT_ENABLED: "true",
                CHAT_LOCAL_IDENTITY_ENABLED: "true",
                CHAT_PUBLIC_URL: "https://models.example",
            }),
        /encryption key/,
    );
    assert.throws(
        () =>
            loadConfig({
                CHAT_ENABLED: "true",
                CHAT_LOCAL_IDENTITY_ENABLED: "true",
                CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY: "ab".repeat(32),
                CHAT_OIDC_CLIENT_ID: "partial",
            }),
        /OIDC/,
    );
    assert.equal(loadConfig().enabled, false);
    assert.equal(equal("a", "é"), false);
});

test("disabled browser workspace explains review-only OIDC configuration", async (t) => {
    const f = await fixture(t);
    f.config.enabled = false;
    f.config.reviewEnabled = false;
    const response = await f.request("/chat/auth/login", { user: null });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.match(result.error, /CHAT_REVIEW_ENABLED=true/);
    assert.match(result.error, /CHAT_ENABLED and a model-provider account are only needed for conversational chat/);
});

test("authentication, same-origin CSRF and response redaction", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request("/chat/api/conversations", { user: null })).status, 401);
    assert.equal((await f.request("/chat/api/conversations", { method: "POST", csrf: false })).status, 403);
    assert.equal(
        (await f.request("/chat/api/conversations", { method: "POST", originHeader: "https://evil.example" })).status,
        403,
    );
    const session = await (await f.request("/chat/api/session")).json();
    assert.deepEqual(session.user, { name: "Alice" });
    assert.equal(session.csrf, "alice-csrf");
    assert.equal(JSON.stringify(session).includes("issuer"), false);
    assert.equal(JSON.stringify(session).includes("mcpKey"), false);
    const expired = f.auth.sessions.get("alice");
    expired.expires = 0;
    assert.equal((await f.request("/chat/api/conversations")).status, 401);
});

test("review-only API requires session, same-origin CSRF and closed decision input before signing", async (t) => {
    const calls = [];
    const f = await fixture(t, {
        reviewOnly: true,
        reviews: {
            request: async (...args) => {
                calls.push(args);
                return { state: "REVIEWED" };
            },
        },
    });
    const target = "/chat/api/reviews/" + "a".repeat(64) + "/transitions";
    const data = { state: "REVIEWED", expectedSequence: 3, comment: "Reviewed exact source." };
    assert.equal((await f.request(target, { method: "POST", data, user: null })).status, 401);
    assert.equal((await f.request(target, { method: "POST", data, csrf: false })).status, 403);
    assert.equal((await f.request(target, { method: "POST", data, originHeader: "https://evil.example" })).status, 403);
    assert.equal((await f.request(target, { method: "POST", data: { ...data, human: true } })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await f.request(target, { method: "POST", data })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].identity, "issuer\nalice");
    assert.deepEqual(calls[0][3], data);
    assert.equal((await f.request("/chat/api/conversations")).status, 503);
    assert.equal((await (await f.request("/chat/api/session")).json()).reviewEnabled, true);
});

test("conversation IDs do not authorize another user to read, write, delete, stop or approve", async (t) => {
    const f = await fixture(t),
        created = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const base = "/chat/api/conversations/" + created.id;
    for (const [path, method, data] of [
        [base, "GET"],
        [base, "DELETE"],
        [base + "/messages", "POST", { content: "read it" }],
        [base + "/stop", "POST"],
        [base + "/approval", "POST", { id: "x", approved: true }],
    ]) {
        assert.equal((await f.request(path, { user: "bob", method, data })).status, 404);
    }
    assert.deepEqual((await (await f.request("/chat/api/conversations", { user: "bob" })).json()).conversations, []);
    assert.throws(() => f.store.get("issuer\nalice", "../../etc/passwd"));
});

test("actual tool execution streams an answer and persists it for the owning user", async (t) => {
    const f = await fixture(t),
        created = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const response = await f.request("/chat/api/conversations/" + created.id + "/messages", {
        method: "POST",
        data: { content: "Which CKMs are configured?" },
    });
    const text = await response.text();
    assert.match(text, /Grounded response/);
    assert.match(text, /"type":"done"/);
    assert.equal(f.calls[0].name, "ckm_sources");
    const saved = await (await f.request("/chat/api/conversations/" + created.id)).json();
    assert.equal(saved.messages.length, 2);
    assert.equal(saved.messages[1].tools[0].status, "completed");
    const second = await f.request("/chat/api/conversations/" + created.id + "/messages", {
        method: "POST",
        data: { content: "Continue", identity: "bob" },
    });
    assert.equal(second.status, 400);
});

test("write confirmation binds the user, conversation, call and exact arguments", async (t) => {
    const args = { projectId: "default", path: "archetypes/example.adl", content: "draft", expectedRevision: "abc" };
    const f = await fixture(t, {
        provider: {
            run: async ({ callTool, onEvent }) => {
                await callTool("model_artifact_save", args);
                onEvent({ type: "delta", text: "Saved after confirmation" });
                return "Saved after confirmation";
            },
        },
    });
    const created = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const base = "/chat/api/conversations/" + created.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Save draft" } });
    const reader = response.body.getReader();
    let buffer = "",
        approval;
    while (!approval) {
        const next = await reader.read();
        assert.equal(next.done, false);
        buffer += new TextDecoder().decode(next.value);
        for (const line of buffer.split("\n"))
            if (line.startsWith("data: ")) {
                try {
                    const e = JSON.parse(line.slice(6));
                    if (e.type === "approval") approval = e;
                } catch {}
            }
    }
    assert.equal(f.calls.length, 0);
    assert.deepEqual(approval.arguments, args);
    assert.equal(
        (
            await f.request(base + "/approval", {
                method: "POST",
                user: "bob",
                data: { id: approval.id, approved: true },
            })
        ).status,
        404,
    );
    assert.equal(
        (await f.request(base + "/approval", { method: "POST", data: { id: "forged", approved: true } })).status,
        409,
    );
    assert.equal(
        (await f.request(base + "/approval", { method: "POST", data: { id: approval.id, approved: true } })).status,
        200,
    );
    while (!(await reader.read()).done) {}
    assert.deepEqual(f.calls, [{ name: "model_artifact_save", args }]);
    assert.equal(
        (await f.request(base + "/approval", { method: "POST", data: { id: approval.id, approved: true } })).status,
        409,
    );
});

test("declined changes never reach the repository", async (t) => {
    const f = await fixture(t, {
        provider: {
            run: async ({ callTool }) => {
                await callTool("model_artifact_save", { content: "unapproved" });
                return "";
            },
        },
    });
    const created = await (await f.request("/chat/api/conversations", { method: "POST" })).json(),
        base = "/chat/api/conversations/" + created.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Draft" } }),
        reader = response.body.getReader();
    let buffer = "",
        approval;
    while (!approval) {
        const { value } = await reader.read();
        buffer += new TextDecoder().decode(value);
        for (const line of buffer.split("\n"))
            if (line.startsWith("data: ")) {
                try {
                    const e = JSON.parse(line.slice(6));
                    if (e.type === "approval") approval = e;
                } catch {}
            }
    }
    await f.request(base + "/approval", { method: "POST", data: { id: approval.id, approved: false } });
    while (!(await reader.read()).done) {}
    assert.equal(f.calls.length, 0);
});

test("stop aborts a running response and concurrent turns do not race", async (t) => {
    const f = await fixture(t, {
        provider: {
            run: async ({ signal }) =>
                new Promise((resolve, reject) =>
                    signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
                ),
        },
    });
    const created = await (await f.request("/chat/api/conversations", { method: "POST" })).json(),
        base = "/chat/api/conversations/" + created.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Run" } });
    assert.equal((await f.request(base + "/messages", { method: "POST", data: { content: "Race" } })).status, 409);
    assert.equal((await f.request(base, { method: "DELETE" })).status, 409);
    await f.request(base + "/stop", { method: "POST" });
    assert.match(await response.text(), /Response stopped/);
});

test("MCP tool filtering fails closed for new or disabled write tools", async () => {
    const client = new McpClient({ ...loadConfig(), allowWrites: false }, new AbortController().signal);
    client.rpc = async (method) =>
        method === "tools/list"
            ? {
                  tools: [
                      { name: "ckm_sources" },
                      { name: "model_artifact_save" },
                      { name: "template_compile_project" },
                      { name: "model_artifact_import" },
                      { name: "delete_all_models" },
                  ],
              }
            : { protocolVersion: "2025-03-26" };
    assert.deepEqual(
        (await client.tools()).map((t) => t.name),
        ["ckm_sources"],
    );
    await assert.rejects(() => client.call("model_artifact_save", {}));
    await assert.rejects(() => client.call("delete_all_models", {}));
    await assert.rejects(() => client.call("template_compile_project", {}));
    await assert.rejects(() => client.call("model_artifact_import", {}));
});

function oidcFixture(claimOverride = {}, badSignature = false) {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = keys.publicKey.export({ format: "jwk" });
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const issuer = "https://identity.example/realm";
    const metadata = {
        issuer,
        authorization_endpoint: issuer + "/auth",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/keys",
    };
    const config = new oidc.Configuration(metadata, "browser", "client-secret");
    oidc.enableNonRepudiationChecks(config);
    config[oidc.customFetch] = async (url, options) => {
        if (String(url).endsWith("/keys"))
            return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
        assert.equal(new URLSearchParams(options.body).get("code_verifier"), "test-verifier");
        const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const claims = {
            iss: issuer,
            sub: "user-a",
            aud: "browser",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 600,
            nonce: "test-nonce",
            name: "Test User",
            ...claimOverride,
        };
        const value = enc({ alg: "RS256", kid: "test-key" }) + "." + enc(claims);
        const key = badSignature ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : keys.privateKey;
        const jwt = value + "." + sign("RSA-SHA256", Buffer.from(value), key).toString("base64url");
        return new Response(
            JSON.stringify({ access_token: "test-access", token_type: "Bearer", expires_in: 600, id_token: jwt }),
            { headers: { "Content-Type": "application/json" } },
        );
    };
    const auth = new Auth({
        ...loadConfig(),
        origin: "https://chat.example",
        secure: true,
        issuer,
        clientId: "browser",
    });
    auth.client = async () => config;
    auth.transactions.set("transaction", {
        state: "test-state",
        nonce: "test-nonce",
        verifier: "test-verifier",
        expires: Date.now() + 60000,
    });
    const req = {
        headers: { cookie: "__Host-ModellingLogin=transaction" },
        url: "/chat/auth/callback?code=test-code&state=test-state&iss=" + encodeURIComponent(issuer),
    };
    const headers = {},
        res = {
            setHeader: (k, v) => (headers[k] = v),
            writeHead: (status, h) => {
                res.status = status;
                Object.assign(headers, h);
            },
            end: () => {},
        };
    return { auth, req, res, headers };
}

test("OIDC verifies signed identity and issues only secure opaque cookies", async () => {
    const f = oidcFixture();
    await f.auth.callback(f.req, f.res);
    assert.equal(f.res.status, 302);
    assert.equal(f.auth.sessions.size, 1);
    assert.match(f.headers["Set-Cookie"][0], /HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
    assert.equal(JSON.stringify(f.headers).includes("test-access"), false);
    await assert.rejects(() => f.auth.callback(f.req, f.res));
});
for (const [name, claims, bad] of [
    ["nonce", { nonce: "wrong" }],
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "other" }],
    ["expiry", { exp: 1 }],
    ["signature", {}, true],
]) {
    test("OIDC rejects wrong " + name, async () => {
        const f = oidcFixture(claims, bad);
        await assert.rejects(() => f.auth.callback(f.req, f.res));
        assert.equal(f.auth.sessions.size, 0);
        assert.equal(f.auth.transactions.size, 0);
    });
}
test("OIDC rejects forged state and unapproved groups", async () => {
    const f = oidcFixture();
    f.req.url = f.req.url.replace("test-state", "forged");
    await assert.rejects(() => f.auth.callback(f.req, f.res));
    assert.equal(f.auth.sessions.size, 0);
    const g = oidcFixture({ groups: ["outsiders"] });
    g.auth.config.allowedGroups = ["modellers"];
    await assert.rejects(() => g.auth.callback(g.req, g.res));
    assert.equal(g.auth.sessions.size, 0);
});

test("retention removes stale conversations even when their owners do not return", async (t) => {
    const { utimesSync } = await import("node:fs");
    const f = await fixture(t);
    const old = f.store.create("inactive-user"),
        recent = f.store.create("active-user");
    const expired = new Date(Date.now() - 31 * 86400000);
    utimesSync(f.store.path("inactive-user", old.id), expired, expired);
    f.store.prune();
    assert.throws(() => f.store.get("inactive-user", old.id));
    assert.equal(f.store.get("active-user", recent.id).id, recent.id);
});

test("review identity retains signed OIDC subject, tenant, roles and bounded project scopes", async () => {
    const f = oidcFixture({
        roles: ["modelling-reviewer"],
        organisation: "hospital-a",
        project_scopes: ["project:alpha:read"],
    });
    f.auth.config.reviewEnabled = true;
    f.auth.config.reviewTenantClaim = "organisation";
    await f.auth.callback(f.req, f.res);
    const saved = [...f.auth.sessions.values()][0].reviewIdentity;
    assert.deepEqual(saved.roles, ["modelling-reviewer"]);
    assert.deepEqual(saved.projectScopes, ["project:alpha:read"]);
    assert.equal(saved.tenant, "hospital-a");
    assert.equal(saved.issuer, "https://identity.example/realm");
    assert.equal(typeof saved.subject, "string");
    assert.equal(typeof saved.started, "number");
    assert.equal(JSON.stringify(f.headers).includes("modelling-reviewer"), false);
});

test("malformed project scopes cannot establish an interactive review identity", async () => {
    const f = oidcFixture({ project_scopes: ["project:*:read"] });
    f.auth.config.reviewEnabled = true;
    await assert.rejects(() => f.auth.callback(f.req, f.res));
    assert.equal(f.auth.sessions.size, 0);
});

test("malformed review roles cannot establish an interactive approval identity", async () => {
    const f = oidcFixture({ roles: "modelling-approver" });
    f.auth.config.reviewEnabled = true;
    await assert.rejects(() => f.auth.callback(f.req, f.res));
    assert.equal(f.auth.sessions.size, 0);
});

test("model browsing requires the shared session and cannot mutate repository data", async (t) => {
    const f = await fixture(t);
    assert.equal((await f.request("/chat/api/models/projects", { user: null })).status, 401);
    assert.equal((await f.request("/chat/api/models/projects", { method: "POST", data: {} })).status, 403);
    assert.equal((await f.request("/chat/api/models/artifact?project=default&path=../secret")).status, 400);
    assert.equal(f.calls.length, 0);
});

test("concurrent model reads are bounded and capacity is recovered after errors", async (t) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const f = await fixture(t, {
        mcp: {
            tools: async () => {
                await gate;
                return [];
            },
            call: async () => {
                throw new Error("Should not run");
            },
        },
    });
    const first = f.request("/chat/api/models/projects"),
        second = f.request("/chat/api/models/projects");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await f.request("/chat/api/models/projects")).status, 429);
    release();
    await Promise.all([first, second]);
    assert.equal((await f.request("/chat/api/models/projects")).status, 503);
});

test("JSON scalar and array request bodies return client errors", async (t) => {
    const f = await fixture(t);
    const conversation = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    for (const data of [null, [], "text", 42]) {
        const response = await f.request("/chat/api/conversations/" + conversation.id + "/messages", {
            method: "POST",
            data,
        });
        assert.equal(response.status, 400);
    }
});

test("personal provider routes enforce identity, CSRF and connection ownership", async (t) => {
    const { Providers } = await import("../src/providers.mjs");
    const directory = mkdtempSync(join(tmpdir(), "provider-http-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const provider = new Providers(
        { enabled: true, dataDir: directory, providerEncryptionKey: "ef".repeat(32) },
        {
            claude: () => ({
                run: async ({ onEvent }) => {
                    onEvent({ type: "delta", text: "Personal reply" });
                    return "Personal reply";
                },
            }),
        },
    );
    const f = await fixture(t, { provider });
    const key = "sk-ant-" + "x".repeat(40);
    for (const options of [{ user: null }, { csrf: false }, { originHeader: "https://untrusted.example" }]) {
        const response = await f.request("/chat/api/providers/claude", {
            method: "POST",
            data: { apiKey: key },
            ...options,
        });
        assert.ok([401, 403].includes(response.status));
    }
    assert.equal(
        (await f.request("/chat/api/providers/claude", { method: "POST", data: { apiKey: key } })).status,
        200,
    );
    const alice = await (await f.request("/chat/api/providers")).json();
    const bob = await (await f.request("/chat/api/providers", { user: "bob" })).json();
    assert.equal(alice.providers.find((p) => p.id === "claude").connected, true);
    assert.equal(bob.providers.find((p) => p.id === "claude").connected, false);
    assert.ok(!JSON.stringify(alice).includes(key));
    const conversation = await (
        await f.request("/chat/api/conversations", { method: "POST", data: { provider: "claude" } })
    ).json();
    assert.equal(conversation.provider, "claude");
    const response = await f.request("/chat/api/conversations/" + conversation.id + "/messages", {
        method: "POST",
        data: { content: "Hello" },
    });
    assert.match(await response.text(), /Personal reply/);
    await f.request("/chat/api/providers/claude", { method: "DELETE" });
    const disconnected = await f.request("/chat/api/conversations/" + conversation.id + "/messages", {
        method: "POST",
        data: { content: "Hello again" },
    });
    assert.equal(disconnected.status, 409);
    assert.equal(
        (await f.request("/chat/api/conversations", { method: "POST", data: { provider: "external" } })).status,
        400,
    );
});

test("browser disconnect does not cancel work and partial progress can be recovered", async (t) => {
    let finish;
    const f = await fixture(t, {
        provider: {
            run: async ({ signal, onEvent, callTool }) => {
                onEvent({ type: "delta", text: "Retained progress" });
                await callTool("ckm_sources", {});
                await new Promise((resolve) => {
                    finish = resolve;
                });
                assert.equal(signal.aborted, false);
                return "Retained progress";
            },
        },
    });
    const chat = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const base = "/chat/api/conversations/" + chat.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Start" } });
    await response.body.cancel();
    const snapshot = await (await f.request(base)).json();
    assert.equal(snapshot.running, true);
    assert.match(snapshot.messages.at(-1).content, /Retained progress/);
    assert.equal((await f.request(base, { user: "bob" })).status, 404);
    finish();
    for (let i = 0; i < 50; i++) {
        const done = await (await f.request(base)).json();
        if (!done.running) {
            assert.equal(done.run.status, "completed");
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Response did not finish");
});
test("approval survives reconnect and waiting does not consume the active turn budget", async (t) => {
    const f = await fixture(t, {
        provider: {
            run: async ({ callTool }) => {
                await callTool("model_artifact_save", { content: "exact draft" });
                return "Saved";
            },
        },
    });
    f.config.turnTimeoutMs = 100;
    const chat = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const base = "/chat/api/conversations/" + chat.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Save" } });
    await response.body.cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const snapshot = await (await f.request(base)).json();
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.pending.type, "approval");
    assert.equal(snapshot.pending.arguments.content, "exact draft");
    assert.equal(f.calls.length, 0);
    await f.request(base + "/approval", { method: "POST", data: { id: snapshot.pending.id, approved: true } });
    for (let i = 0; i < 30 && !f.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.calls.length, 1);
});
test("time limits and server restarts are explained and keep partial messages", async (t) => {
    const f = await fixture(t, {
        provider: {
            run: async ({ signal, onEvent }) => {
                onEvent({ type: "delta", text: "Completed part" });
                await new Promise((resolve, reject) =>
                    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
                );
            },
        },
    });
    f.config.turnTimeoutMs = 30;
    const chat = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const base = "/chat/api/conversations/" + chat.id;
    const response = await f.request(base + "/messages", { method: "POST", data: { content: "Start" } });
    assert.match(await response.text(), /time limit/);
    const snapshot = await (await f.request(base)).json();
    assert.equal(snapshot.run.reason, "TIME_LIMIT");
    assert.match(snapshot.messages.at(-1).content, /Completed part/);
    const stored = f.store.get("issuer\nalice", chat.id);
    stored.run.status = "running";
    f.store.save("issuer\nalice", stored);
    const recovered = await (await f.request(base)).json();
    assert.equal(recovered.run.reason, "SERVER_RESTART");
    assert.match(recovered.messages.at(-1).content, /server restarted/);
});
test("modelling can exceed sixteen tools but the bounded limit remains explicit", async (t) => {
    const f = await fixture(t, {
        provider: {
            run: async ({ callTool }) => {
                for (let i = 0; i < 65; i++) await callTool("ckm_sources", {});
            },
        },
    });
    const chat = await (await f.request("/chat/api/conversations", { method: "POST" })).json();
    const response = await f.request("/chat/api/conversations/" + chat.id + "/messages", {
        method: "POST",
        data: { content: "Start" },
    });
    assert.match(await response.text(), /tool limit/);
    assert.equal(f.calls.length, 64);
});

test("recovered draft downloads are private, excluded from shares and removed with the chat", async (t) => {
    const { Checkpoints } = await import("../src/checkpoints.mjs");
    const f = await fixture(t);
    f.config.providerEncryptionKey = "ab".repeat(32);
    const chat = f.store.create("issuer\nalice"),
        base = "/chat/api/conversations/" + chat.id;
    const cache = new Checkpoints(f.config, "issuer\nalice", chat.id);
    const id = cache.draft("exact draft bytes", "AKI/templates/oet/renal.oet");
    const path = base + "/drafts/" + id;
    assert.equal((await f.request(path, { user: null })).status, 401);
    assert.equal((await f.request(path, { user: "bob" })).status, 404);
    const download = await f.request(path);
    assert.match(download.headers.get("Content-Disposition"), /renal.oet/);
    assert.equal(await download.text(), "exact draft bytes");
    const share = await (await f.request(base + "/share", { method: "POST", data: {} })).json();
    const snapshot = await (await f.request("/chat/api/shares/" + share.token, { user: "bob" })).text();
    assert(!snapshot.includes("exact draft bytes"));
    assert(!snapshot.includes(id));
    await f.request(base, { method: "DELETE" });
    assert.equal((await f.request(path)).status, 404);
    assert.equal(cache.summary().drafts.length, 0);
});

test("session renewal is authenticated and CSRF protected", async (t) => {
    const f = await fixture(t);
    const path = "/chat/auth/keepalive";
    assert.equal((await f.request(path, { method: "POST", user: null, data: {} })).status, 401);
    assert.equal((await f.request(path, { method: "POST", csrf: false, data: {} })).status, 403);
    const response = await f.request(path, { method: "POST", data: {} });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /ModellingSession=alice/);
    assert((await response.json()).expires > Date.now());
});

test("FHIR workspace requires login, CSRF and exact confirmation before calling mutations", async (t) => {
    const calls = [];
    const mcp = {
        tools: async () => [{ name: "fhir_project" }],
        call: async (name, args) => {
            calls.push({ name, args });
            return { structuredContent: { success: true, result: { project: { id: "demo" } } } };
        },
    };
    const { request } = await fixture(t, { mcp });
    const data = { tool: "fhir_project", args: { action: "create", projectId: "demo", document: '{"name":"Demo"}' } };
    const path = "/chat/api/fhir/execute";
    assert.equal((await request(path, { method: "POST", data, user: null })).status, 401);
    assert.equal((await request(path, { method: "POST", data, csrf: false })).status, 403);
    assert.equal((await request(path, { method: "POST", data, originHeader: "https://attacker.example" })).status, 403);
    const previewResponse = await request(path, { method: "POST", data });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.confirmationRequired, true);
    assert.equal(calls.length, 0);
    assert.equal(
        (await request(path, { method: "POST", user: "bob", data: { ...data, confirmation: preview.confirmation } }))
            .status,
        409,
    );
    const confirmed = await request(path, { method: "POST", data: { ...data, confirmation: preview.confirmation } });
    assert.equal(confirmed.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
        (await request(path, { method: "POST", data: { ...data, confirmation: preview.confirmation } })).status,
        409,
    );
    assert.equal(
        (await request(path, { method: "POST", data: { tool: "model_artifact_save", args: {} } })).status,
        404,
    );
});
