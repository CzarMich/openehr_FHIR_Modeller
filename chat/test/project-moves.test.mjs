import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Store } from "../src/store.mjs";
import { PersonalConnections } from "../src/personal-connections.mjs";
import { ProjectMoves, recordArtifact } from "../src/project-moves.mjs";
import { createApplication } from "../src/server.mjs";
import { Auth } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";
import { artifactPath } from "../src/repository-paths.mjs";

const hash = (value) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "chat-project-moves-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = {
        ...loadConfig(),
        enabled: true,
        dataDir: directory,
        providerEncryptionKey: "ab".repeat(32),
        allowWrites: true,
    };
    const store = new Store(join(directory, "conversations"));
    const trees = new Map(),
        commits = new Map(),
        writes = [];
    const makeTree = (files, prefix = "") => {
        const entries = [],
            directories = new Set();
        for (const [path, entry] of Object.entries(files)) {
            if (!path.startsWith(prefix)) continue;
            const relative = path.slice(prefix.length);
            if (relative.includes("/")) directories.add(relative.split("/")[0]);
            else entries.push({ path: relative, type: "blob", mode: "100644", ...entry });
        }
        for (const name of directories)
            entries.push({ path: name, type: "tree", mode: "040000", sha: makeTree(files, prefix + name + "/") });
        const sha = hash(entries);
        trees.set(sha, entries);
        return sha;
    };
    const state = {
        head: "a".repeat(40),
        files: {
            "Old/templates/model.oet": { sha: "b".repeat(40) },
            "Old/archetypes/model.adl": { sha: "c".repeat(40), mode: "100755" },
            "unrelated.txt": { sha: "d".repeat(40) },
        },
        loseResponse: false,
        race: false,
    };
    const snapshot = () =>
        commits.set(state.head, { tree: { sha: makeTree(state.files) }, files: structuredClone(state.files) });
    snapshot();
    const request = async (url, options) => {
        const path = new URL(url).pathname.replace("/repos/alice/models", "");
        if (options.method) writes.push({ path, method: options.method, body: options.body });
        const result = (data, status = 200) => ({ status, text: JSON.stringify(data) });
        if (path.startsWith("/git/ref/heads/")) return result({ object: { sha: state.head } });
        if (path.startsWith("/git/trees/") && !options.method)
            return result({ tree: trees.get(path.split("/").at(-1)) });
        if (path.startsWith("/git/commits/") && !options.method) return result(commits.get(path.split("/").at(-1)));
        if (path === "/git/trees" && options.method === "POST") {
            assert.equal(options.body.base_tree, commits.get(state.head).tree.sha);
            const files = structuredClone(commits.get(state.head).files);
            for (const item of options.body.tree) {
                if (item.sha === null) delete files[item.path];
                else files[item.path] = { sha: item.sha, mode: item.mode };
            }
            const sha = makeTree(files);
            state.pendingFiles = files;
            return result({ sha }, 201);
        }
        if (path === "/git/commits" && options.method === "POST") {
            const sha = hash(options.body);
            commits.set(sha, { tree: { sha: options.body.tree }, files: state.pendingFiles });
            if (state.race) {
                state.head = "e".repeat(40);
                snapshot();
            }
            return result({ sha }, 201);
        }
        if (path.startsWith("/git/refs/heads/") && options.method === "PATCH") {
            assert.equal(options.body.force, false);
            if (state.race) return result({}, 422);
            state.head = options.body.sha;
            state.files = commits.get(state.head).files;
            if (state.loseResponse) {
                state.loseResponse = false;
                throw new Error("Lost response");
            }
            return result({ object: { sha: state.head } });
        }
        throw new Error("Unexpected test request " + path);
    };
    const connections = new PersonalConnections(config, { request });
    const repo = connections.add("alice", {
        kind: "github",
        label: "Models",
        url: "https://github.com/alice/models",
        branch: "main",
        token: "test-only-token",
    }).connection;
    const project = store.saveProject("alice", "AKI", null, { repository: repo.id, folder: "Clinical/AKI" });
    const chat = store.create("alice", "codex", repo.id, null, "Old");
    chat.messages = [{ role: "user", content: "Private conversation" }];
    chat.attachments = [{ id: "private-upload", name: "evidence.pdf" }];
    for (const path of ["Old/templates/model.oet", "Old/archetypes/model.adl"])
        recordArtifact(chat, { repository: repo.id, path });
    store.save("alice", chat);
    return {
        config,
        store,
        connections,
        project,
        chat,
        repo,
        state,
        writes,
        snapshot,
        moves: new ProjectMoves(store, connections, true),
    };
}

