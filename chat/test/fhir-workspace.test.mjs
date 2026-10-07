import test from "node:test";
import assert from "node:assert/strict";
import { FhirWorkspace, fhirResult, isFhirWrite, validateFhirCall } from "../src/fhir-workspace.mjs";
import { McpClient, isWriteTool } from "../src/mcp.mjs";
import { artifactPath, fhirArtifactPath } from "../src/repository-paths.mjs";
import { recordArtifact } from "../src/project-moves.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";
const tool = "fhir_project";
const create = {
    tool,
    args: {
        action: "create",
        projectId: "clinical",
        document: JSON.stringify({ name: "Clinical", fhirVersion: "4.0.1" }),
    },
};
function client() {
    return {
        calls: [],
        tools: async () => [{ name: tool }, { name: "fhir_artifact" }, { name: "fhir_package" }],
        async call(name, args) {
            this.calls.push({ name, args });
            return { structuredContent: { success: true, result: { executed: true } } };
        },
    };
}
test("FHIR browser changes require an exact identity-bound, one-use review before execution", async () => {
    const service = client(),
        workspace = new FhirWorkspace({ allowWrites: true });
    const preview = await workspace.execute(service, "alice", create);
    assert.equal(preview.confirmationRequired, true);
    assert.equal(service.calls.length, 0);
    await assert.rejects(
        workspace.execute(service, "bob", { ...create, confirmation: preview.confirmation }),
        (e) => e.status === 409,
    );
    await assert.rejects(
        workspace.execute(service, "alice", {
            ...create,
            args: { ...create.args, projectId: "other" },
            confirmation: preview.confirmation,
        }),
        (e) => e.status === 409,
    );
    const result = await workspace.execute(service, "alice", { ...create, confirmation: preview.confirmation });
    assert.equal(result.result.executed, true);
    assert.equal(service.calls.length, 1);
    await assert.rejects(
        workspace.execute(service, "alice", { ...create, confirmation: preview.confirmation }),
        (e) => e.status === 409,
    );
});
test("FHIR confirmation expiry and installation write policy cannot be bypassed", async () => {
    let now = 1000;
    const service = client(),
        workspace = new FhirWorkspace({ allowWrites: true, now: () => now });
    const preview = await workspace.execute(service, "alice", create);
    now += 120001;
    await assert.rejects(
        workspace.execute(service, "alice", { ...create, confirmation: preview.confirmation }),
        (e) => e.status === 409,
    );
    const readonly = new FhirWorkspace({ allowWrites: false });
    await assert.rejects(readonly.execute(service, "alice", create), (e) => e.status === 403);
    await readonly.execute(service, "alice", { tool, args: { action: "list" } });
    assert.equal(service.calls.length, 1);
});
test("multiplexed tools distinguish read and write actions and reject newly invented actions", async () => {
    assert.equal(isWriteTool("fhir_project", { action: "get" }), false);
    assert.equal(isWriteTool("fhir_project", { action: "update" }), true);
    assert.equal(isWriteTool("fhir_package", { action: "install" }), true);
    assert.equal(isWriteTool("fhir_profile", { action: "generate" }), false);
    assert.equal(isWriteTool("fhir_example_generate", { projectId: "clinical", arguments: "{}" }), false);
    assert.doesNotThrow(() => validateFhirCall("fhir_example_generate", { projectId: "clinical", arguments: "{}" }));
    assert.throws(() =>
        validateFhirCall("fhir_example_generate", { action: "publish", projectId: "clinical", arguments: "{}" }),
    );
    assert.equal(isWriteTool("fhir_artifact", { action: "validate" }), false);
    assert.equal(isWriteTool("fhir_ig", { action: "sync" }), true);
    assert.equal(isFhirWrite("fhir_project", { action: "unknown-future-write" }), true);
    for (const args of [
        { action: "delete", projectId: "clinical" },
        { action: "get", projectId: "../other" },
        { action: "get", projectId: "clinical", owner: "other" },
        { action: "update", projectId: "clinical", document: "[]" },
    ])
        assert.throws(() => validateFhirCall(tool, args));
    assert.throws(() => validateFhirCall("model_artifact_save", {}));
});
test("MCP read-only installation exposes FHIR reads and denies mutations before transport", async () => {
    const mcp = new McpClient({ allowWrites: false }, AbortSignal.timeout(10000));
    let called = false;
    mcp.tools = async () => [{ name: "fhir_project" }];
    mcp.rpc = async () => {
        called = true;
        return {};
    };
    await assert.rejects(mcp.call("fhir_project", create.args), /writes are disabled/);
    assert.equal(called, false);
    await mcp.call("fhir_project", { action: "list" });
    assert.equal(called, true);
});
test("FHIR validation failure evidence remains failure even in a successful tool envelope", () => {
    assert.deepEqual(
        fhirResult({
            structuredContent: {
                success: true,
                result: { valid: false, status: "FAIL", diagnostics: ["missing required code"] },
            },
        }).result,
        { valid: false, status: "FAIL", diagnostics: ["missing required code"] },
    );
    assert.throws(
        () =>
            fhirResult({
                structuredContent: {
                    success: false,
                    error: { code: "VALIDATOR_FAILED", message: "Authorization: Bearer private-token" },
                },
            }),
        (e) => e.code === "VALIDATOR_FAILED" && !e.message.includes("private-token"),
    );
});
test("FHIR and mapping source layout stays intact without changing openEHR organization", () => {
    assert.equal(artifactPath("Patient.json"), "data/json/Patient.json");
    for (const path of [
        "input/fsh/Patient.fsh",
        "input/resources/Patient.json",
        "input/examples/patient.xml",
        "sushi-config.yaml",
        "fsh-generated/resources/StructureDefinition-local.json",
    ])
        assert.equal(fhirArtifactPath("project/" + path, "project"), "project/" + path);
    assert.equal(fhirArtifactPath("mappings/weight.json", "", "mappings"), "mappings/weight.json");
    for (const path of [
        "input/fsh/../secrets",
        "input/fsh/.private",
        "../input/fsh/a.fsh",
        "input//fsh/a.fsh",
        ".env",
        ".github/workflows/execute.yml",
    ])
        assert.throws(() => fhirArtifactPath(path));
    const chat = { folder: "" };
    assert.equal(
        recordArtifact(chat, { repository: "fhir", standard: "FHIR", path: "input/fsh/Patient.fsh" }).standard,
        "FHIR",
    );
});
test("selected private repository retains FHIR tools but still forbids enterprise openEHR writes", async () => {
    const mcp = {
        tools: async () =>
            ["fhir_project", "fhir_artifact", "model_artifact_save", "ckm_sources"].map((name) => ({ name })),
    };
    const workspace = Object.create(WorkspaceTools.prototype);
    Object.assign(workspace, { mcp, conversation: { repository: "private-repository" }, allowWrites: true, cdr: null });
    const names = (await workspace.tools()).map((item) => item.name);
    assert.ok(names.includes("fhir_project"));
    assert.ok(names.includes("fhir_artifact"));
    assert.ok(!names.includes("model_artifact_save"));
    assert.doesNotThrow(() => workspace.checkWrite("fhir_project", create.args));
    assert.throws(() => workspace.checkWrite("model_artifact_save", {}));
});
