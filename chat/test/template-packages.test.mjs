import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalConnections } from "../src/personal-connections.mjs";
import { WorkspaceTools, PERSONAL_WRITE } from "../src/workspace-tools.mjs";
import { RepositoryModels } from "../src/repository-models.mjs";
import { TemplatePackages } from "../src/template-packages.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const gitHash = (value) =>
    createHash("sha1")
        .update("blob " + Buffer.byteLength(value) + "\0" + value)
        .digest("hex");
const source = { identifier: "openEHR-EHR-COMPOSITION.encounter.v1", content: "exact ADL source bytes\n" };
const envelope = (result) => ({ structuredContent: { success: true, result } });
function fixture(t, kind = "github") {
    const directory = mkdtempSync(join(tmpdir(), "template-packages-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = { dataDir: directory, providerEncryptionKey: "ab".repeat(32), allowWrites: true };
    const state = {
        snapshots: {},
        fileRevisions: {},
        sources: [source],
        sequence: 0,
        head: "a".repeat(40),
        files: {},
        writes: [],
        race: false,
        fail: "",
        valid: true,
    };
    const result = (data, status = 200) => ({ status, text: JSON.stringify(data) });
    const connections = new PersonalConnections(config, {
        request: async (url, options) => {
            const path = new URL(url).pathname;
            assert.equal(options.token, "owner-token");
            if (options.method) {
                state.writes.push({ path, ...options });
                if (state.fail && path.endsWith(state.fail))
                    return result({ message: "Resource not accessible by personal access token" }, 403);
            }
            if (path.includes("/git/ref/heads/") || path.includes("/repository/branches/"))
                return result({ object: { sha: state.head }, commit: { id: state.head } });
            const requestedRef =
                new URL(url).searchParams.get("ref") || path.split("/git/trees/")[1]?.split("?")[0] || state.head;
            const files = requestedRef === state.head ? state.files : state.snapshots[requestedRef];
            if (path.includes("/contents/") || path.includes("/repository/files/")) {
                assert(files, "Exact historical snapshot must exist");
                const name = decodeURIComponent(path.split(kind === "github" ? "/contents/" : "/repository/files/")[1]);
                const file = files[name];
                return file === undefined
                    ? result({}, 404)
                    : result({
                          type: "file",
                          encoding: "base64",
                          content: Buffer.from(file).toString("base64"),
                          sha: "b".repeat(40),
                          last_commit_id: state.fileRevisions[name] || "b".repeat(40),
                      });
            }
            if (path.endsWith("/commits") && !options.method)
                return result([{ sha: state.historyCommit || state.head, id: state.historyCommit || state.head }]);
            if (path.includes("/git/commits/") && !options.method) return result({ tree: { sha: "c".repeat(40) } });
            if (path.endsWith("/repository/tree") && !options.method)
                return result(
                    Object.entries(files).map(([path, content]) => ({ path, type: "blob", id: gitHash(content) })),
                );
            if (path.includes("/git/trees/") && !options.method)
                return result({
                    tree: Object.entries(files).map(([path, content]) => ({
                        path,
                        type: "blob",
                        mode: "100644",
                        sha: gitHash(content),
                    })),
                });
            if ((path.includes("/git/blobs/") || path.includes("/repository/blobs/")) && !options.method)
                return {
                    status: 200,
                    text: [state.files, ...Object.values(state.snapshots)]
                        .flatMap((files) => Object.values(files))
                        .find((content) => gitHash(content) === path.split("/blobs/")[1].split("/")[0]),
                };
            if (path.endsWith("/git/trees")) {
                state.pending = options.body.tree;
                return result({ sha: "d".repeat(40) }, 201);
            }
            if (path.endsWith("/git/commits")) {
                assert.deepEqual(options.body.parents, [state.head]);
                state.next = hash(state.head + JSON.stringify(state.pending) + ++state.sequence).slice(0, 40);
                return result({ sha: state.next }, 201);
            }
            if (path.includes("/git/refs/heads/")) {
                assert.equal(options.body.force, false);
                if (state.race) return result({}, 422);
                state.snapshots[state.head] = { ...state.files };
                for (const file of state.pending) state.files[file.path] = file.content;
                state.head = options.body.sha;
                return result({ object: { sha: state.head } });
            }
            if (path.endsWith("/repository/commits")) {
                if (state.race) return result({}, 409);
                state.snapshots[state.head] = { ...state.files };
                const next = hash(state.head + JSON.stringify(options.body.actions) + ++state.sequence).slice(0, 40);
                for (const file of options.body.actions) {
                    state.files[file.file_path] = file.content;
                    state.fileRevisions[file.file_path] = next;
                }
                state.head = next;
                return result({ id: state.head }, 201);
            }
            throw new Error("Unexpected request " + path);
        },
    });
    const repo = connections.add("alice", {
        kind,
        url: kind === "github" ? "https://github.com/alice/models" : "https://gitlab.com/alice/models",
        branch: "draft/renal",
        token: "owner-token",
        label: "My models",
    }).connection;
    const chat = { id: "conversation-one", repository: repo.id, folder: "AKI" };
    const mcp = {
        tools: async () => [],
        call: async (name, args) => {
            if (name === "template_build_oet") {
                state.buildArgs = args;
                const selected = args.archetypes?.length ? args.archetypes : state.upstream || [source];
                return envelope({
                    content: "<template/>",
                    dependencies: selected.map((item) => ({ ...item, sha256: hash(item.content) })),
                });
            }
            assert.equal(name, "template_compile");
            assert.deepEqual(args.dependencies, state.sources);
            return envelope({
                valid: state.valid,
                dependencies: state.sources.map((item) => ({
                    identifier: item.identifier,
                    sha256: hash(item.content),
                })),
                profile: "fixture",
                checks: state.checks || { oet_application: "PASS", adl14_parse: "PASS" },
                output: { sha256: "f".repeat(64) },
                ...(state.generated
                    ? {
                          output: {
                              format: "opt14_xml",
                              content: state.generated.opt,
                              sha256: hash(state.generated.opt),
                          },
                          web_template: {
                              format: "web_template_json",
                              content: state.generated.web,
                              sha256: hash(state.generated.web),
                          },
                      }
                    : {}),
            });
        },
    };
    const makeWorkspace = (identity = "alice", conversation = chat) =>
        new WorkspaceTools(mcp, connections, null, identity, conversation, AbortSignal.timeout(10000), true);
    const args = {
        repository: repo.id,
        path: "AKI/templates/oet/renal.oet",
        content: "<template/>",
        expectedRevision: null,
        message: "Save draft template package",
    };
    return { config, directory, state, connections, repo, chat, makeWorkspace, args, mcp };
}

for (const kind of ["github", "gitlab"])
    test(`${kind} saves linked form outputs at stable paths in separate folders`, async (t) => {
        const f = fixture(t, kind);
        f.state.generated = {
            opt: "<template>" + "x".repeat(1080000) + "</template>",
            web: '{"templateId":"Synthetic","tree":{}}',
        };
        const workspace = f.makeWorkspace();
        await workspace.tools();
        const args = { ...f.args, dependencies: [source] };
        const plan = await workspace.prepareWrite(PERSONAL_WRITE, args);
        assert.equal(plan.files.length, 5);
        await workspace.call(PERSONAL_WRITE, args);
        const manifest = JSON.parse(f.state.files[plan.files.at(-1).path]);
        assert.equal(manifest.generated.length, 2);
        for (const output of manifest.generated) {
            const actual = f.state.files["AKI/" + output.path];
            assert.equal(hash(actual), output.sha256);
            assert(output.path.startsWith(output.kind === "opt" ? "templates/opt/" : "data/json/web-templates/"));
        }
        assert.equal(f.state.files["AKI/" + manifest.generated[0].path], f.state.generated.opt);
    });

for (const kind of ["github", "gitlab"])
    test(`${kind} saves the template and exact archetype bytes together with a relative hash manifest`, async (t) => {
        const f = fixture(t, kind),
            workspace = f.makeWorkspace();
        await workspace.tools();
        const args = { ...f.args, dependencies: [source] };
        const plan = await workspace.prepareWrite(PERSONAL_WRITE, args);
        assert.equal(f.state.writes.length, 0, "preparation is read-only");
        assert.equal(plan.files.length, 3);
        assert.equal(plan.files[1].path, "AKI/archetypes/" + source.identifier + ".adl");
        const saved = (await workspace.call(PERSONAL_WRITE, args)).structuredContent;
        assert.equal(saved.files.length, 3);
        assert.equal(saved.commit, f.state.head);
        assert.equal(f.state.files[f.args.path], f.args.content);
        assert.equal(f.state.files[plan.files[1].path], source.content);
        const manifest = JSON.parse(f.state.files[plan.files[2].path]);
        assert.equal(manifest.template.path, "templates/oet/renal.oet");
        assert.equal(manifest.archetypes[0].sha256, hash(source.content));
        assert.equal(manifest.archetypes[0].path, "archetypes/" + source.identifier + ".adl");
        assert.equal(manifest.clinicalApproval, false);
        assert.equal(f.state.writes.filter((item) => item.path.includes("/contents/")).length, 0);
        if (kind === "gitlab") {
            const write = f.state.writes.at(-1);
            assert.equal(write.body.actions.length, 3);
            assert.equal(write.body.branch, "draft/renal");
            assert.equal(write.body.force, false);
        }
    });

test("generated exact dependencies survive turns encrypted and isolated by profile and conversation", async (t) => {
    const f = fixture(t),
        first = f.makeWorkspace();
    await first.tools();
    await first.call("template_build_oet", {});
    const next = f.makeWorkspace();
    await next.tools();
    assert.equal((await next.prepareWrite(PERSONAL_WRITE, f.args)).files[1].content, source.content);
    const cachePath = join(f.directory, "template-packages", readdirSync(join(f.directory, "template-packages"))[0]);
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), /exact ADL|COMPOSITION/);
    for (const [owner, chat] of [
        ["bob", "conversation-one"],
        ["alice", "conversation-two"],
    ]) {
        const cache = new TemplatePackages(f.config, owner, chat);
        await assert.rejects(cache.files(f.args, "AKI", f.mcp), /exact archetypes/);
    }
    await assert.rejects(
        next.prepareWrite(PERSONAL_WRITE, { ...f.args, content: "<changed-template/>" }),
        /exact archetypes/,
    );
    new TemplatePackages(f.config, "alice", f.chat.id).delete();
    assert.deepEqual(readdirSync(join(f.directory, "template-packages")), []);
});

