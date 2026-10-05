import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.mjs";
import { Auth } from "../src/auth.mjs";
import { loadConfig } from "../src/config.mjs";

function config(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "recovery-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    return { ...loadConfig(), dataDir, providerEncryptionKey: "ab".repeat(32) };
}
test("draft and evidence recovery survives restart, isolates owners, and never caches CDR data", (t) => {
    const c = config(t),
        first = new Checkpoints(c, "alice", "one");
    first.capture(
        "template_build_oet",
        {},
        { structuredContent: { success: true, result: { content: "exact private OET" } } },
    );
    first.capture("aql_execute", {}, { structuredContent: { rows: ["patient-canary"] } });
    first.capture("personal_repository_get", {}, { structuredContent: { content: "stale-revision" } });
    first.capture("template_build_oet", {}, { isError: true, structuredContent: { content: "failed-output" } });
    const second = new Checkpoints(c, "alice", "one"),
        summary = second.summary();
    assert.equal(summary.durable, true);
    assert.equal(summary.drafts.length, 1);
    assert.equal(summary.steps.length, 1);
    const id = summary.drafts[0].id;
    assert.equal(second.getDraft(id).content, "exact private OET");
    assert(!JSON.stringify(summary).includes("exact private OET"));
    for (const [owner, chat] of [
        ["bob", "one"],
        ["alice", "two"],
    ])
        assert.throws(() => new Checkpoints(c, owner, chat).getDraft(id), /unavailable/);
    const file = join(c.dataDir, "checkpoints", readdirSync(join(c.dataDir, "checkpoints"))[0]);
    assert(!readFileSync(file, "utf8").includes("exact private OET"));
    second.delete();
    assert.equal(new Checkpoints(c, "alice", "one").summary().drafts.length, 0);
});
test("checkpoint reads are paginated, drafts deduplicate and retention is bounded", (t) => {
    const c = config(t),
        journal = new Checkpoints(c, "alice", "chat");
    const id = journal.draft("x".repeat(25000), "query.aql");
    assert.equal(journal.draft("x".repeat(25000), "query.aql"), id);
    assert.equal(journal.read({ id }).nextOffset, 24000);
    assert.equal(journal.read({ id, offset: 24000 }).content.length, 1000);
    assert.throws(() => journal.read({ id, offset: -1 }));
    assert.equal(journal.draft("x".repeat(2 * 1024 * 1024 + 1)), null);
    for (let i = 0; i < 25; i++) journal.draft("draft " + i);
    assert.equal(journal.summary().drafts.length, 16);
});
test("organisation sessions survive restart, renew without changing authentication age, and revoke durably", (t) => {
    const c = config(t),
        auth = new Auth(c),
        started = Date.now() - 1800000;
    const session = {
        identity: "issuer\nalice",
        csrf: "csrf",
        started,
        expires: Date.now() + 10000,
        reviewIdentity: { started: Math.floor(started / 1000) },
    };
    auth.sessionStore.set("private-session-token", "session", session);
    const req = {
        headers: { cookie: "ModellingSession=private-session-token", origin: c.origin, "x-csrf-token": "csrf" },
    };
    const restarted = new Auth(c),
        headers = {},
        res = { setHeader: (key, value) => (headers[key] = value) };
    assert.equal(restarted.session(req).identity, session.identity);
    assert(restarted.renew(req, res).expires > session.expires);
    assert.equal(restarted.session(req).reviewIdentity.started, session.reviewIdentity.started);
    assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Lax/);
    assert.throws(() => restarted.renew({ headers: { ...req.headers, "x-csrf-token": "wrong" } }, res));
    assert.equal(new Auth(c).session(req).identity, session.identity);
    restarted.logout(req, res);
    assert.equal(new Auth(c).session(req), undefined);
    auth.sessionStore.set("private-session-token", "session", { ...session, expires: Date.now() - 1 });
    assert.equal(new Auth(c).session(req), undefined);
    auth.sessionStore.set("private-session-token", "session", { ...session, started: Date.now() - 9 * 3600000 });
    assert.throws(() => new Auth(c).renew(req, res), /sign in again/);
});
