import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "../src/provider-store.mjs";
import { Providers } from "../src/providers.mjs";
import { ClaudeProvider } from "../src/claude.mjs";
import { problem } from "../src/personal-http.mjs";

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "provider-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ProviderStore(directory, "cd".repeat(32));
    return { directory, store };
}

test("provider credentials are encrypted, identity-bound and not returned in status", (t) => {
    const { store, directory } = fixture(t);
    const key = "sk-ant-" + "a".repeat(40);
    const providers = new Providers({}, { store });
    providers.connectClaude("issuer\nalice", key);
    assert.equal(store.get("issuer\nalice", "claude").credential, key);
    assert.equal(store.get("issuer\nbob", "claude"), null);
    assert.equal(store.get("other-issuer\nalice", "claude"), null);
    assert.equal(store.get("issuer\nalice", "codex"), null);
    const filename = join(directory, readdirSync(directory)[0]);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.ok(!readFileSync(filename, "utf8").includes(key));
    assert.ok(!JSON.stringify(providers.status("issuer\nalice")).includes(key));
    writeFileSync(join(directory, store.id("issuer\nbob", "claude") + ".json"), readFileSync(filename));
    assert.throws(() => store.get("issuer\nbob", "claude"));
    providers.disconnect("issuer\nalice", "claude");
    assert.equal(store.get("issuer\nalice", "claude"), null);
});

test("unconnected users never inherit a shared provider credential", async (t) => {
    const { store } = fixture(t);
    store.set("alice", "claude", "alice-key");
    const providers = new Providers({}, { store });
    await assert.rejects(providers.run({ identity: "bob", provider: "claude" }), /Connect your provider/);
    assert.throws(() => providers.assertConnected("alice", "arbitrary"), /Connect your provider/);
});

test("Claude turns receive only the requesting user's key", async (t) => {
    const { store } = fixture(t);
    store.set("alice", "claude", "alice-key");
    store.set("bob", "claude", "bob-key");
    const seen = [];
    const providers = new Providers(
        {},
        {
            store,
            claude: (key) => ({
                run: async () => {
                    seen.push(key);
                    return "ok";
                },
            }),
        },
    );
    await providers.run({ identity: "alice", provider: "claude" });
    await providers.run({ identity: "bob", provider: "claude" });
    assert.deepEqual(seen, ["alice-key", "bob-key"]);
});

test("Codex runtime is private, refresh is retained and temporary credentials are removed", async (t) => {
    const { store } = fixture(t);
    store.set("alice", "codex", { token: "alice-original" });
    let runtime;
    const providers = new Providers(
        {},
        {
            store,
            codex: (config) => {
                runtime = config.codexHome;
                return {
                    run: async () => {
                        assert.equal(statSync(runtime).mode & 0o777, 0o700);
                        assert.equal(JSON.parse(readFileSync(join(runtime, "auth.json"))).token, "alice-original");
                        writeFileSync(join(runtime, "auth.json"), JSON.stringify({ token: "alice-refreshed" }));
                        return "reply";
                    },
                };
            },
        },
    );
    assert.equal(await providers.run({ identity: "alice", provider: "codex" }), "reply");
    assert.equal(store.get("alice", "codex").credential.token, "alice-refreshed");
    assert.throws(() => statSync(runtime), { code: "ENOENT" });
});

test("a completed Codex turn cannot restore disconnected or replaced credentials", async (t) => {
    const { store } = fixture(t);
    for (const replace of [false, true]) {
        store.set("alice", "codex", { token: "old" });
        const providers = new Providers(
            {},
            {
                store,
                codex: () => ({
                    run: async () => {
                        providers.disconnect("alice", "codex");
                        if (replace) store.set("alice", "codex", { token: "new" });
                        return "reply";
                    },
                }),
            },
        );
        await providers.run({ identity: "alice", provider: "codex" });
        assert.equal(store.get("alice", "codex")?.credential.token || null, replace ? "new" : null);
    }
});