test("missing, duplicate or unvalidated dependencies never write an OET", async (t) => {
    const f = fixture(t),
        workspace = f.makeWorkspace();
    await workspace.tools();
    await assert.rejects(workspace.call(PERSONAL_WRITE, f.args), /exact archetypes/);
    await assert.rejects(workspace.call(PERSONAL_WRITE, { ...f.args, dependencies: [source, source] }), /unique/);
    f.state.valid = false;
    await assert.rejects(
        workspace.call(PERSONAL_WRITE, { ...f.args, dependencies: [source] }),
        /could not be compiled/,
    );
    assert.equal(f.state.writes.length, 0);
});

for (const kind of ["github", "gitlab"])
    test(`${kind} reuses identical archetypes and refuses concurrent repository changes`, async (t) => {
        const f = fixture(t, kind),
            workspace = f.makeWorkspace();
        await workspace.tools();
        const path = "AKI/archetypes/" + source.identifier + ".adl";
        f.state.files[path] = source.content;
        const args = { ...f.args, dependencies: [source] };
        const plan = await workspace.prepareWrite(PERSONAL_WRITE, args);
        assert.equal(plan.files[1].changed, false);
        f.state.head = "9".repeat(40);
        await assert.rejects(workspace.call(PERSONAL_WRITE, args), /Repository changed/);
        assert.equal(f.state.writes.length, 0);
        f.state.head = plan.base;
        f.state.race = true;
        await assert.rejects(workspace.call(PERSONAL_WRITE, args));
        assert.deepEqual(f.state.files, { [path]: source.content });
        if (kind === "gitlab") {
            const unchanged = f.state.writes.at(-1).body.actions.find((file) => file.file_path === path);
            assert.equal(unchanged.last_commit_id, "b".repeat(40));
        }
    });