test("move preview is read-only, then one commit moves exact files and keeps chat/uploads private", async (t) => {
    const f = fixture(t),
        before = structuredClone(f.chat);
    const plan = await f.moves.preview("alice", f.chat, f.project.id);
    assert.deepEqual(
        plan.moves.map(({ from, to }) => ({ from, to })),
        [
            { from: "Old/templates/model.oet", to: "Clinical/AKI/templates/oet/model.oet" },
            { from: "Old/archetypes/model.adl", to: "Clinical/AKI/archetypes/model.adl" },
        ],
    );
    assert.equal(f.writes.length, 0);
    const moved = await f.moves.apply("alice", f.chat, plan.id);
    assert.equal(f.writes.filter((write) => write.path === "/git/commits").length, 1);
    assert.equal(moved.project, f.project.id);
    assert.equal(moved.folder, "Clinical/AKI");
    assert.equal(moved.repository, f.repo.id);
    assert.deepEqual(moved.messages, before.messages);
    assert.deepEqual(moved.attachments, before.attachments);
    assert.equal(f.state.files["Old/templates/model.oet"], undefined);
    assert.equal(f.state.files["Clinical/AKI/templates/oet/model.oet"].sha, "b".repeat(40));
    assert.equal(f.state.files["Clinical/AKI/archetypes/model.adl"].mode, "100755");
    assert.equal(f.state.files["unrelated.txt"].sha, "d".repeat(40));
    assert.doesNotMatch(JSON.stringify(f.writes), /Private conversation|private-upload|test-only-token/);
    assert.equal(moved.artifacts[0].path, "Clinical/AKI/templates/oet/model.oet");
});

test("conflicting filenames, missing sources and symlinks cannot produce a move commit", async (t) => {
    for (const scenario of ["collision", "missing", "symlink"]) {
        const f = fixture(t);
        if (scenario === "collision") f.state.files["Clinical/AKI/templates/oet/model.oet"] = { sha: "f".repeat(40) };
        if (scenario === "missing") delete f.state.files["Old/templates/model.oet"];
        if (scenario === "symlink") f.state.files["Old/templates/model.oet"].mode = "120000";
        f.snapshot();
        await assert.rejects(f.moves.preview("alice", f.chat, f.project.id), /already exists|missing|regular file/);
        assert.equal(f.writes.length, 0);
        assert.equal(f.store.get("alice", f.chat.id).project, undefined);
    }
});

test("stale chat, project, branch and confirmation IDs block all remote writes", async (t) => {
    for (const scenario of ["chat", "project", "branch", "id", "expired"]) {
        const f = fixture(t),
            plan = await f.moves.preview("alice", f.chat, f.project.id);
        if (scenario === "chat") f.chat.folder = "Elsewhere";
        if (scenario === "project") f.store.saveProject("alice", "AKI", f.project.id, { folder: "Elsewhere" });
        if (scenario === "branch") f.state.head = "f".repeat(40);
        if (scenario === "expired") plan.expiresAt = 0;
        await assert.rejects(f.moves.apply("alice", f.chat, scenario === "id" ? "wrong" : plan.id), /changed|expired/);
        assert.equal(f.writes.length, 0);
    }
});

test("a concurrent branch commit cannot be overwritten by the final reference update", async (t) => {
    const f = fixture(t),
        plan = await f.moves.preview("alice", f.chat, f.project.id);
    f.state.race = true;
    await assert.rejects(f.moves.apply("alice", f.chat, plan.id), /changed/);
    assert.ok(f.state.files["Old/templates/model.oet"]);
    assert.equal(f.state.files["Clinical/AKI/templates/oet/model.oet"], undefined);
    assert.equal(f.store.get("alice", f.chat.id).project, undefined);
});

test("a lost successful commit response can finish from persisted preview without another commit", async (t) => {
    const f = fixture(t),
        plan = await f.moves.preview("alice", f.chat, f.project.id);
    f.state.loseResponse = true;
    await assert.rejects(f.moves.apply("alice", f.chat, plan.id), /Lost response/);
    const reloaded = f.store.get("alice", f.chat.id);
    assert.equal((await f.moves.preview("alice", reloaded, f.project.id)).id, plan.id);
    const recovered = await f.moves.apply("alice", reloaded, plan.id);
    assert.equal(recovered.project, f.project.id);
    assert.equal(f.writes.filter((write) => write.path === "/git/commits").length, 1);
});

