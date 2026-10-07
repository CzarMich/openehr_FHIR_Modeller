import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextBuilder, estimateTokens, boundedHistory } from "../src/context-budget.mjs";
import { SessionManager, TaskLedger, TaskOrchestrator, safeMetadata } from "../src/task-execution.mjs";
import { executionContext } from "../src/tool-context.mjs";
import { compactToolResult } from "../src/provider-tools.mjs";
import { Store } from "../src/store.mjs";
import { Checkpoints } from "../src/checkpoints.mjs";
import { TemplatePackages } from "../src/template-packages.mjs";
import { loadConfig } from "../src/config.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";

function fixture(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "task-context-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = { dataDir, providerEncryptionKey: "ab".repeat(32), model: "fixture", retentionDays: 30 };
    const store = new Store(join(dataDir, "conversations"));
    const project = store.saveProject("alice", "Renal modelling", null, {
        instructions: "Keep the current requirements and read requirements/traceability.json.",
        standards: { openehr: "project-pinned" },
    });
    const chat = store.create("alice", "codex", null, project.id);
    return { config, store, project, chat };
}
const metadata = {
    personalRepositorySave: { selectedRepository: null, ready: false },
    saveDestination: "Enterprise repository",
    artifactFolders: {},
    attachments: [],
    savedArtifacts: [],
    recovery: { drafts: [], steps: [] },
};
const user = (content) => ({ role: "user", content });

test("priority context retains complete current instructions and drops old turns and low-priority data", () => {
    const messages = [
        user("old-private-canary"),
        { role: "assistant", content: "old".repeat(20000) },
        user("Correct <model>α</model> using current requirements."),
    ];
    const builder = new ContextBuilder({ contextBudget: { input: 1600, history: 200 } });
    const result = builder.build({
        messages,
        critical: { revision: "current-sha" },
        high: { decisions: [{ statement: "approved choice" }] },
        low: { obsolete: ["old".repeat(10000)] },
    });
    assert(estimateTokens(result.messages) <= 1600);
    assert.match(result.messages.at(-1).content, /Correct <model>α<\/model>/);
    assert.match(result.messages.at(-1).content, /approved choice/);
    assert.doesNotMatch(JSON.stringify(result.messages), /old-private-canary/);
    assert.deepEqual(result.usage.omitted, ["obsolete"]);
    assert.throws(() => builder.build({ messages: [user("critical".repeat(2000))], critical: {} }), {
        code: "CONTEXT_INPUT_LIMIT",
    });
    assert.deepEqual(boundedHistory([user("earlier"), { role: "assistant", content: "answer" }, user("now")], 100), [
        user("earlier"),
        { role: "assistant", content: "answer" },
        user("now"),
    ]);
});

test("provider schemas are discovered on demand and large results are losslessly paged", async () => {
    const tools = Array.from({ length: 80 }, (_, i) => ({
        name: "model_" + i,
        description: "Validation " + "description ".repeat(100),
        inputSchema: {
            type: "object",
            properties: { content: { type: "string", description: "content ".repeat(100) } },
        },
    }));
    let called = 0;
    const full = { structuredContent: { content: "α\n".repeat(12000) }, isError: false };
    full.content = [{ type: "text", text: JSON.stringify(full.structuredContent) }];
    const run = executionContext(
        { contextBudget: { session: 180000 } },
        {
            messages: [user("Validate model")],
            tools,
            callTool: async (name) => {
                called++;
                assert.equal(name, "model_1");
                return full;
            },
            onEvent() {},
        },
    );
    assert(estimateTokens(run.tools) < estimateTokens(tools) * 0.1);
    assert.equal(run.tools.length, 3);
    const catalogue = await run.callTool("workspace_tools", { query: "validation" });
    assert.equal(catalogue.total, 80);
    assert.equal(catalogue.nextOffset, 12);
    assert.deepEqual(await run.callTool("workspace_tools", { name: "model_1" }), tools[1]);
    let page = await run.callTool("workspace_call", { name: "model_1", argumentsJson: "{}" });
    assert(page.paged);
    let text = page.content;
    while (page.nextOffset !== null) {
        assert(estimateTokens(page) <= 4000);
        page = await run.callTool("workspace_result_read", { id: page.id, offset: page.nextOffset });
        text += page.content;
    }
    assert.deepEqual(JSON.parse(text), { structuredContent: full.structuredContent, isError: false });
    assert.equal(called, 1);
    await assert.rejects(run.callTool("workspace_call", { name: "aql_execute", argumentsJson: "{}" }), /unavailable/);
    await assert.rejects(run.callTool("workspace_result_read", { id: "another-user-result", offset: 0 }), /not found/);
    await assert.rejects(run.callTool("workspace_call", { name: "model_1", argumentsJson: "null" }), /object/);
});

