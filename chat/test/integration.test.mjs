import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ProcessingWorkspace } from "../src/processing.mjs";
import { IntegrationCore } from "../src/integration-core.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "modeller-private-"));
    const session = { identity: "synthetic-person" };
    const subject = "a".repeat(64);
    const core = {
        configuration: {},
        ready: true,
        request: async (s, m, target) =>
            target.includes("mappings")
                ? { project: "lab", subject, mappingConfirmed: true, mappingSha256: "b".repeat(64) }
                : { id: "lab" },
    };
    const workspace = new ProcessingWorkspace({ dataDir: root }, core);
    return {
        root,
        session,
        subject,
        core,
        workspace,
        close() {
            workspace.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}
test("private uploads do not enter the model registry; connections and metadata are owner scoped", async () => {
    const f = fixture();
    try {
        const content = Buffer.from("id,value\nsynthetic-private-canary,0\n");
        const upload = await f.workspace.upload(
            f.session,
            { projectId: "lab", format: "csv", name: "private.csv" },
            content,
        );
        assert.equal(upload.sha256, hash(content));
        assert.equal(f.workspace.listConnections(f.session, "lab").sources.length, 1);
        assert.equal(f.workspace.listConnections({ identity: "another" }, "lab").sources.length, 0);
        const list = f.workspace.files(f.session, "lab", upload.id);
        assert.equal(list.items[0].name, "source.bin");
        assert.ok(!JSON.stringify(list).includes("synthetic-private-canary"));
        assert.equal(
            (await f.workspace.file(f.workspace.source(hash(f.session.identity), "lab", upload.id), "source.bin"))
                .sha256,
            upload.sha256,
        );
        await assert.rejects(
            f.workspace.file(f.workspace.source(hash(f.session.identity), "lab", upload.id), "../source.bin"),
        );
    } finally {
        f.close();
    }
});
test("run tickets bind owner and content; a changed source cannot be committed", async () => {
    const f = fixture();
    try {
        const upload = await f.workspace.upload(
            f.session,
            { projectId: "lab", format: "csv", name: "x.csv" },
            Buffer.from("id\n1\n"),
        );
        const ticket = await f.workspace.previewJob(f.session, {
            projectId: "lab",
            subject: f.subject,
            sourceId: upload.id,
            file: "source.bin",
            mode: "export",
        });
        assert.throws(() => f.workspace.take({ identity: "another" }, ticket.confirmation, "job"));
        const source = f.workspace.source(hash(f.session.identity), "lab", upload.id);
        writeFileSync(join(source.root, "source.bin"), "id\n2\n");
        await assert.rejects(f.workspace.commitJob(f.session, ticket.confirmation), /source changed/);
        await assert.rejects(f.workspace.commitJob(f.session, ticket.confirmation), /expired/);
    } finally {
        f.close();
    }
});
test("ordinary source access cannot enable destination delivery", async () => {
    const f = fixture();
    try {
        const upload = await f.workspace.upload(
            f.session,
            { projectId: "lab", format: "csv", name: "x.csv" },
            Buffer.from("id\n1\n"),
        );
        await assert.rejects(
            f.workspace.previewJob(f.session, {
                projectId: "lab",
                subject: f.subject,
                sourceId: upload.id,
                file: "source.bin",
                mode: "deliver",
                destinationId: "unregistered",
            }),
            /disabled/,
        );
        assert.deepEqual(f.workspace.listConnections(f.session, "lab").databaseDrivers, []);
        assert.equal(f.workspace.listConnections(f.session, "lab").clinicalDatabasePolicy, "READ_ONLY");
    } finally {
        f.close();
    }
});
test("channels pin the confirmed mapping and cannot silently change while running", async () => {
    const f = fixture();
    try {
        const upload = await f.workspace.upload(
            f.session,
            { projectId: "lab", format: "csv", name: "x.csv" },
            Buffer.from("id\n1\n"),
        );
        const input = {
            name: "Synthetic channel",
            projectId: "lab",
            subject: f.subject,
            sourceId: upload.id,
            mode: "export",
            pollSeconds: 10,
            failurePolicy: "pause",
        };
        const preview = await f.workspace.previewChannel(f.session, input);
        const channel = await f.workspace.commitChannel(f.session, preview.confirmation);
        assert.equal(channel.mappingSha256, "b".repeat(64));
        assert.equal(channel.status, "STOPPED");
        await f.workspace.controlChannel(f.session, channel.id, "start");
        await assert.rejects(
            f.workspace.previewChannel(f.session, { ...input, id: channel.id, expectedRevision: 1 }),
            /Stop and reload/,
        );
        assert.equal(f.workspace.listChannels({ identity: "another" }).items.length, 0);
        f.workspace.close();
        const restarted = new ProcessingWorkspace({ dataDir: f.root }, f.core);
        try {
            assert.equal(restarted.listChannels(f.session).items[0].status, "INTERRUPTED");
        } finally {
            restarted.close();
        }
    } finally {
        f.close();
    }
});
test("private C# requests require verified human identity and bind purpose, target, method and body", async () => {
    const signingKey = "a".repeat(64);
    let request;
    const core = new IntegrationCore(
        {
            origin: "https://model.example",
            mcpKey: "test",
            reviewKeyId: "active",
            reviewSigningKey: signingKey,
            sessionSeconds: 3600,
            reviewSessionSeconds: 600,
        },
        {
            fetcher: async (url, options) => {
                request = { url, options };
                return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
            },
        },
    );
    core.ready = true;
    await assert.rejects(
        core.request({ identity: "x" }, "POST", "/api/v1/integration/projects", {}),
        /Refresh sign-in/,
    );
    const session = {
        identity: "synthetic-person",
        reviewIdentity: {
            issuer: "https://id.example",
            tenant: "https://id.example",
            subject: "human",
            roles: ["modelling-reviewer"],
            projectScopes: ["project:lab:write"],
            started: Math.floor(Date.now() / 1000),
        },
    };
    await core.request(session, "POST", "/api/v1/integration/projects", { synthetic: true });
    const [header, claims] = request.options.headers.Authorization.slice(7)
        .split(".")
        .slice(0, 2)
        .map((v) => JSON.parse(Buffer.from(v, "base64url")));
    assert.equal(header.typ, "openehr-integration+jwt");
    assert.equal(claims.method, "POST");
    assert.equal(claims.body_sha256, hash(request.options.body));
    assert.equal(claims.target, "/api/v1/integration/projects");
    assert.equal(claims.owner_hash, hash(session.identity));
    assert.ok(claims.exp - claims.iat <= 60);
    await assert.rejects(core.request(session, "POST", "/api/v1/integration/../evil", {}), /Invalid integration/);
});

test("inspection reserves capacity before awaiting identity or file operations", async () => {
    const f = fixture();
    try {
        const blocked = [];
        f.core.request = () => new Promise((resolve, reject) => blocked.push(reject));
        const first = f.workspace.inspect(f.session, { projectId: "lab", sourceId: "synthetic", file: "x.json" });
        const second = f.workspace.inspect(f.session, { projectId: "lab", sourceId: "synthetic", file: "x.json" });
        await assert.rejects(
            f.workspace.inspect(f.session, { projectId: "lab", sourceId: "synthetic", file: "x.json" }),
            /workers are busy/,
        );
        assert.equal(blocked.length, 2);
        for (const reject of blocked) reject(new Error("Synthetic preflight rejection"));
        await Promise.allSettled([first, second]);
        assert.equal(f.workspace.inspectionRequests, 0);
    } finally {
        f.close();
    }
});
test("a failed worker preflight cannot reuse an old successful job status", async () => {
    const f = fixture();
    try {
        const source = await f.workspace.upload(
            f.session,
            { projectId: "lab", format: "csv", name: "synthetic.csv" },
            Buffer.from("id\n1\n"),
        );
        const owner = hash(f.session.identity);
        const job = f.workspace.createJob(owner, {
            projectId: "lab",
            subject: f.subject,
            sourceId: source.id,
            file: "source.bin",
            sourceSha256: source.sha256,
            mode: "export",
        });
        writeFileSync(join(job.directory, "state.json"), JSON.stringify({ status: "COMPLETED", read: 1, exported: 1 }));
        f.workspace.launcher = () => {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => true;
            queueMicrotask(() => {
                child.stderr.write("SOURCE_CHANGED");
                child.emit("exit", 1);
            });
            return child;
        };
        const result = await f.workspace.launch(job, true);
        assert.equal(result.status, "BLOCKED");
        assert.equal(result.error, "SOURCE_CHANGED");
        assert.equal(result.read, 1);
    } finally {
        f.close();
    }
});