test("device sign-in is bounded, belongs to one user and can be cancelled", async (t) => {
    const { store } = fixture(t);
    let finish, runtime;
    const providers = new Providers(
        {},
        {
            store,
            codex: (config) => {
                runtime = config.codexHome;
                return {
                    run: ({ onLogin, signal }) =>
                        new Promise((resolve, reject) => {
                            finish = () => {
                                writeFileSync(join(runtime, "auth.json"), '{"token":"alice"}');
                                resolve();
                            };
                            onLogin({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" });
                            signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
                        }),
                };
            },
        },
    );
    const result = await providers.startLogin("alice");
    assert.equal(result.userCode, "TEST-CODE");
    await assert.rejects(providers.startLogin("alice"), /already in progress/);
    assert.equal(providers.status("bob")[0].signingIn, false);
    const done = providers.logins.get("alice").done;
    finish();
    await done;
    assert.equal(providers.status("alice")[0].connected, true);
    assert.equal(providers.status("bob")[0].connected, false);
    providers.disconnect("alice", "codex");
    await providers.startLogin("alice");
    const cancelled = providers.logins.get("alice").done;
    providers.disconnect("alice", "codex");
    await cancelled;
    assert.equal(providers.status("alice")[0].connected, false);
    assert.throws(() => statSync(runtime), { code: "ENOENT" });
});

function streamFixture(final, deltas = []) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const text of deltas) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
        },
        finalMessage: async () => final,
        abort() {},
    };
}

test("Claude streams replies and sends real MCP results back through its tool loop", async () => {
    const requests = [],
        events = [],
        calls = [];
    const client = {
        messages: {
            stream(input) {
                requests.push(structuredClone(input));
                return requests.length === 1
                    ? streamFixture({
                          stop_reason: "tool_use",
                          content: [{ type: "tool_use", id: "call1", name: "ckm_sources", input: {} }],
                      })
                    : streamFixture({ stop_reason: "end_turn", content: [] }, ["Verified ", "reply"]);
            },
        },
    };
    const result = await new ClaudeProvider({ claudeModel: "fixture-model" }, "fixture", client).run({
        messages: [{ role: "user", content: "List sources" }],
        images: [
            {
                id: "image-source",
                name: "source.png",
                mimeType: "image/jpeg",
                data: Buffer.from("prepared-image").toString("base64"),
            },
        ],
        tools: [{ name: "ckm_sources", inputSchema: { type: "object" } }],
        signal: new AbortController().signal,
        callTool: async (name, args) => {
            calls.push({ name, args });
            return { structuredContent: { success: true, result: "source" } };
        },
        onEvent: (event) => events.push(event),
    });
    assert.equal(result, "Verified reply");
    assert.deepEqual(calls, [{ name: "ckm_sources", args: {} }]);
    assert.equal(requests[0].model, "fixture-model");
    assert.equal(requests[0].messages[0].content[1].type, "image");
    assert.equal(requests[0].messages[0].content[1].source.media_type, "image/jpeg");
    assert.equal(Buffer.from(requests[0].messages[0].content[1].source.data, "base64").toString(), "prepared-image");
    assert.equal(requests[1].messages[0].content[1].source.data, requests[0].messages[0].content[1].source.data);
    assert.match(requests[1].messages.at(-1).content[0].content, /source/);
    assert.equal(requests[1].messages.at(-1).content[0].is_error, false);
    assert.equal(events.length, 2);
});

test("Claude cannot treat incomplete responses as successful or continue after cancellation", async () => {
    const client = { messages: { stream: () => streamFixture({ stop_reason: "max_tokens", content: [] }) } };
    const provider = new ClaudeProvider({}, "fixture", client);
    const args = { messages: [{ role: "user", content: "Hello" }], tools: [], onEvent() {}, callTool() {} };
    await assert.rejects(provider.run({ ...args, signal: new AbortController().signal }), /incomplete/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.run({ ...args, signal: controller.signal }), { name: "AbortError" });
});