test("deduplication preserves distinct warnings and errors, and budget failure cannot silently cut instructions", () => {
    const result = {
        isError: true,
        structuredContent: { success: false },
        content: [
            { type: "text", text: '{"success":false}' },
            { type: "text", text: "Useful warning" },
        ],
    };
    assert.deepEqual(compactToolResult(result).content, [{ type: "text", text: "Useful warning" }]);
    assert.throws(() => executionContext({}, { messages: [user("x".repeat(50000))], tools: [] }), {
        code: "CONTEXT_INPUT_LIMIT",
    });
    const run = executionContext(
        { contextBudget: { session: 24000 } },
        { messages: [user("now")], tools: [], onEvent() {} },
    );
    assert.doesNotThrow(() => run.onEvent({ type: "delta", text: "x".repeat(80000) }));
    assert.equal(run.signal.reason, "CONTEXT_LIMIT");
});

test("session affinity is bounded and rotates for clean review, task, model, project, failure and age changes", () => {
    const manager = new SessionManager({ contextBudget: { turns: 2 } });
    const args = { provider: "codex", model: "model", family: "TEMPLATE", boundary: "one", messageIndex: 0 };
    const first = manager.select(null, args);
    manager.close(first, "idle", { estimatedInputTokens: 200 });
    const second = manager.select(first, { ...args, messageIndex: 2 });
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(manager.select(second, args).rotationReason, "context_threshold");
    for (const [change, reason] of [
        [{ mode: "independent" }, "independent_validation"],
        [{ mode: "fresh" }, "user_request"],
        [{ model: "other" }, "provider_changed"],
        [{ family: "FHIR" }, "task_family_changed"],
        [{ boundary: "other" }, "project_state_changed"],
    ]) {
        const next = manager.select(first, { ...args, ...change });
        assert.equal(next.rotationReason, reason);
        assert.equal(next.generation, 2);
        assert.notEqual(next.sessionId, first.sessionId);
    }
    assert.equal(manager.select({ ...first, status: "failed" }, args).rotationReason, "failed");
    assert.equal(manager.select({ ...first, status: "completed" }, args).rotationReason, "completed");
    assert.equal(manager.select({ ...first, lastUsedAt: new Date(0).toISOString() }, args).rotationReason, "stale");
});

test("project tasks and exact drafts survive chat deletion, restart and retention without crossing identities", (t) => {
    const { config, store, chat, project } = fixture(t);
    const execute = new TaskOrchestrator(config, store, "alice", chat);
    const messages = [user("Create a renal template")];
    execute.prepare(messages, metadata, {}, "alice");
    const checkpoints = new Checkpoints(config, "alice", chat.id, execute.ledger);
    const draftId = checkpoints.draft("exact template bytes", "renal.oet");
    execute.task.drafts = checkpoints.summary().drafts;
    execute.handoff({
        result: "Draft created",
        decisions: ["Proposed only"],
        unresolvedIssues: ["Native validation required"],
    });
    execute.finish("completed");
    const id = execute.task.id;
    const stale = new Date(Date.now() - 31 * 86400000);
    utimesSync(store.path("alice", chat.id), stale, stale);
    store.prune();
    Checkpoints.prune(config);
    const next = store.create("alice", "codex", null, project.id);
    const fresh = new TaskOrchestrator(config, store, "alice", next);
    assert.equal(fresh.ledger.get(id).handoff.result, "Draft created");
    assert.equal(
        new Checkpoints(config, "alice", next.id, fresh.ledger).getDraft(draftId).content,
        "exact template bytes",
    );
    assert.equal(new TaskLedger(config, "bob", project.id).get(id), null);
    const other = store.saveProject("alice", "Other");
    assert.equal(new TaskLedger(config, "alice", other.id).get(id), null);
    const directory = join(fresh.ledger.directory, id);
    assert(!readFileSync(join(directory, readdirSync(directory)[0]), "utf8").includes("Draft created"));
});