test("a bundle permission refusal retains the precise access failure and leaves the branch unchanged", async (t) => {
    const f = fixture(t),
        workspace = f.makeWorkspace();
    await workspace.tools();
    f.state.fail = "/git/trees";
    await assert.rejects(
        workspace.call(PERSONAL_WRITE, { ...f.args, dependencies: [source] }),
        /Contents: Read and write/,
    );
    assert.equal(f.connections.list("alice")[0].lastWriteError.code, "GITHUB_CONTENTS_WRITE_REQUIRED");
    assert.deepEqual(f.state.files, {});
    assert.equal(f.state.head, "a".repeat(40));
});

test("MCP text envelopes retain generator sources and compile dependencies without truncating browser output", async (t) => {
    const f = fixture(t);
    const call = f.mcp.call;
    f.mcp.call = async (...args) => ({
        content: [{ type: "text", text: JSON.stringify((await call(...args)).structuredContent) }],
    });
    const workspace = f.makeWorkspace();
    await workspace.tools();
    const generated = await workspace.call("template_build_oet", {});
    assert.equal(generated.structuredContent.result.dependencies[0].content, undefined);
    assert.match(generated.structuredContent.result.repository_package, /automatically/);
    assert.equal((await workspace.prepareWrite(PERSONAL_WRITE, f.args)).files[1].content, source.content);
    f.mcp.call = async () => ({ content: [{ type: "text", text: JSON.stringify({ success: false, result: null }) }] });
    await assert.rejects(f.makeWorkspace().prepareWrite(PERSONAL_WRITE, { ...f.args }), /could not be compiled/);
});

