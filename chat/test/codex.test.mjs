import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexProvider } from "../src/codex.mjs";
import { loadConfig } from "../src/config.mjs";
import { problem } from "../src/personal-http.mjs";
const config = {
    ...loadConfig(),
    codexWorkDir: "/tmp",
    codexBinary: fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)),
};
const tools = [{ name: "ckm_sources", description: "List sources", inputSchema: { type: "object" } }];
test("Codex protocol isolates secrets, declines native approvals and forwards only declared tool calls", async () => {
    process.env.CHAT_MCP_API_KEY = "fixture-secret-must-not-reach-codex";
    process.env.CHAT_REVIEW_SIGNING_KEY = "fixture-governance-key-must-not-reach-codex";
    const events = [],
        calls = [];
    try {
        const result = await new CodexProvider(config).run({
            messages: [{ role: "user", content: "List CKMs" }],
            tools,
            signal: AbortSignal.timeout(5000),
            onEvent: (event) => events.push(event),
            callTool: async (name, args) => {
                calls.push({ name, args });
                return { text: "fixture-result" };
            },
        });
        assert.equal(result, "Verified response");
        assert.deepEqual(calls, [{ name: "ckm_sources", args: {} }]);
        assert.equal(events.filter((e) => e.type === "delta").length, 2);
    } finally {
        delete process.env.CHAT_MCP_API_KEY;
        delete process.env.CHAT_REVIEW_SIGNING_KEY;
    }
});
test("cancellation terminates an active Codex turn", async () => {
    await assert.rejects(
        () =>
            new CodexProvider(config).run({
                messages: [{ role: "user", content: "WAIT" }],
                tools,
                signal: AbortSignal.timeout(100),
                onEvent: () => {},
                callTool: async () => ({}),
            }),
        { name: "AbortError" },
    );
});

test("Codex device sign-in uses an isolated credential directory and completes without inference", async (t) => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = mkdtempSync(join(tmpdir(), "codex-login-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let login;
    await new CodexProvider({ ...config, codexHome: directory }).run({
        signal: AbortSignal.timeout(5000),
        onLogin: (result) => {
            login = result;
        },
    });
    assert.equal(login.userCode, "TEST-CODE");
    assert.equal(JSON.parse(readFileSync(join(directory, "auth.json"))).token, "personal-fixture");
});

test("Codex receives explicit source images and removes temporary copies on success and cancellation", async (t) => {
    const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const wait of [false, true]) {
        const directory = mkdtempSync("/tmp/codex-image-test-");
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const run = new CodexProvider({ ...config, codexHome: directory }).run({
            messages: [{ role: "user", content: "VERIFY_IMAGES" + (wait ? " WAIT" : "") }],
            images: [
                {
                    id: "source-id",
                    name: "source.png",
                    mimeType: "image/jpeg",
                    data: Buffer.from("prepared-image-fixture").toString("base64"),
                },
            ],
            tools,
            signal: AbortSignal.timeout(wait ? 1000 : 5000),
            onEvent() {},
            callTool: async () => ({ text: "fixture-result" }),
        });
        if (wait) await assert.rejects(run, { name: "AbortError" });
        else assert.equal(await run, "Verified response");
        const path = JSON.parse(readFileSync(join(directory, "image-path.json")));
        assert.equal(existsSync(path), false);
    }
});

test("Codex receives actionable local save errors and redacts unknown errors", async () => {
    for (const error of [problem("Choose the selected repository folder."), new Error("secret-token-from-remote")]) {
        const result = await new CodexProvider(config).run({
            messages: [{ role: "user", content: "VERIFY_TOOL_ERROR" }],
            tools,
            signal: AbortSignal.timeout(5000),
            onEvent() {},
            callTool() {
                throw error;
            },
        });
        assert.equal(result, "Verified response");
    }
});