test("independent review excludes generator history, handoffs and recovery while retaining current project instructions", (t) => {
    const { config, store, chat } = fixture(t);
    const first = new TaskOrchestrator(config, store, "alice", chat);
    first.prepare([user("Create a template")], metadata, {}, "alice");
    first.handoff({ result: "generator-reasoning-canary" });
    first.finish("completed");
    const second = new TaskOrchestrator(config, store, "alice", chat);
    const context = second.prepare(
        [
            user("Create a template"),
            { role: "assistant", content: "generator-transcript-canary" },
            user("Review template independently"),
        ],
        { ...metadata, recovery: { drafts: [{ name: "generator-draft-canary" }] } },
        { sessionMode: "independent" },
        "alice",
    );
    assert.equal(context.length, 1);
    assert.doesNotMatch(JSON.stringify(context), /generator-(reasoning|transcript|draft)-canary/);
    assert.match(context[0].content, /read requirements\/traceability.json/);
    assert.match(context[0].content, /deterministic validators first/);
    assert.equal(first.ledger.get(first.task.id).session.status, "rotated");
});

test("parallel task records remain independent and stale project configuration is rejected", (t) => {
    const { config, store, project, chat } = fixture(t);
    const other = store.create("alice", "codex", null, project.id);
    const runs = [chat, other].map((item) => new TaskOrchestrator(config, store, "alice", item));
    for (const [i, run] of runs.entries()) run.prepare([user("Task " + i)], metadata, {}, "alice");
    runs[1].finish("completed");
    runs[0].finish("failed", { reason: "CONTEXT_LIMIT" });
    assert.equal(runs[0].ledger.list().items.length, 2);
    assert.equal(runs[0].ledger.get(runs[1].task.id).status, "completed");
    store.saveProject("alice", project.name, project.id, { instructions: "new", expectedRevision: project.revision });
    assert.throws(
        () =>
            store.saveProject("alice", project.name, project.id, {
                instructions: "stale",
                expectedRevision: project.revision,
            }),
        { status: 409 },
    );
    assert.equal(store.project("alice", project.id).instructions, "new");
});

test("project template packages retain exact dependencies beyond the conversation cache", (t) => {
    const { config, chat, project } = fixture(t);
    const ledger = new TaskLedger(config, "alice", project.id);
    const packages = new TemplatePackages(config, "alice", chat.id, ledger);
    packages.capture(
        "template_build_oet",
        {},
        {
            structuredContent: {
                result: {
                    content: "template",
                    dependencies: [{ identifier: "openEHR-EHR-OBSERVATION.test.v1", content: "exact archetype" }],
                },
            },
        },
    );
    const hash = packages.entries()[0].hash;
    packages.delete();
    assert.equal(
        new TaskLedger(config, "alice", project.id).get(hash, "package").dependencies[0].content,
        "exact archetype",
    );
});

