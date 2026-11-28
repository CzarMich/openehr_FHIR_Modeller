import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, statSync } from "node:fs";

// Transport checkpoints only. Payloads remain in private job storage, never in model context.
export class ChannelInbox {
    constructor(file) {
        this.file = file;
        this.db = new DatabaseSync(file);
        chmodSync(file, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS inputs (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, digest TEXT NOT NULL,
                job TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                due INTEGER NOT NULL DEFAULT 0, error TEXT, received INTEGER NOT NULL,
                UNIQUE(scope,digest));
            CREATE INDEX IF NOT EXISTS input_queue ON inputs(scope,state,sequence);
            UPDATE inputs SET state='INTERRUPTED' WHERE state='RUNNING';`);
    }
    find(scope, digest) {
        return this.db.prepare("SELECT * FROM inputs WHERE scope=? AND digest=?").get(scope, digest);
    }
    enqueue(scope, digest, job, now) {
        if (this.find(scope, digest)) return this.find(scope, digest);
        if (
            [this.file, this.file + "-wal"].filter(existsSync).reduce((bytes, file) => bytes + statSync(file).size, 0) >
            256 * 1048576
        )
            throw Object.assign(new Error("INTAKE_CHECKPOINT_STORAGE_LIMIT"), { status: 413 });
        this.db
            .prepare(
                "INSERT INTO inputs(scope,digest,job,state,received) VALUES(?,?,?,'QUEUED',?) ON CONFLICT(scope,digest) DO NOTHING",
            )
            .run(scope, digest, job, now);
        return this.find(scope, digest);
    }
    recover(scope) {
        this.db.prepare("UPDATE inputs SET state='QUEUED' WHERE scope=? AND state='INTERRUPTED'").run(scope);
    }
    claim(scope, mode, now) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            // Strict FIFO includes held/blocked work; ready-order mode may pass held dependencies.
            const item = this.db
                .prepare(
                    mode === "fifo"
                        ? "SELECT * FROM inputs WHERE scope=? AND state NOT IN ('COMPLETED','QUARANTINED') ORDER BY sequence LIMIT 1"
                        : "SELECT * FROM inputs WHERE scope=? AND state IN ('QUEUED','HELD','RETRY') AND due<=? ORDER BY CASE WHEN state='HELD' THEN " +
                              (mode === "held-first" ? "0 ELSE 1" : "1 ELSE 0") +
                              " END,sequence LIMIT 1",
                )
                .get(...(mode === "fifo" ? [scope] : [scope, now]));
            if (!item || !["QUEUED", "HELD", "RETRY"].includes(item.state) || item.due > now) {
                this.db.exec("COMMIT");
                return null;
            }
            this.db
                .prepare("UPDATE inputs SET state='RUNNING',attempts=attempts+1 WHERE sequence=?")
                .run(item.sequence);
            this.db.exec("COMMIT");
            return { ...item, previousState: item.state, state: "RUNNING", attempts: item.attempts + 1 };
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    finish(scope, digest, state, error = null, due = 0) {
        if (!["COMPLETED", "QUARANTINED", "HELD", "RETRY", "BLOCKED", "INTERRUPTED"].includes(state))
            throw new Error("Invalid intake checkpoint");
        this.db
            .prepare("UPDATE inputs SET state=?,error=?,due=? WHERE scope=? AND digest=?")
            .run(state, error, due, scope, digest);
    }
    entries(scope, state) {
        return this.db.prepare("SELECT * FROM inputs WHERE scope=? AND state=? ORDER BY sequence").all(scope, state);
    }
    summary(scope) {
        const rows = this.db
            .prepare("SELECT state,count(*) AS count,min(received) AS oldest FROM inputs WHERE scope=? GROUP BY state")
            .all(scope);
        const pending = rows.filter((row) => !["COMPLETED", "QUARANTINED"].includes(row.state));
        return {
            counts: Object.fromEntries(rows.map((row) => [row.state, row.count])),
            oldestPendingAt: pending.length ? Math.min(...pending.map((row) => row.oldest)) : null,
        };
    }
    close() {
        this.db.close();
    }
}