test("artefact types are separated without nesting an existing category twice", () => {
    for (const [path, expected] of [
        ["AKI/model.adl", "AKI/archetypes/model.adl"],
        ["AKI/archetypes/model.adls", "AKI/archetypes/model.adls"],
        ["AKI/templates/model.oet", "AKI/templates/oet/model.oet"],
        ["AKI/templates/oet/renal/model.oet", "AKI/templates/oet/renal/model.oet"],
        ["AKI/model.opt", "AKI/templates/opt/model.opt"],
        ["AKI/model.adlt", "AKI/templates/adl/model.adlt"],
        ["AKI/evidence/README.md", "AKI/documents/markdown/evidence/README.md"],
        ["AKI/queries/staging.aql", "AKI/queries/staging.aql"],
        ["AKI/terminology/codes.json", "AKI/data/json/terminology/codes.json"],
        ["AKI/data/json/terminology/codes.json", "AKI/data/json/terminology/codes.json"],
        ["AKI/example.xml", "AKI/data/xml/example.xml"],
        ["AKI/model.opt.xml", "AKI/templates/opt/model.opt.xml"],
        ["AKI/model.oet.xml", "AKI/templates/oet/model.oet.xml"],
        ["AKI/data/examples.csv", "AKI/data/csv/examples.csv"],
        ["AKI/requirements.txt", "AKI/documents/text/requirements.txt"],
        ["AKI/config/project.yaml", "AKI/config/yaml/project.yaml"],
        ["AKI/config/yaml/project.yml", "AKI/config/yaml/project.yml"],
    ])
        assert.equal(artifactPath(path, "AKI"), expected);
});

test("supporting artefacts move into type folders and retain exact content revisions", async (t) => {
    const f = fixture(t),
        path = "Old/requirements/design.md";
    f.state.files[path] = { sha: "f".repeat(40) };
    f.snapshot();
    recordArtifact(f.chat, { repository: f.repo.id, path });
    const plan = await f.moves.preview("alice", f.chat, f.project.id);
    const moved = await f.moves.apply("alice", f.chat, plan.id);
    const target = "Clinical/AKI/documents/markdown/requirements/design.md";
    assert.equal(f.state.files[target].sha, "f".repeat(40));
    assert.equal(f.state.files[path], undefined);
    assert.equal(moved.artifacts.find((item) => item.path === target).commit, moved.lastMove.commit);
});

test("saved version receipts are replaced only by the latest confirmed save receipt", (t) => {
    const f = fixture(t),
        args = { repository: f.repo.id, path: "Old/templates/oet/new.oet" };
    recordArtifact(f.chat, args, { commit: "a".repeat(40) });
    assert.equal(f.chat.artifacts.at(-1).commit, "a".repeat(40));
    recordArtifact(f.chat, args, { commit: "b".repeat(40) });
    assert.equal(f.chat.artifacts.filter((item) => item.path === args.path).length, 1);
    assert.equal(f.chat.artifacts.at(-1).commit, "b".repeat(40));
    recordArtifact(f.chat, args, {});
    assert.equal(f.chat.artifacts.at(-1).commit, undefined);
});

test("GitLab moves use one batch with exact file revisions and no content rewrite", async (t) => {
    const f = fixture(t),
        calls = [],
        revision = "d".repeat(40);
    const connections = new PersonalConnections(f.config, {
        request: async (url, options) => {
            calls.push({ url, ...options });
            if (url.includes("/repository/branches/"))
                return { status: 200, text: JSON.stringify({ commit: { id: "a".repeat(40) } }) };
            if (url.includes("/repository/files/")) {
                assert.match(url, /ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/);
                return url.includes("Old%2F")
                    ? {
                          status: 200,
                          text: JSON.stringify({
                              encoding: "base64",
                              content: Buffer.from("original bytes").toString("base64"),
                              last_commit_id: revision,
                          }),
                      }
                    : { status: 404, text: "{}" };
            }
            assert.equal(options.method, "POST");
            assert.equal(options.body.force, false);
            assert.deepEqual(options.body.actions, [
                {
                    action: "move",
                    previous_path: "Old/model.opt",
                    file_path: "AKI/templates/opt/model.opt",
                    last_commit_id: revision,
                },
            ]);
            assert.doesNotMatch(JSON.stringify(options.body), /original bytes|Private conversation/);
            return { status: 201, text: JSON.stringify({ id: "e".repeat(40) }) };
        },
    });
    const repo = connections.add("alice", {
        kind: "gitlab",
        label: "GitLab",
        url: "https://gitlab.com/group/models",
        branch: "main",
        token: "synthetic",
    }).connection;
    const project = f.store.saveProject("alice", "GitLab", null, { repository: repo.id, folder: "AKI" });
    f.chat.repository = repo.id;
    f.chat.artifacts = [{ repository: repo.id, path: "Old/model.opt", folder: "Old" }];
    const moves = new ProjectMoves(f.store, connections, true),
        plan = await moves.preview("alice", f.chat, project.id);
    assert.equal(calls.filter((call) => call.method).length, 0);
    const moved = await moves.apply("alice", f.chat, plan.id);
    assert.equal(calls.filter((call) => call.method).length, 1);
    assert.equal(moved.artifacts[0].path, "AKI/templates/opt/model.opt");
});

