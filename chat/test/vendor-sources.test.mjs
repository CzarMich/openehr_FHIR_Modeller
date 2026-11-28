import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { VendorSources } from "../src/vendor-sources.mjs";
import { ProcessingWorkspace } from "../src/processing.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "vendor-functional-"));
    const config = {
        dataDir: root,
        providerEncryptionKey: "a".repeat(64),
        integrationExtractor: "/synthetic/extractor",
    };
    const requests = [];
    let fail = false;
    const core = {
        configuration: { operationalKeyFile: join(root, "key") },
        request: async (session, method, target, body) => {
            if (session.identity === "viewer") throw new Error("HUMAN_SOURCE_REVIEW_REQUIRED");
            requests.push({ method, target, body });
            return {};
        },
    };
    writeFileSync(core.configuration.operationalKeyFile, Buffer.alloc(32, 7), { mode: 0o600 });
    const processing = new ProcessingWorkspace(config, core);
    const launcher = (_command, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
            child.emit("exit", 1);
            return true;
        };
        queueMicrotask(() => {
            const input = JSON.parse(readFileSync(args[1], "utf8"));
            assert.equal(input.profile.password, "SYNTHETIC-SECRET-canary");
            const output = args[2];
            mkdirSync(output, { recursive: true });
            if (fail) {
                child.stderr.write("SOURCE_WINDOW_INCOMPLETE");
                child.emit("exit", 1);
                return;
            }
            let result = { configurationValid: true };
            if (args[0] === "discover")
                result = {
                    schemaFingerprint: "c".repeat(64),
                    tables: [
                        {
                            id: 1,
                            schema: "vendor",
                            name: "actual-table",
                            columns: [{ id: 1, name: "patientId", type: "varchar", keyOrdinal: 1 }],
                        },
                    ],
                    keys: [],
                    metadataOnly: true,
                    readOnly: true,
                };
            if (args[0] === "extract") {
                const cursor = input.cursor ? (input.afterJson ? "9223372036854775807" : "9223372036854775806") : null;
                const bytes = Buffer.from(
                    cursor
                        ? '[{"recordId":' + cursor + ',"patientId":"SYNTHETIC-PATIENT-CANARY"}]'
                        : '[{"patientId":"SYNTHETIC-PATIENT-CANARY"}]',
                );
                writeFileSync(join(output, "records.json"), bytes, { mode: 0o600 });
                result = {
                    complete: true,
                    readOnly: true,
                    records: 1,
                    sha256: hash(bytes),
                    nextCursorJson: input.cursor
                        ? input.afterJson
                            ? "9223372036854775807"
                            : "9223372036854775806"
                        : null,
                };
            }
            writeFileSync(join(output, "result.json"), JSON.stringify(result), { mode: 0o600 });
            child.emit("exit", 0);
        });
        return child;
    };
    const vendor = new VendorSources(config, core, processing, { launcher, runtimeFingerprint: () => "e".repeat(64) });
    processing.vendor = vendor;
    return {
        root,
        processing,
        vendor,
        requests,
        session: { identity: "owner" },
        setFail() {
            fail = true;
        },
        close() {
            vendor.close();
            processing.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}
const input = {
    projectId: "lab",
    displayName: "Clinical reader",
    identityDomain: "hospital-patient-domain",
    profile: {
        connector: "sqlserver",
        host: "source.example",
        port: 1433,
        database: "Clinical",
        user: "reader",
        password: "SYNTHETIC-SECRET-canary",
        schemas: ["vendor"],
    },
};
async function configured(f) {
    const preview = await f.vendor.previewProfile(f.session, input);
    return f.vendor.commitProfile(f.session, preview.confirmation);
}
test("source credential review is private, encrypted, owner-bound and separate from model approvals", async () => {
    const f = fixture();
    try {
        const preview = await f.vendor.previewProfile(f.session, input);
        assert.ok(!JSON.stringify(preview).includes("SYNTHETIC-SECRET-canary"));
        await assert.rejects(f.vendor.commitProfile({ identity: "another" }, preview.confirmation));
        const connection = await f.vendor.commitProfile(f.session, preview.confirmation);
        const list = await f.vendor.list(f.session, "lab");
        assert.equal(list.items.length, 1);
        assert.equal(list.items[0].planConfirmed, false);
        assert.equal(list.items[0].installationQualified, false);
        assert.ok(!JSON.stringify(list).includes("SYNTHETIC-SECRET-canary"));
        assert.equal(f.vendor.connections(f.processing.owner(f.session), "lab").length, 0);
        const file = join(f.vendor.root, "profiles", readdirSync(join(f.vendor.root, "profiles"))[0]);
        assert.ok(!readFileSync(file, "utf8").includes("SYNTHETIC-SECRET-canary"));
        assert.ok(f.requests.every((r) => !JSON.stringify(r).includes("SYNTHETIC-SECRET-canary")));
        await assert.rejects(
            f.vendor.discover({ identity: "viewer" }, { projectId: "lab", id: connection.id }),
            /HUMAN_SOURCE_REVIEW_REQUIRED/,
        );
    } finally {
        f.close();
    }
});
test("discovery, confirmed immutable read plan and private capture create a usable channel source", async () => {
    const f = fixture();
    try {
        const item = await configured(f);
        const discovered = await f.vendor.discover(f.session, { projectId: "lab", id: item.id });
        assert.equal(discovered.metadata.tables[0].name, "actual-table");
        assert.equal(discovered.patientRowsIncluded, false);
        const plan = {
            schemaFingerprint: "c".repeat(64),
            root: 1,
            fields: [{ table: 1, column: 1, field: "patientId", representation: "string" }],
            joins: [],
            filters: [],
            limit: 100,
        };
        const preview = await f.vendor.previewPlan(f.session, {
            projectId: "lab",
            id: item.id,
            plan,
            comment: "Patient table, bounded synthetic window and explicit authority",
        });
        const approved = await f.vendor.commitPlan(f.session, preview.confirmation);
        assert.equal(approved.planConfirmed, true);
        assert.match(approved.sourceId, /^[a-f0-9]{64}$/);
        const captured = await f.vendor.refresh(f.session, { projectId: "lab", id: item.id });
        assert.equal(captured.records, 1);
        const sources = f.processing.connections(f.processing.owner(f.session), "lab").sources;
        assert.equal(sources.length, 1);
        assert.equal(sources[0].format, "json");
        const files = f.processing.files(f.session, "lab", approved.sourceId);
        assert.equal(files.items.length, 1);
        assert.ok(!JSON.stringify(files).includes("SYNTHETIC-PATIENT-CANARY"));
        const again = await f.vendor.refresh(f.session, { projectId: "lab", id: item.id });
        assert.equal(again.sha256, captured.sha256);
        assert.equal(f.processing.files(f.session, "lab", approved.sourceId).items.length, 1);
        const stale = await f.vendor.previewPlan(f.session, {
            projectId: "lab",
            id: item.id,
            plan,
            comment: "No silent replacement",
        });
        await assert.rejects(f.vendor.commitPlan(f.session, stale.confirmation), /new source connection/);
        assert.ok(!existsSync(join(sources[0].root, "result.json")));
        assert.ok(
            !JSON.stringify(f.vendor.visible(f.vendor.get(f.processing.owner(f.session), item.id, "lab"))).includes(
                "SYNTHETIC-PATIENT-CANARY",
            ),
        );
    } finally {
        f.close();
    }
});
test("an incomplete read publishes nothing and disabling a source removes its operational grant", async () => {
    const f = fixture();
    try {
        const item = await configured(f);
        await f.vendor.discover(f.session, { projectId: "lab", id: item.id });
        const preview = await f.vendor.previewPlan(f.session, {
            projectId: "lab",
            id: item.id,
            plan: { schemaFingerprint: "c".repeat(64), root: 1, fields: [], joins: [], filters: [], limit: 100 },
            comment: "Synthetic bounded window",
        });
        const approved = await f.vendor.commitPlan(f.session, preview.confirmation);
        f.setFail();
        await assert.rejects(
            f.vendor.refresh(f.session, { projectId: "lab", id: item.id }),
            /SOURCE_WINDOW_INCOMPLETE/,
        );
        assert.equal(f.processing.files(f.session, "lab", approved.sourceId).items.length, 0);
        const disabled = await f.vendor.disable(f.session, {
            projectId: "lab",
            id: item.id,
            expectedRevision: approved.revision,
        });
        assert.equal(disabled.enabled, false);
        assert.equal(f.vendor.connections(f.processing.owner(f.session), "lab").length, 0);
        await assert.rejects(f.vendor.materialise(f.processing.owner(f.session), "lab", approved.sourceId), /changed/);
    } finally {
        f.close();
    }
});

test("append-only source checkpoints preserve 64-bit keys after durable capture", async () => {
    const f = fixture();
    try {
        const item = await configured(f);
        await f.vendor.discover(f.session, { projectId: "lab", id: item.id });
        const plan = {
            schemaFingerprint: "c".repeat(64),
            root: 1,
            fields: [{ table: 1, column: 1, field: "recordId", representation: "native" }],
            joins: [],
            filters: [],
            limit: 1,
        };
        const preview = await f.vendor.previewPlan(f.session, {
            projectId: "lab",
            id: item.id,
            plan,
            cursor: { table: 1, column: 1, field: "recordId" },
            appendOnlyAcknowledged: true,
            comment: "Synthetic strict committed-key visibility contract",
        });
        await f.vendor.commitPlan(f.session, preview.confirmation);
        await f.vendor.refresh(f.session, { projectId: "lab", id: item.id });
        assert.equal(f.vendor.get(f.processing.owner(f.session), item.id, "lab").lastCursorJson, "9223372036854775806");
        await f.vendor.refresh(f.session, { projectId: "lab", id: item.id });
        assert.equal(f.vendor.get(f.processing.owner(f.session), item.id, "lab").lastCursorJson, "9223372036854775807");
        assert.ok(!JSON.stringify(await f.vendor.list(f.session, "lab")).includes("9223372036854775807"));
    } finally {
        f.close();
    }
});

test("agent discovery requires explicit revocable metadata consent and never exposes source operations", async () => {
    const f = fixture();
    try {
        const item = await configured(f);
        assert.equal((await f.vendor.agentMetadata(f.session, { action: "list", projectId: "lab" })).items.length, 0);
        await assert.rejects(
            f.vendor.agentMetadata(f.session, { action: "discover", projectId: "lab", sourceId: item.id }),
            /not been shared/,
        );
        const shared = await f.vendor.metadataAccess(f.session, {
            projectId: "lab",
            id: item.id,
            expectedRevision: item.revision,
            allow: true,
        });
        const list = await f.vendor.agentMetadata(f.session, { action: "list", projectId: "lab" });
        assert.equal(list.items.length, 1);
        assert.ok(!JSON.stringify(list).includes("SYNTHETIC-SECRET-canary"));
        const overview = await f.vendor.agentMetadata(f.session, {
            action: "discover",
            projectId: "lab",
            sourceId: item.id,
        });
        assert.equal(overview.metadataOnly, true);
        assert.equal(overview.patientRowsIncluded, false);
        assert.equal(overview.metadata.tables[0].columns, undefined);
        const detail = await f.vendor.agentMetadata(f.session, {
            action: "discover",
            projectId: "lab",
            sourceId: item.id,
            tableId: 1,
        });
        assert.equal(detail.metadata.tables[0].columns[0].name, "patientId");
        assert.ok(!JSON.stringify(detail).includes("SYNTHETIC-PATIENT-CANARY"));
        await assert.rejects(
            f.vendor.agentMetadata(f.session, { action: "extract", projectId: "lab", sourceId: item.id }),
            /metadata action/,
        );
        await f.vendor.metadataAccess(f.session, {
            projectId: "lab",
            id: item.id,
            expectedRevision: shared.revision,
            allow: false,
        });
        await assert.rejects(
            f.vendor.agentMetadata(f.session, { action: "discover", projectId: "lab", sourceId: item.id }),
            /not been shared/,
        );
    } finally {
        f.close();
    }
});
