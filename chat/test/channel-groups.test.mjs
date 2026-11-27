import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ChannelGroups } from "../src/channel-groups.mjs";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const person = (subject, issuer = "https://synthetic.example/identity", roles = ["modelling-modeller"]) => ({
    identity: issuer + "\n" + subject,
    name: subject,
    reviewIdentity: {
        issuer,
        subject,
        tenant: issuer,
        method: "interactive_local",
        roles,
        started: Math.floor(Date.now() / 1000),
    },
});
function fixture(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "modeller-group-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = {
        dataDir,
        reviewKeyId: "test",
        reviewSigningKey: "synthetic-test-key-".repeat(3),
        sessionSeconds: 3600,
        reviewSessionSeconds: 600,
    };
    const owner = person("owner"),
        viewer = person("viewer"),
        other = person("other"),
        foreign = person("foreign", "https://other.example/identity");
    const channelId = "a".repeat(64),
        ownerId = hash(owner.identity);
    const processing = {
        channels: new Map([
            [
                ownerId + ":" + channelId,
                {
                    name: "Synthetic laboratory feed",
                    projectId: "lab",
                    revision: 2,
                    subject: "b".repeat(64),
                    mode: "export",
                    status: "RUNNING",
                    error: "private-record-canary",
                    sourceId: "secret-source",
                    completedFiles: { "private-filename": 1 },
                    activeJob: "c".repeat(64),
                },
            ],
        ]),
        status: () => ({
            active: true,
            status: "RUNNING",
            read: 12,
            rejected: 1,
            emitted: 11,
            record: "private-record-canary",
            file: "private-filename",
            token: "secret-value",
        }),
    };
    const access = new ChannelGroups(config, processing);
    for (const session of [owner, viewer, other, foreign]) access.list(session);
    const change = (session, input) => access.change(session, input);
    let group = change(owner, { kind: "group", action: "create", name: "Laboratory" });
    const edit = (input) =>
        (group = change(owner, { kind: "group", id: group.id, expectedRevision: group.revision, ...input }));
    return {
        access,
        config,
        owner,
        viewer,
        other,
        foreign,
        processing,
        channelId,
        ownerId,
        group: () => group,
        edit,
        change,
    };
}
test("owner explicitly groups a private channel; view and monitor return different allowlisted summaries", (t) => {
    const f = fixture(t);
    assert.equal(f.access.list(f.viewer).groups.length, 0);
    f.edit({ action: "attach", channelId: f.channelId });
    f.edit({ action: "grants", grants: [{ kind: "user", id: hash(f.viewer.identity), permissions: ["view"] }] });
    let group = f.access.list(f.viewer).groups[0];
    assert.equal(group.channels[0].mapping, "b".repeat(64));
    assert.equal(group.channels[0].status, undefined);
    assert.equal(group.grants, undefined);
    f.edit({ action: "grants", grants: [{ kind: "user", id: hash(f.viewer.identity), permissions: ["monitor"] }] });
    group = f.access.list(f.viewer).groups[0];
    assert.equal(group.channels[0].read, 12);
    assert.equal(group.channels[0].status, "RUNNING");
    assert.equal(group.channels[0].hasFailure, true);
    assert.ok(
        !/private-record-canary|private-filename|secret-source|secret-value|activeJob|owner_hash/.test(
            JSON.stringify(group),
        ),
    );
    assert.equal(f.access.list(f.other).groups.length, 0);
    assert.equal(f.access.list(f.foreign).groups.length, 0);
});
test("revoking a direct grant immediately removes monitoring; sharing never grants operational or approval rights", (t) => {
    const f = fixture(t);
    f.edit({ action: "grants", grants: [{ kind: "user", id: hash(f.viewer.identity), permissions: ["monitor"] }] });
    assert.deepEqual(f.access.list(f.viewer).groups[0].permissions.sort(), ["monitor", "view"]);
    assert.throws(
        () =>
            f.change(f.viewer, {
                kind: "group",
                action: "grants",
                id: f.group().id,
                expectedRevision: f.group().revision,
                grants: [],
            }),
        /owner/,
    );
    f.edit({ action: "grants", grants: [] });
    assert.equal(f.access.list(f.viewer).groups.length, 0);
    const audit = f.access.audit(f.owner, f.group().id).items;
    assert.equal(audit.at(-1).before.grants.length, 1);
    assert.equal(audit.at(-1).after.grants.length, 0);
});
test("team grants follow membership changes across reloads and remain manageable after team ownership transfer", (t) => {
    const f = fixture(t);
    let team = f.change(f.owner, { kind: "team", action: "create", name: "Operations" });
    team = f.change(f.owner, {
        kind: "team",
        action: "members",
        id: team.id,
        expectedRevision: team.revision,
        members: [hash(f.viewer.identity)],
    });
    f.edit({ action: "grants", grants: [{ kind: "team", id: team.id, permissions: ["monitor"] }] });
    assert.equal(f.access.list(f.viewer).groups.length, 1);
    team = f.change(f.owner, {
        kind: "team",
        action: "transfer",
        id: team.id,
        expectedRevision: team.revision,
        newOwner: hash(f.other.identity),
    });
    f.edit({ action: "grants", grants: [{ kind: "team", id: team.id, permissions: ["view"] }] });
    f.change(f.other, { kind: "team", action: "members", id: team.id, expectedRevision: team.revision, members: [] });
    const restarted = new ChannelGroups(f.config, f.processing);
    assert.equal(restarted.list(f.viewer).groups.length, 0);
    assert.equal(restarted.list(f.owner).groups[0].grants[0].kind, "team");
});
test("concurrent edits require current revisions and ownership transfer retains an explicit owner", (t) => {
    const f = fixture(t),
        previous = f.group();
    f.edit({ action: "rename", name: "Laboratory operations" });
    assert.throws(
        () =>
            f.change(f.owner, {
                kind: "group",
                action: "rename",
                id: previous.id,
                expectedRevision: previous.revision,
                name: "Stale edit",
            }),
        /changed/,
    );
    f.edit({ action: "attach", channelId: f.channelId });
    assert.throws(() => f.edit({ action: "transfer", newOwner: hash(f.viewer.identity) }), /Detach/);
    const binding = f.access.list(f.owner).groups[0].channels[0].reference;
    f.edit({ action: "detach", reference: binding });
    f.edit({ action: "transfer", newOwner: hash(f.viewer.identity) });
    assert.equal(f.access.list(f.owner).groups.length, 0);
    assert.ok(f.access.list(f.viewer).groups[0].permissions.includes("manage"));
    assert.ok(
        f.processing.channels.has(f.ownerId + ":" + f.channelId),
        "detaching or transferring does not delete the private channel",
    );
});
test("sign-in age, same-organisation directory and registered ownership are enforced", (t) => {
    const f = fixture(t);
    const old = structuredClone(f.owner);
    old.reviewIdentity.started -= 601;
    assert.throws(() => f.access.change(old, { kind: "group", action: "create", name: "Old sign-in" }), /Refresh/);
    assert.equal(f.access.directory(f.owner).items.length, 3);
    assert.throws(
        () =>
            f.edit({
                action: "grants",
                grants: [{ kind: "user", id: hash(f.foreign.identity), permissions: ["view"] }],
            }),
        /registered/,
    );
    assert.throws(() => f.edit({ action: "attach", channelId: "f".repeat(64) }), /own/);
    const reader = person("reader", f.owner.reviewIdentity.issuer, ["modelling-reviewer"]);
    f.access.list(reader);
    assert.throws(() => f.change(reader, { kind: "group", action: "create", name: "Reader" }), /modeller/);
});
test("access metadata is private signed platform storage and survives active signing-key rotation", (t) => {
    const f = fixture(t);
    const file = join(f.config.dataDir, "channel-access", "access.json");
    const rotated = new ChannelGroups(
        {
            ...f.config,
            reviewKeyId: "next",
            integrationApprovalKeys: { test: f.config.reviewSigningKey, next: "another-synthetic-test-key-".repeat(3) },
        },
        f.processing,
    );
    assert.equal(rotated.list(f.owner).groups.length, 1);
    rotated.change(f.owner, {
        kind: "group",
        action: "rename",
        id: f.group().id,
        expectedRevision: 1,
        name: "Rotated",
    });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).key, "next");
    const envelope = JSON.parse(readFileSync(file, "utf8"));
    envelope.body = envelope.body.replace("Rotated", "Different");
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(() => rotated.list(f.owner), /cannot be verified/);
});