test("legacy saves require explicit paths; moving out of a project keeps its repository location", async (t) => {
    const f = fixture(t);
    f.chat.artifacts = [];
    f.chat.messages.push({
        role: "assistant",
        content: "Saved",
        tools: [{ name: "personal_repository_save", status: "completed" }],
    });
    await assert.rejects(f.moves.preview("alice", f.chat, f.project.id), /Include their repository paths/);
    await assert.rejects(f.moves.preview("alice", f.chat, f.project.id, ["../secrets.txt"]), /relative artifact path/);
    const plan = await f.moves.preview("alice", f.chat, f.project.id, ["Old/templates/model.oet"]);
    const moved = await f.moves.apply("alice", f.chat, plan.id);
    const out = await f.moves.preview("alice", moved, null);
    assert.equal(out.moves.length, 0);
    assert.equal((await f.moves.apply("alice", moved, out.id)).folder, "Clinical/AKI");
});

test("moves require owned destinations and write access and never substitute another repository", async (t) => {
    const f = fixture(t);
    await assert.rejects(f.moves.preview("bob", f.chat, f.project.id), /not found/);
    await assert.rejects(
        new ProjectMoves(f.store, f.connections, false).preview("alice", f.chat, f.project.id),
        /disabled/,
    );
    const other = f.connections.add("alice", {
        kind: "github",
        label: "Other",
        url: "https://github.com/alice/other",
        branch: "main",
    }).connection;
    f.store.saveProject("alice", "AKI", f.project.id, { repository: other.id });
    await assert.rejects(f.moves.preview("alice", f.chat, f.project.id), /same repository and branch/);
    assert.equal(f.writes.length, 0);
});

test("move HTTP routes enforce ownership, CSRF, exact confirmation and repeat-request idempotence", async (t) => {
    const f = fixture(t),
        auth = new Auth(f.config);
    for (const identity of ["alice", "bob"])
        auth.sessions.set(identity, { identity, csrf: identity, expires: Date.now() + 60000 });
    const server = createApplication(f.config, { store: f.store, connections: f.connections, auth });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    f.config.origin = "http://127.0.0.1:" + server.address().port;
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const call = (action, data, user = "alice", csrf = true) =>
        fetch(f.config.origin + "/chat/api/conversations/" + f.chat.id + "/" + action, {
            method: "POST",
            headers: {
                Cookie: "ModellingSession=" + user,
                Origin: f.config.origin,
                "Content-Type": "application/json",
                ...(csrf ? { "X-CSRF-Token": user } : {}),
            },
            body: JSON.stringify(data),
        });
    assert.equal((await call("move-preview", { project: f.project.id }, "bob")).status, 404);
    assert.equal((await call("move-preview", { project: f.project.id }, "alice", false)).status, 403);
    assert.equal((await call("move", { id: "unconfirmed" })).status, 409);
    const plan = await (await call("move-preview", { project: f.project.id })).json();
    assert.equal(f.writes.length, 0);
    assert.equal((await call("move", { id: plan.id })).status, 200);
    assert.equal((await call("move", { id: plan.id })).status, 200);
    assert.equal(f.writes.filter((write) => write.path === "/git/commits").length, 1);
});

test("moving a template package keeps shared source archetypes available to other templates", async (t) => {
    const f = fixture(t);
    f.chat.artifacts.find((item) => item.path.endsWith(".adl")).dependency = true;
    f.store.save("alice", f.chat);
    const plan = await f.moves.preview("alice", f.chat, f.project.id);
    assert.equal(plan.moves.find((item) => item.from.endsWith(".adl")).retainSource, true);
    const moved = await f.moves.apply("alice", f.chat, plan.id);
    assert.equal(f.state.files["Old/archetypes/model.adl"].sha, "c".repeat(40));
    assert.equal(f.state.files["Clinical/AKI/archetypes/model.adl"].sha, "c".repeat(40));
    assert.equal(moved.artifacts.find((item) => item.path.endsWith(".adl")).dependency, true);
    assert.equal(f.state.files["Old/templates/model.oet"], undefined);
});
