import test from "node:test";
import assert from "node:assert/strict";
import { readModels } from "../src/models.mjs";
import { createHash } from "node:crypto";
function client(result) {
    const calls = [];
    return {
        calls,
        tools: async () => ["model_projects", "model_project_get", "model_artifact_get"].map((name) => ({ name })),
        call: async (name, args) => {
            calls.push({ name, args });
            return { structuredContent: { success: true, result, error: null } };
        },
    };
}
test("browser model adapter exposes fixed reads and strips source from project listings", async () => {
    const c = client({
        project: { id: "default" },
        artifacts: [
            {
                path: "templates/one.oet",
                revision: "a".repeat(40),
                content: "large source",
                metadata: { private: "not needed in index" },
            },
        ],
    });
    const result = await readModels(c, "/chat/api/models/project?project=default");
    assert.equal(result.artifacts[0].content, undefined);
    assert.equal(result.artifacts[0].metadata, undefined);
    assert.deepEqual(c.calls, [{ name: "model_project_get", args: { project: "default" } }]);
    c.call = async (name, args) => {
        c.calls.push({ name, args });
        return {
            structuredContent: {
                success: true,
                result: {
                    path: args.path,
                    revision: args.revision,
                    sha256: "b".repeat(64),
                    content: "synthetic",
                    status: "DRAFT",
                },
                error: null,
            },
        };
    };
    await readModels(
        c,
        "/chat/api/models/artifact?project=default&path=templates%2Fone.oet&revision=" + "a".repeat(40),
    );
    assert.equal(c.calls[1].args.revision, "a".repeat(40));
});
test("browser model requests reject arbitrary tools, duplicated parameters and path traversal before MCP", async () => {
    for (const path of [
        "projects?tenant=other",
        "project?project=default&project=other",
        "project?project=../other",
        "artifact?project=default&path=templates/../secret",
        "artifact?project=default&path=templates/one.oet&revision=HEAD",
        "model_artifact_save",
    ]) {
        const c = client({});
        await assert.rejects(readModels(c, "/chat/api/models/" + path));
        assert.equal(c.calls.length, 0);
    }
});
test("browser model responses redact upstream details and report unavailable revisions", async () => {
    const c = client({});
    c.call = async () => ({
        structuredContent: { success: false, error: { code: "VERSION_NOT_FOUND", message: "private-database-detail" } },
    });
    await assert.rejects(
        readModels(c, "/chat/api/models/projects"),
        (e) => e.status === 404 && !e.message.includes("private"),
    );
    c.call = async () => ({ content: [{ type: "text", text: "bad private response" }] });
    await assert.rejects(
        readModels(c, "/chat/api/models/projects"),
        (e) => e.status === 503 && !e.message.includes("private"),
    );
});

test("browser preserves verified binary originals and rejects corrupt payloads and unsafe filenames", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0, 0xff]);
    const artifact = {
        path: "originals/" + "a".repeat(64) + "/Original ü.zip",
        revision: "b".repeat(40),
        status: "DRAFT",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content: null,
        content_base64: bytes.toString("base64"),
        content_encoding: "base64",
        size_bytes: bytes.length,
    };
    const route = "/chat/api/models/artifact?project=default&path=" + encodeURIComponent(artifact.path);
    assert.deepEqual(await readModels(client(artifact), route), artifact);
    for (const corrupt of [
        { ...artifact, sha256: "0".repeat(64) },
        { ...artifact, size_bytes: 5 },
        { ...artifact, content_base64: artifact.content_base64 + "\n" },
        { ...artifact, content: "fake text" },
    ]) {
        await assert.rejects(readModels(client(corrupt), route), (e) => e.status === 503);
    }
    for (const filename of ["..", "../secret", "a\\b", "a%2fb", "a\0b"]) {
        const c = client(artifact);
        await assert.rejects(
            readModels(
                c,
                "/chat/api/models/artifact?project=default&path=" +
                    encodeURIComponent("originals/" + "a".repeat(64) + "/" + filename),
            ),
        );
        assert.equal(c.calls.length, 0);
    }
});