test("Claude receives actionable local save errors but never raw exception details", async () => {
    for (const error of [problem("Choose the selected repository folder."), new Error("secret-token-from-remote")]) {
        const requests = [];
        const client = {
            messages: {
                stream(input) {
                    requests.push(structuredClone(input));
                    return requests.length === 1
                        ? streamFixture({
                              stop_reason: "tool_use",
                              content: [{ type: "tool_use", id: "save", name: "personal_repository_save", input: {} }],
                          })
                        : streamFixture({ stop_reason: "end_turn", content: [] });
                },
            },
        };
        await new ClaudeProvider({}, "fixture", client).run({
            messages: [{ role: "user", content: "Save draft" }],
            tools: [{ name: "personal_repository_save", inputSchema: { type: "object" } }],
            signal: AbortSignal.timeout(2000),
            onEvent() {},
            callTool() {
                throw error;
            },
        });
        const result = requests[1].messages.at(-1).content[0];
        assert.equal(result.is_error, true);
        assert.doesNotMatch(result.content, /secret-token-from-remote/);
        if (error.userSafe) assert.equal(result.content, error.message);
        else assert.match(result.content, /not executed/);
    }
});

test("shared providers require explicit access, prefer private credentials and never copy shared secrets", async (t) => {
    const { GLOBAL_IDENTITY } = await import("../src/access.mjs");
    const { store } = fixture(t);
    const keys = [];
    const providers = new Providers({}, { store, claude: (key) => ({ run: async () => keys.push(key) }) });
    providers.canUseGlobal = (identity) => identity === "allowed";
    providers.connectClaude(GLOBAL_IDENTITY, "sk-ant-" + "s".repeat(30));
    await assert.rejects(providers.run({ identity: "stranger", provider: "claude" }), /Connect your provider/);
    await providers.run({ identity: "allowed", provider: "claude" });
    assert.equal(store.get("allowed", "claude"), null);
    assert.equal(providers.status("allowed")[1].scope, "global");
    providers.connectClaude("allowed", "sk-ant-" + "p".repeat(30));
    await providers.run({ identity: "allowed", provider: "claude" });
    assert.deepEqual(keys, ["sk-ant-" + "s".repeat(30), "sk-ant-" + "p".repeat(30)]);
    providers.disconnect("allowed", "claude");
    assert.ok(store.get(GLOBAL_IDENTITY, "claude"));
    providers.canUseGlobal = () => false;
    assert.throws(() => providers.assertConnected("allowed", "claude"), /Connect your provider/);
});

test("shared Codex API keys use concurrent isolated runtimes without copying credentials", async (t) => {
    const { GLOBAL_IDENTITY } = await import("../src/access.mjs");
    const { store } = fixture(t);
    const homes = new Set();
    let started = 0,
        release;
    const barrier = new Promise((resolve) => {
        release = resolve;
    });
    const key = "sk-proj-" + "s".repeat(40);
    const providers = new Providers(
        {},
        {
            store,
            codex: (config) => ({
                run: async () => {
                    homes.add(config.codexHome);
                    assert.equal(JSON.parse(readFileSync(join(config.codexHome, "auth.json"))).OPENAI_API_KEY, key);
                    if (++started === 2) release();
                    await barrier;
                    return "completed";
                },
            }),
        },
    );
    providers.canUseGlobal = () => true;
    providers.connectCodexKey(GLOBAL_IDENTITY, key);
    const results = await Promise.all(
        ["alice", "bob"].map((identity) => providers.run({ identity, provider: "codex" })),
    );
    assert.deepEqual(results, ["completed", "completed"]);
    assert.equal(homes.size, 2);
    for (const home of homes) assert.throws(() => statSync(home), { code: "ENOENT" });
    assert.equal(store.get("alice", "codex"), null);
    assert.equal(store.get("bob", "codex"), null);
});