for (const kind of ["github", "gitlab"])
    test(`${kind} changed hashes advance stable artefacts while exact older templates retain their dependency versions`, async (t) => {
        const f = fixture(t, kind);
        f.state.generated = { opt: "compiled first", web: '{"version":1}' };
        const args = { ...f.args, dependencies: [source] };
        const firstWorkspace = f.makeWorkspace();
        await firstWorkspace.tools();
        const first = (await firstWorkspace.call(PERSONAL_WRITE, args)).structuredContent;
        const archetype = "AKI/archetypes/" + source.identifier + ".adl";
        const opt = "AKI/templates/opt/renal.opt";
        const web = "AKI/data/json/web-templates/renal.webtemplate.json";
        assert.equal(f.state.files[opt], "compiled first");
        const firstManifest = JSON.parse(f.state.files["AKI/data/json/template-packages/renal.oet.json"]);
        assert.equal(firstManifest.archetypes[0].git_blob.sha1, gitHash(source.content));
        // Another template already uses this same archetype generation.
        f.state.files["AKI/templates/oet/other.oet"] = f.args.content;
        f.state.files["AKI/data/json/template-packages/other.oet.json"] = JSON.stringify({
            ...firstManifest,
            template: { ...firstManifest.template, path: "templates/oet/other.oet" },
        });
        const changedSource = { ...source, content: "revised ADL source bytes\n" };
        // An external designer commits corrected bytes without renaming the file.
        f.state.snapshots[first.commit] = { ...f.state.files };
        f.state.files[archetype] = changedSource.content;
        f.state.head = "e".repeat(40);
        f.state.sources = [changedSource];
        f.state.generated = { opt: "compiled second", web: '{"version":2}' };
        const expectedRevision = kind === "github" ? gitHash(f.args.content) : first.commit;
        const secondArgs = {
            ...args,
            content: '<template changed="true"/>',
            dependencies: [source], // A recovered draft still contains the old CKM bytes.
            expectedRevision,
        };
        const next = f.makeWorkspace();
        await next.tools();
        const plan = await next.prepareWrite(PERSONAL_WRITE, secondArgs);
        assert.equal(plan.files.find((file) => file.path === archetype).change, "unchanged");
        assert.equal(plan.files.find((file) => file.path === archetype).previousSha256, hash(changedSource.content));
        const second = (await next.call(PERSONAL_WRITE, secondArgs)).structuredContent;
        assert.notEqual(second.commit, first.commit);
        assert.equal(f.state.files[archetype], changedSource.content);
        assert.equal(f.state.files[opt], "compiled second");
        assert.equal(f.state.files[web], '{"version":2}');
        assert.equal(f.state.snapshots[first.commit][archetype], source.content);
        assert.equal(f.state.snapshots[first.commit][opt], "compiled first");
        const old = await new RepositoryModels(f.connections, "alice").package({
            repository: f.repo.id,
            path: "AKI/templates/oet/other.oet",
        });
        assert.equal(
            old.dependencies[0].content,
            source.content,
            "An unchanged template retains its exact older archetype",
        );
        const current = await new RepositoryModels(f.connections, "alice").package({
            repository: f.repo.id,
            path: args.path,
        });
        assert.equal(current.dependencies[0].content, changedSource.content);
        const before = f.state.writes.length;
        // Native workers can emit Map entries in a different order per process.
        f.state.checks = { adl14_parse: "PASS", oet_application: "PASS" };
        const repeat = f.makeWorkspace();
        await repeat.tools();
        const same = (
            await repeat.call(PERSONAL_WRITE, {
                ...secondArgs,
                expectedRevision: kind === "github" ? gitHash(secondArgs.content) : second.commit,
            })
        ).structuredContent;
        assert.equal(same.changed, false);
        assert.equal(same.commit, second.commit);
        assert.equal(f.state.writes.length, before, "Identical package creates no new Git commit");
        await assert.rejects(
            f.connections.prepareBundle("alice", secondArgs, [
                { path: args.path, content: "stale", expectedRevision },
                { path: opt, content: "stale" },
            ]),
            /changed/,
        );
        assert.equal(f.state.files[opt], "compiled second");
    });

