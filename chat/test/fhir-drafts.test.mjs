import test from "node:test";
import assert from "node:assert/strict";
import { Checkpoints } from "../src/checkpoints.mjs";
import { hydrateFhirDrafts, retainFhirDrafts } from "../src/fhir-drafts.mjs";
import { estimateTokens } from "../src/context-budget.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";

const args = (action, input) => ({ action, projectId: "fhir-dev", arguments: JSON.stringify(input) });
const envelope = (result) => ({
    structuredContent: { success: true, result },
    content: [{ type: "text", text: JSON.stringify({ success: true, result }) }],
});
test("large FHIR outputs retain exact private bytes and expose bounded draft references", () => {
    const checkpoints = new Checkpoints({}, "alice", "chat");
    const content =
        JSON.stringify({ resourceType: "StructureDefinition", description: "synthetic profile\n".repeat(15000) }) +
        "\r\n";
    const response = retainFhirDrafts(
        "fhir_fsh_compile",
        { projectId: "fhir-dev" },
        envelope({
            success: true,
            files: [{ path: "fsh-generated/resources/profile.json", content }],
            diagnostics: [{ severity: "warning", message: "Review terminology separately" }],
        }),
        checkpoints,
    );
    const file = response.structuredContent.result.files[0];
    assert.ok(file.draftId);
    assert.equal(file.content, undefined);
    assert.equal(checkpoints.getDraft(file.draftId).content, content);
    assert.ok(estimateTokens(response) < 1000);
    assert.match(JSON.stringify(response), /Review terminology separately/);
    const hydrated = hydrateFhirDrafts("fhir_artifact", args("validate", { draftId: file.draftId }), checkpoints);
    assert.equal(JSON.parse(hydrated.arguments).content, content);
    assert.equal(JSON.parse(hydrated.arguments).draftId, undefined);
    const other = new Checkpoints({}, "bob", "chat");
    assert.throws(
        () => hydrateFhirDrafts("fhir_artifact", args("validate", { draftId: file.draftId }), other),
        /unavailable/,
    );
});
test("FSH compilation and example profile validation reuse exact retained artifacts without retranscription", () => {
    const checkpoints = new Checkpoints({}, "alice", "chat");
    const fsh = "Profile: DevPatient\r\nParent: Patient\r\n* active 1..1\r\n";
    const source = retainFhirDrafts(
        "fhir_profile",
        args("generate", {}),
        envelope({ fsh, files: [{ path: "input/fsh/DevPatient.fsh", content: fsh }] }),
        checkpoints,
    ).structuredContent.result;
    assert.equal(source.fsh, undefined);
    const request = {
        projectId: "fhir-dev",
        arguments: JSON.stringify({ files: [{ path: source.files[0].path, draftId: source.files[0].draftId }] }),
    };
    assert.equal(
        JSON.parse(hydrateFhirDrafts("fhir_fsh_compile", request, checkpoints).arguments).files[0].content,
        fsh,
    );
    assert.equal(JSON.parse(request.arguments).files[0].content, undefined);
    const profile = { resourceType: "StructureDefinition", url: "https://example.org/dev" };
    const profileId = checkpoints.draft(JSON.stringify(profile), "profile.json");
    const exampleId = checkpoints.draft('{"resourceType":"Patient","active":true}', "example.json");
    const input = args("validate", { draftId: exampleId, profileDraftIds: [profileId], profile: profile.url });
    const output = JSON.parse(hydrateFhirDrafts("fhir_artifact", input, checkpoints).arguments);
    assert.deepEqual(output.profiles, [profile]);
    assert.equal(output.content, '{"resourceType":"Patient","active":true}');
    assert.equal(output.profileDraftIds, undefined);
    assert.throws(
        () => hydrateFhirDrafts("fhir_artifact", args("validate", { profileDraftIds: [exampleId] }), checkpoints),
        /StructureDefinition/,
    );
});
test("large FHIR batches never replace content with an already evicted draft reference", () => {
    const checkpoints = new Checkpoints({}, "alice", "chat");
    const files = Array.from({ length: 20 }, (_, index) => ({
        path: `profile-${index}.json`,
        content: JSON.stringify({ resourceType: "StructureDefinition", id: `profile-${index}` }),
    }));
    const result = retainFhirDrafts("fhir_fsh_compile", {}, envelope({ files }), checkpoints).structuredContent.result;
    assert.equal(result.files.length, files.length);
    for (const [index, file] of result.files.entries())
        assert.equal(file.draftId ? checkpoints.getDraft(file.draftId).content : file.content, files[index].content);
});
test("retained FHIR references reject conflicting content, mutations and independent-review generator access", () => {
    const checkpoints = new Checkpoints({}, "alice", "chat");
    const id = checkpoints.draft('{"resourceType":"Patient"}', "patient.json");
    for (const input of [
        args("validate", { draftId: id, content: "different" }),
        args("validate", { draftId: id, resource: {} }),
        args("save", { draftId: id }),
        args("validate", { profileDraftIds: [id], profiles: [] }),
    ])
        assert.throws(() => hydrateFhirDrafts("fhir_artifact", input, checkpoints));
    assert.throws(
        () => hydrateFhirDrafts("fhir_artifact", args("validate", { draftId: id }), checkpoints, { independent: true }),
        (error) => error.status === 403,
    );
    assert.equal(
        JSON.parse(
            hydrateFhirDrafts("fhir_artifact", args("diff", { beforeDraftId: id, afterDraftId: id }), checkpoints)
                .arguments,
        ).before,
        '{"resourceType":"Patient"}',
    );
});
test("workspace FHIR dispatch hydrates computational arguments while retaining mutation permission checks", async () => {
    const checkpoints = new Checkpoints({}, "alice", "chat");
    const content = '{"resourceType":"Patient","active":true}';
    const id = checkpoints.draft(content, "patient.json");
    const calls = [];
    const workspace = Object.create(WorkspaceTools.prototype);
    Object.assign(workspace, {
        checkpoints,
        personal: [],
        conversation: {},
        allowWrites: false,
        packages: { capture() {} },
        mcp: {
            async call(name, input) {
                calls.push({ name, input });
                return envelope({ valid: true });
            },
        },
    });
    const result = await workspace.call("fhir_artifact", args("validate", { draftId: id }));
    assert.equal(result.structuredContent.result.valid, true);
    assert.equal(JSON.parse(calls[0].input.arguments).content, content);
    assert.ok(workspace.lastCheckpoint);
    await assert.rejects(workspace.call("fhir_artifact", args("save", { content })), (error) => error.status === 403);
    workspace.execution = { task: { mode: "independent" } };
    await assert.rejects(
        workspace.call("fhir_artifact", args("validate", { draftId: id })),
        (error) => error.status === 403,
    );
    assert.throws(
        () => workspace.resolveDraft("personal_repository_save", { draftId: id }),
        (error) => error.status === 403,
    );
    assert.equal(calls.length, 1);
});
