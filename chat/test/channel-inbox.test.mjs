import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelInbox } from "../src/channel-inbox.mjs";
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "modeller-inbox-")),
        file = join(root, "inbox.sqlite");
    let inbox = new ChannelInbox(file);
    t.after(() => {
        inbox.close();
        rmSync(root, { recursive: true, force: true });
    });
    return {
        get inbox() {
            return inbox;
        },
        restart() {
            inbox.close();
            inbox = new ChannelInbox(file);
            return inbox;
        },
    };
}
test("durable receipt survives restart and suppresses duplicates without expiring old checkpoints", (t) => {
    const f = fixture(t);
    const first = f.inbox.enqueue("owner:channel", "digest-0", "job-0", 1);
    f.inbox.finish("owner:channel", "digest-0", "COMPLETED");
    for (let i = 1; i <= 10001; i++) f.inbox.enqueue("owner:channel", "digest-" + i, "job-" + i, i + 1);
    f.restart();
    const duplicate = f.inbox.enqueue("owner:channel", "digest-0", "different-job", 20000);
    assert.equal(duplicate.sequence, first.sequence);
    assert.equal(duplicate.job, "job-0");
    assert.equal(duplicate.state, "COMPLETED");
    assert.equal(f.inbox.summary("owner:channel").counts.QUEUED, 10001);
    assert.equal(f.inbox.summary("different:channel").oldestPendingAt, null);
});
test("FIFO blocks on held/blocked head while ready ordering can pass dependencies and bounded retry waits", (t) => {
    const f = fixture(t);
    f.inbox.enqueue("s", "a", "job-a", 1);
    f.inbox.enqueue("s", "b", "job-b", 2);
    assert.equal(f.inbox.claim("s", "fifo", 3).job, "job-a");
    assert.equal(f.inbox.claim("s", "fifo", 3), null);
    f.inbox.finish("s", "a", "HELD", null, 100);
    assert.equal(f.inbox.claim("s", "fifo", 4), null);
    assert.equal(f.inbox.claim("s", "ready", 4).job, "job-b");
    f.inbox.finish("s", "b", "COMPLETED");
    assert.equal(f.inbox.claim("s", "fifo", 100).job, "job-a");
    f.inbox.finish("s", "a", "RETRY", "WORKER_UNAVAILABLE", 200);
    assert.equal(f.inbox.claim("s", "ready", 199), null);
    assert.equal(f.inbox.claim("s", "ready", 200).attempts, 3);
});
test("crashed processing requires explicit recovery and retains the original job identity", (t) => {
    const f = fixture(t);
    f.inbox.enqueue("s", "a", "job-a", 1);
    f.inbox.claim("s", "fifo", 2);
    f.restart();
    assert.equal(f.inbox.find("s", "a").state, "INTERRUPTED");
    assert.equal(f.inbox.claim("s", "ready", 3), null);
    f.inbox.recover("s");
    assert.equal(f.inbox.claim("s", "fifo", 4).job, "job-a");
});