for (const kind of ["github", "gitlab"])
    test(`${kind} pre-versioning manifests recover exact dependencies from their recorded Git history`, async (t) => {
        const f = fixture(t, kind);
        const workspace = f.makeWorkspace();
        await workspace.tools();
        const first = (await workspace.call(PERSONAL_WRITE, { ...f.args, dependencies: [source] })).structuredContent;
        const manifestPath = "AKI/data/json/template-packages/renal.oet.json";
        const manifest = JSON.parse(f.state.files[manifestPath]);
        manifest.schema = "openehr-template-package/1";
        delete manifest.archetypes[0].git_blob;
        f.state.files[manifestPath] = JSON.stringify(manifest);
        f.state.snapshots[first.commit] = { ...f.state.files };
        f.state.historyCommit = first.commit;
        f.state.head = "f".repeat(40);
        f.state.files["AKI/archetypes/" + source.identifier + ".adl"] = "newer shared archetype";
        const loaded = await new RepositoryModels(f.connections, "alice").package({
            repository: f.repo.id,
            path: f.args.path,
        });
        assert.equal(loaded.dependencies[0].content, source.content);
        const history = await new RepositoryModels(f.connections, "alice").history({
            repository: f.repo.id,
            path: manifestPath,
        });
        assert.equal(history.versions[0].commit, first.commit);
        const old = await new RepositoryModels(f.connections, "alice").get({
            repository: f.repo.id,
            path: f.args.path,
            ref: first.commit,
        });
        assert.equal(old.sha256, hash(f.args.content));
        // A forged history entry must never justify different manifest bytes.
        f.state.snapshots[first.commit][manifestPath] = "{}";
        f.state.head = "9".repeat(40);
        // A separate profile avoids cached immutable test fixtures; real Git objects cannot mutate.
        f.connections.store.set("carol", "workspace", f.connections.all("alice"));
        await assert.rejects(
            new RepositoryModels(f.connections, "carol").package({ repository: f.repo.id, path: f.args.path }),
            /history does not match/,
        );
    });

test("an interrupted build can save its exact retained draft and dependencies without rebuilding", async (t) => {
    const f = fixture(t),
        first = f.makeWorkspace();
    await first.tools();
    await first.call("template_build_oet", {});
    const second = f.makeWorkspace();
    await second.tools();
    const checkpoints = (await second.call("workspace_checkpoints", {})).structuredContent;
    const draftId = checkpoints.drafts[0].id;
    const { content, ...args } = f.args;
    const save = { ...args, draftId };
    const plan = await second.prepareWrite(PERSONAL_WRITE, save);
    assert.equal(save.content, content);
    assert(plan.files.some((file) => file.content === source.content));
    assert.equal(f.state.writes.length, 0, "Preparing recovery cannot publish a file");
    const result = await second.call(PERSONAL_WRITE, save);
    assert.equal(result.structuredContent.saved, true);
    assert.equal(f.state.files[f.args.path], content);
    await assert.rejects(second.prepareWrite(PERSONAL_WRITE, { ...save, content: "different" }), /do not match/);
});