test("deleting a project grouping preserves its remaining chats' task and draft recovery", (t) => {
    const { config, store, chat, project } = fixture(t);
    const run = new TaskOrchestrator(config, store, "alice", chat);
    run.prepare([user("Create a template")], metadata, {}, "alice");
    const checkpoints = new Checkpoints(config, "alice", chat.id, run.ledger);
    const draftId = checkpoints.draft("retained draft", "template.oet");
    const evidenceId = checkpoints.capture(
        "template_validate",
        { content: "retained draft" },
        { structuredContent: { valid: false, findings: ["fixture missing dependency"] } },
    );
    run.task.drafts = checkpoints.summary().drafts;
    run.finish("completed");
    store.save("alice", chat);
    store.deleteProject("alice", project.id);
    const unfiled = store.get("alice", chat.id);
    const next = new TaskOrchestrator(config, store, "alice", unfiled);
    assert.equal(unfiled.project, null);
    assert.equal(next.ledger.get(run.task.id).status, "completed");
    checkpoints.delete();
    const restored = new Checkpoints(config, "alice", chat.id, next.ledger);
    assert.equal(restored.getDraft(draftId).content, "retained draft");
    assert.match(restored.read({ id: evidenceId }).content, /fixture missing dependency/);
});

test("budget settings are validated and common credentials are removed from task metadata", () => {
    for (const value of ["NaN", "-1", "1.5", "Infinity"])
        assert.throws(() => loadConfig({ CHAT_CONTEXT_INPUT_TOKENS: value }), /Invalid/);
    assert.throws(
        () => loadConfig({ CHAT_CONTEXT_INPUT_TOKENS: "48000", CHAT_CONTEXT_SESSION_TOKENS: "48000" }),
        /relationship/,
    );
    const value = safeMetadata({
        token: "private",
        messages: ["hidden"],
        result: "api_key=secret sk-proj-abcdefghijklmnopqrstuvwxyz Bearer private-access",
    });
    assert.doesNotMatch(JSON.stringify(value), /secret|private|abcdefghijklmnopqrstuvwxyz|hidden/);
});

test("deterministic validators resolve exact retained drafts and dependency bytes without model retranscription", async (t) => {
    const { config, store, chat, project } = fixture(t);
    const ledger = new TaskLedger(config, "alice", project.id);
    const content = "synthetic template\n".repeat(12000);
    const checkpoints = new Checkpoints(config, "alice", chat.id, ledger);
    const id = checkpoints.draft(content, "large.oet");
    const packages = new TemplatePackages(config, "alice", chat.id, ledger);
    const dependencies = [{ identifier: "openEHR-EHR-COMPOSITION.fixture.v1", content: "exact dependency" }];
    packages.capture("template_build_oet", {}, { structuredContent: { content, dependencies } });
    checkpoints.delete();
    packages.delete();
    let calls = 0;
    const mcp = {
        tools: async () => [
            {
                name: "template_validate",
                inputSchema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { content: { type: "string" }, dependencies: { type: "array" } },
                    required: ["content"],
                },
            },
        ],
        call: async (name, args) => {
            calls++;
            assert.equal(name, "template_validate");
            assert.equal(args.content, content);
            assert.deepEqual(args.dependencies, dependencies);
            assert.equal(args.draftId, undefined);
            return { structuredContent: { valid: true } };
        },
    };
    const next = store.create("alice", "codex", null, project.id);
    const workspace = new WorkspaceTools(
        mcp,
        { config },
        null,
        "alice",
        next,
        new AbortController().signal,
        false,
        null,
        new TaskOrchestrator(config, store, "alice", next),
    );
    const schema = (await workspace.tools()).find((tool) => tool.name === "template_validate").inputSchema;
    assert(schema.properties.draftId);
    assert.deepEqual(schema.required, []);
    const args = { draftId: id };
    assert.equal((await workspace.call("template_validate", args)).structuredContent.valid, true);
    assert.deepEqual(args, { draftId: id });
    await assert.rejects(workspace.call("template_validate", { draftId: id, content: "changed" }), /do not match/);
    await assert.rejects(workspace.call("template_validate", { draftId: "unknown" }), /unavailable/);
    assert.equal(calls, 1);
});
