import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalConnections } from "../src/personal-connections.mjs";
import { RepositoryModels } from "../src/repository-models.mjs";
import { WorkspaceTools } from "../src/workspace-tools.mjs";

test("warm model packages reuse encrypted immutable archetypes but recheck upstream access", async (t) => {
    const { models, connections, args, state } = fixture(t);
    const first = await models.package(args);
    const before = state.requests.length;
    const warm = new RepositoryModels(connections, "alice");
    assert.deepEqual(await warm.package({ ...args, ref }), first);
    assert.equal(state.requests.length - before, 1, "only authorization/head is fetched on a warm read");
    assert(warm.cacheHits >= 3);
    connections.request = async () => ({ status: 403, text: "{}" });
    await assert.rejects(new RepositoryModels(connections, "alice").package({ ...args, ref }));
});

const hash = (text) => createHash("sha256").update(text).digest("hex");
const gitHash = (text) =>
    createHash("sha1")
        .update("blob " + Buffer.byteLength(text) + "\0" + text)
        .digest("hex");
const ref = "a".repeat(40),
    path = "AKI/templates/oet/aki.oet";
function fixture(t, kind = "github") {
    const directory = mkdtempSync(join(tmpdir(), "repository-models-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const identifier = "openEHR-EHR-COMPOSITION.encounter.v1";
    const adlPath = "archetypes/" + identifier + ".adl";
    const manifest = {
        schema: "openehr-template-package/1",
        template: { path: "templates/oet/aki.oet", sha256: hash("<template/>") },
        archetypes: [{ identifier, path: adlPath, sha256: hash("exact archetype") }],
    };
    const state = {
        files: {
            [path]: "<template/>",
            ["AKI/" + adlPath]: "exact archetype",
            "AKI/data/json/template-packages/aki.oet.json": JSON.stringify(manifest),
        },
        ref,
        requests: [],
        interrupted: 0,
        truncated: false,
        missingManifest: false,
    };
    const reply = (data, status = 200) => ({ status, text: JSON.stringify(data) });
    const config = { dataDir: directory, providerEncryptionKey: "ab".repeat(32) };
    const connections = new PersonalConnections(config, {
        request: async (url, options) => {
            assert.equal(options.method, undefined, "model inspection must never write");
            assert.equal(options.token, "private-token");
            const target = new URL(url);
            state.requests.push(target);
            if (target.pathname.includes("/git/ref/") || target.pathname.includes("/repository/branches/"))
                return reply({ object: { sha: state.ref }, commit: { id: state.ref } });
            if (target.pathname.endsWith("/commits")) return reply([{ sha: ref, id: ref }]);
            const tree = Object.keys(state.files).map((path) => ({
                path,
                type: "blob",
                sha: gitHash(state.files[path]),
                id: "b".repeat(40),
            }));
            if (target.pathname.includes("/git/trees/")) {
                assert(target.pathname.includes(ref));
                return reply({ tree, truncated: state.truncated });
            }
            if (target.pathname.includes("/git/blobs/")) {
                assert.equal(options.accept, "application/vnd.github.raw+json");
                if (state.interrupted > 0) {
                    state.interrupted--;
                    throw Object.assign(new Error("Interrupted read"), { status: 503 });
                }
                const content = Object.values(state.files).find(
                    (value) => gitHash(value) === target.pathname.split("/").at(-1),
                );
                return { status: 200, text: state.corruptBlob ? "corrupted" : content };
            }
            assert.equal(target.searchParams.get("ref"), ref, "every file and page must use the listed commit");
            if (target.pathname.endsWith("/repository/tree")) {
                const page = Number(target.searchParams.get("page"));
                return reply(tree.slice((page - 1) * 100, page * 100));
            }
            const name = decodeURIComponent(
                target.pathname.split(kind === "github" ? "/contents/" : "/repository/files/")[1],
            );
            if (state.interrupted > 0) {
                state.interrupted--;
                throw Object.assign(new Error("Interrupted read"), { status: 503 });
            }
            const content = state.files[name];
            return content === undefined
                ? reply({}, 404)
                : reply({
                      type: "file",
                      encoding: "base64",
                      content: Buffer.from(content).toString("base64"),
                      sha: "b".repeat(40),
                      last_commit_id: "b".repeat(40),
                  });
        },
    });
    const repo = connections.add("alice", {
        kind,
        url: "https://" + (kind === "github" ? "github.com" : "gitlab.com") + "/alice/models",
        branch: "main",
        label: "My models",
        token: "private-token",
    }).connection;
    const models = new RepositoryModels(connections, "alice", AbortSignal.timeout(10000));
    const args = { repository: repo.id, path, ref };
    return { models, state, args, manifest, connections, identifier, config };
}

for (const kind of ["github", "gitlab"])
    test(kind + " AQL listing finds templates beyond 100 archetypes and pins all package reads", async (t) => {
        const { models, state, args } = fixture(t, kind);
        state.files = {
            ...Object.fromEntries(
                Array.from({ length: 220 }, (_, i) => ["library/archetypes/model" + i + ".adl", "ADL"]),
            ),
            ...state.files,
        };
        const listed = await models.list({ repository: args.repository });
        assert.equal(listed.items[0].path, path);
        assert.equal(listed.ref, ref);
        assert.equal(listed.items.length, 222);
        state.ref = "c".repeat(40); // Branch moves between listing and inspection.
        state.interrupted = 1;
        const loaded = await models.package(args);
        assert.equal(loaded.ref, ref);
        assert.equal(loaded.dependencySource, "verified_manifest");
        assert.equal(loaded.dependencies.length, 1);
        assert.equal(loaded.dependencies[0].content, "exact archetype");
        assert(!JSON.stringify(loaded).includes("private-token"));
    });

test("repository AQL refuses stale templates, altered or missing dependencies and malicious manifest paths", async (t) => {
    for (const failure of ["template", "hash", "missing", "traversal", "duplicate", "json"]) {
        const { models, state, args, manifest } = fixture(t);
        if (failure === "template") state.files[path] = "changed template";
        if (failure === "hash") state.files["AKI/" + manifest.archetypes[0].path] = "changed archetype";
        if (failure === "missing") delete state.files["AKI/" + manifest.archetypes[0].path];
        if (failure === "traversal") manifest.archetypes[0].path = "archetypes/../../other.adl";
        if (failure === "duplicate") manifest.archetypes.push(manifest.archetypes[0]);
        state.files["AKI/data/json/template-packages/aki.oet.json"] =
            failure === "json" ? "{" : JSON.stringify(manifest);
        await assert.rejects(models.package(args), /package|archetype|traversal|manifest/i);
    }
});

test("legacy templates load only their project's archetypes; OPTs need no dependencies", async (t) => {
    const { models, state, args } = fixture(t);
    delete state.files["AKI/data/json/template-packages/aki.oet.json"];
    state.files["Other/archetypes/elsewhere.adl"] = "unrelated";
    state.files["AKI/templates/opt/aki.opt"] = "compiled";
    const loaded = await models.package(args);
    assert.equal(loaded.dependencySource, "project_folder");
    assert.equal(loaded.dependencies.length, 1);
    assert.deepEqual((await models.package({ ...args, path: "AKI/templates/opt/aki.opt" })).dependencies, []);
});

test("AQL source reads enforce ownership, immutable refs, complete listings and bounded dependencies", async (t) => {
    const { models, state, args, connections, manifest } = fixture(t);
    await assert.rejects(new RepositoryModels(connections, "bob").package(args), /not found/i);
    await assert.rejects(models.get({ ...args, ref: "main" }), /exact revision/);
    state.truncated = true;
    await assert.rejects(models.list(args), /too large/);
    state.truncated = false;
    models.trees.clear();
    manifest.archetypes = Array.from({ length: 65 }, (_, i) => ({
        ...manifest.archetypes[0],
        identifier: "openEHR-EHR-CLUSTER.fixture.v" + i,
        path: "archetypes/fixture" + i + ".adl",
    }));
    state.files["AKI/data/json/template-packages/aki.oet.json"] = JSON.stringify(manifest);
    await assert.rejects(models.package(args), /64/);
});

test("raw model downloads must match the Git blob hash", async (t) => {
    const { models, state, args } = fixture(t);
    state.corruptBlob = true;
    await assert.rejects(models.package(args), /did not match its Git revision/);
});

test("assistant inspects, generates and validates using compiled exact repository bytes without exposing archetype contents", async (t) => {
    const { models, args, identifier, connections } = fixture(t);
    const calls = [];
    const mcp = {
        tools: async () => [],
        call: async (name, input) => {
            calls.push(name);
            let result;
            if (name === "template_compile") {
                assert.equal(input.content, "<template/>");
                assert.deepEqual(input.dependencies, [{ identifier, content: "exact archetype" }]);
                result = { valid: true, output: { format: "opt14_xml", content: "compiled exact OPT" } };
            } else {
                assert.equal(
                    input.content,
                    name === "aql_validate" ? "SELECT m FROM COMPOSITION m" : "compiled exact OPT",
                );
                if (name === "model_inspect")
                    result = {
                        valid: true,
                        identifier: "AKI",
                        inspection: {
                            paths: Array.from({ length: 120 }, (_, i) => ({ path: "/field" + i, rm_type: "DV_TEXT" })),
                        },
                    };
                if (name === "model_generate_aql") {
                    assert.deepEqual(input.paths, ["/field1"]);
                    result = {
                        query: "SELECT m/field1 FROM COMPOSITION m",
                        source_sha256: hash("compiled exact OPT"),
                        validation: { valid: true },
                        inspection: { large: true },
                    };
                }
                if (name === "aql_validate") {
                    assert.equal(input.templates[0].content, "compiled exact OPT");
                    assert.match(input.templates[0].identifier, /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,299}$/);
                    result = { valid: false, status: "FAIL" };
                }
            }
            return { structuredContent: { success: true, result } };
        },
    };
    const workspace = new WorkspaceTools(
        mcp,
        connections,
        null,
        "alice",
        { id: "chat" },
        AbortSignal.timeout(10000),
        false,
    );
    const tools = await workspace.tools();
    assert(tools.some((tool) => tool.name === "personal_repository_aql"));
    const inspected = (await workspace.call("personal_repository_aql", { ...args, action: "inspect" }))
        .structuredContent;
    assert.equal(inspected.paths.length, 100);
    assert.equal(inspected.nextOffset, 100);
    assert(!JSON.stringify(inspected).includes("exact archetype"));
    const next = await models.aql({ ...args, action: "inspect", offset: 100 }, mcp);
    assert.equal(next.paths.length, 20);
    await assert.rejects(models.aql({ ...args, ref: undefined, action: "generate" }, mcp), /exact commit/);
    const generated = await models.aql({ ...args, action: "generate", paths: ["/field1"] }, mcp);
    assert.equal(generated.validation.valid, true);
    assert.equal(generated.source_sha256, hash("<template/>"));
    assert.equal(generated.model_sha256, hash("compiled exact OPT"));
    assert.equal(generated.inspection, undefined);
    const checked = await models.aql({ ...args, action: "validate", query: "SELECT m FROM COMPOSITION m" }, mcp);
    assert.equal(checked.validation.valid, false);
    assert(calls.includes("aql_validate"));
});