for (const kind of ["github", "gitlab"])
    test(`${kind} builds use designer edits by default and CKM revisions only for deliberate upgrades`, async (t) => {
        const f = fixture(t, kind);
        const path = "AKI/archetypes/" + source.identifier + ".adl";
        const edited = { ...source, content: "designer corrected ADL" };
        f.state.files[path] = edited.content;
        f.state.sources = [edited];
        const workspace = f.makeWorkspace();
        await workspace.tools();
        const built = await workspace.call("template_build_oet", { name: "Renal", composition: source.identifier });
        assert.deepEqual(f.state.buildArgs.archetypes, [edited]);
        assert.equal(built.structuredContent.result.provenance[source.identifier].kind, "personal_repository");
        const plan = await workspace.prepareWrite(PERSONAL_WRITE, f.args);
        assert.equal(plan.files.find((item) => item.path === path).change, "unchanged");
        // Explicit upstream revision upgrade, including a revision retaining the same identifier.
        const upstream = { ...source, content: "new CKM revision" };
        f.state.upstream = [upstream];
        f.state.sources = [upstream];
        const upgraded = f.makeWorkspace();
        await upgraded.tools();
        await upgraded.call("template_build_oet", {
            name: "Renal",
            composition: source.identifier,
            ckmUpgrades: [source.identifier],
        });
        assert.deepEqual(f.state.buildArgs.archetypes, []);
        assert.equal(f.state.buildArgs.ckmUpgrades, undefined, "Browser-only policy is not sent to MCP");
        await upgraded.call("template_compile", { content: f.args.content, dependencies: [upstream] });
        const upgradePlan = await upgraded.prepareWrite(PERSONAL_WRITE, { ...f.args });
        assert.equal(upgradePlan.files.find((item) => item.path === path).content, upstream.content);
        assert.equal(upgradePlan.files.find((item) => item.path === path).change, "updated");
        // A second designer edit must not be silently replaced by an already built upgrade.
        f.state.files[path] = "another designer edit";
        f.state.head = "e".repeat(40);
        const retry = f.makeWorkspace();
        await retry.tools();
        await assert.rejects(retry.prepareWrite(PERSONAL_WRITE, { ...f.args }), /changed after the CKM upgrade/);
        assert.equal(f.state.writes.length, 0);
    });

test("new CKM identifiers coexist with repository versions and compilation rejects incompatible edits", async (t) => {
    const f = fixture(t);
    const oldPath = "AKI/archetypes/" + source.identifier + ".adl";
    f.state.files[oldPath] = "designer v1";
    const newer = { identifier: source.identifier.replace(".v1", ".v2"), content: "CKM v2" };
    f.state.upstream = [newer];
    f.state.sources = [newer];
    const workspace = f.makeWorkspace();
    await workspace.tools();
    await workspace.call("template_build_oet", { name: "Renal", composition: newer.identifier });
    const plan = await workspace.prepareWrite(PERSONAL_WRITE, { ...f.args });
    assert.equal(plan.files.find((item) => item.dependency).change, "created");
    assert.equal(plan.files.find((item) => item.dependency).path, "AKI/archetypes/" + newer.identifier + ".adl");
    assert.equal(f.state.files[oldPath], "designer v1");
    f.state.sources = [{ ...source, content: "designer v1" }];
    f.state.valid = false;
    await assert.rejects(
        workspace.prepareWrite(PERSONAL_WRITE, { ...f.args, dependencies: [source] }),
        /could not be compiled/,
    );
    assert.equal(f.state.writes.length, 0);
});

test("repository source selection rejects duplicates and guards edits between compile and save", async (t) => {
    const f = fixture(t);
    const path = "AKI/archetypes/" + source.identifier + ".adl";
    f.state.files[path] = source.content;
    f.state.files["AKI/archetypes/duplicate/" + source.identifier + ".adl"] = source.content;
    const workspace = f.makeWorkspace();
    await workspace.tools();
    await assert.rejects(
        workspace.prepareWrite(PERSONAL_WRITE, { ...f.args, dependencies: [source] }),
        /Multiple repository copies/,
    );
    delete f.state.files["AKI/archetypes/duplicate/" + source.identifier + ".adl"];
    f.state.head = "b".repeat(40);
    const call = f.mcp.call;
    f.mcp.call = async (...args) => {
        const result = await call(...args);
        f.state.files[path] = "concurrent edit";
        f.state.head = "e".repeat(40);
        return result;
    };
    await assert.rejects(
        workspace.prepareWrite(PERSONAL_WRITE, { ...f.args, dependencies: [source] }),
        /Repository changed/,
    );
    assert.equal(f.state.writes.length, 0);
});
