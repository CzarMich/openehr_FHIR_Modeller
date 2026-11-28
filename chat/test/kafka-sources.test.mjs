import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { KafkaSources } from "../src/kafka-sources.mjs";
import { ClinicalDestinations } from "../src/clinical-destinations.mjs";
import { ProcessingWorkspace } from "../src/processing.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
const input = {
    projectId: "lab",
    displayName: "Synthetic topic",
    identityDomain: "urn:synthetic:patients",
    valueFormat: "json-envelope",
    brokers: ["localhost:9093"],
    topic: "synthetic-clinical",
    authentication: "plain",
    username: "reader",
    password: "SYNTHETIC-KAFKA-SECRET-CANARY",
    maximumMessages: 16,
    comment: "Reviewed synthetic source contract",
};
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "kafka-durable-")),
        session = { identity: "owner" };
    const core = {
        configuration: { operationalKeyFile: join(root, "key") },
        request: async (s) => {
            if (s.identity !== "owner") throw new Error("Denied");
            return {};
        },
    };
    writeFileSync(core.configuration.operationalKeyFile, Buffer.alloc(32, 7));
    const processing = new ProcessingWorkspace({ dataDir: root }, core);
    let captures = 0,
        acks = 0,
        failCommit = false,
        corrupt = false;
    const launcher = (_, args) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        let body = "",
            seen = false,
            done = false;
        child.kill = () => {
            if (!done) {
                done = true;
                child.emit("exit", 1);
            }
            return true;
        };
        child.stdin.on("data", (chunk) => {
            body += chunk.toString();
            if (!seen && body.includes("\n")) {
                seen = true;
                const request = JSON.parse(body.split("\n")[0]);
                assert.equal(request.profile.password, input.password);
                queueMicrotask(() => {
                    if (args[0] === "discover") {
                        child.stdout.write(
                            JSON.stringify({
                                clusterId: "cluster",
                                topicId: "topic-id",
                                partitions: 1,
                                tlsVerified: true,
                            }),
                        );
                        done = true;
                        child.emit("exit", 0);
                        return;
                    }
                    captures++;
                    const offset = "9223372036854775805",
                        eventId = hash(JSON.stringify(["cluster", "topic-id", input.topic, "0", offset]));
                    const bytes = Buffer.from('[{"patient":"SYNTHETIC-PATIENT-CANARY"}]'),
                        envelope = Buffer.from(
                            JSON.stringify([{ transport: { eventId, offset }, payload: JSON.parse(bytes)[0] }]),
                        );
                    const file = "message-" + eventId + ".bin";
                    writeFileSync(join(args[1], file), bytes);
                    writeFileSync(join(args[1], "envelope-" + eventId + ".json"), envelope);
                    writeFileSync(
                        join(args[1], "manifest.json"),
                        JSON.stringify({
                            clusterId: "cluster",
                            topicId: "topic-id",
                            topic: input.topic,
                            items: [
                                {
                                    eventId,
                                    file,
                                    sha256: corrupt ? "a".repeat(64) : hash(bytes),
                                    envelopeSha256: hash(envelope),
                                    partition: 0,
                                    offset,
                                    bytes: bytes.length,
                                },
                            ],
                            nextOffsets: { 0: "9223372036854775806" },
                        }),
                    );
                    child.stdout.write('{"ready":true}\n');
                });
            } else if (body.includes("DURABLY_ACCEPTED\n")) {
                acks++;
                const owner = processing.owner(session),
                    stored = kafka.all(owner)[0];
                assert.equal(stored.afterOffsets[0], "9223372036854775806");
                assert.equal(
                    readdirSync(kafka.sourceRoot(owner, stored)).filter((x) => x.startsWith("event-")).length,
                    1,
                );
                done = true;
                child.emit("exit", failCommit ? 1 : 0);
            }
        });
        return child;
    };
    const config = { dataDir: root, integrationKafkaReader: "/synthetic/kafka" },
        kafka = new KafkaSources(config, core, processing, { launcher, runtimeFingerprint: () => "e".repeat(64) });
    return {
        root,
        session,
        processing,
        kafka,
        core,
        config,
        get captures() {
            return captures;
        },
        get acks() {
            return acks;
        },
        set failCommit(v) {
            failCommit = v;
        },
        set corrupt(v) {
            corrupt = v;
        },
        async setup() {
            const t = await kafka.preview(session, input);
            assert.ok(!JSON.stringify(t).includes(input.password));
            return kafka.commit(session, t.confirmation);
        },
        close() {
            kafka.close();
            processing.close();
            rmSync(root, { recursive: true, force: true });
        },
    };
}
test("Kafka commits only after encrypted intake and exact 64-bit cursor; repeated event and concurrent polls remain one input", async () => {
    const f = fixture();
    try {
        const profile = await f.setup();
        const owner = f.processing.owner(f.session);
        assert.equal(profile.readOnlyTopicData, true);
        await Promise.all([
            f.kafka.materialise(owner, "lab", profile.sourceId),
            f.kafka.materialise(owner, "lab", profile.sourceId),
        ]);
        assert.equal(f.captures, 1);
        assert.equal(f.acks, 1);
        f.failCommit = true;
        const second = await f.kafka.materialise(owner, "lab", profile.sourceId);
        assert.equal(second.brokerCommitted, false);
        assert.equal(f.acks, 2);
        const source = f.kafka.connections(owner, "lab")[0];
        assert.equal(readdirSync(source.root).filter((n) => n.startsWith("event-")).length, 1);
        const receiptDir = join(source.root, ".received");
        for (const path of readdirSync(receiptDir, { recursive: true }).filter((n) => String(n).endsWith(".json")))
            assert.ok(!readFileSync(join(receiptDir, path), "utf8").includes("SYNTHETIC-PATIENT-CANARY"));
        assert.ok(!JSON.stringify(await f.kafka.list(f.session, "lab")).includes(input.password));
        await assert.rejects(f.kafka.list({ identity: "other" }, "lab"));
    } finally {
        f.close();
    }
});
test("Kafka integrity failure never acknowledges and retains private capture for recovery", async () => {
    const f = fixture();
    try {
        const p = await f.setup();
        f.corrupt = true;
        await assert.rejects(f.kafka.materialise(f.processing.owner(f.session), "lab", p.sourceId), /changed/);
        assert.equal(f.acks, 0);
        assert.equal(f.kafka.all(f.processing.owner(f.session))[0].afterOffsets, null);
        const pending = f.kafka.pendingRoot(f.processing.owner(f.session), p);
        assert.ok(readdirSync(pending).some((n) => n.startsWith("capture-")));
    } finally {
        f.close();
    }
});
test("destination UI profiles encrypt credentials, rotate without changing policy, and revoke access", async () => {
    const f = fixture(),
        dest = new ClinicalDestinations(f.config, f.core, f.processing);
    try {
        const definition = {
            projectId: "lab",
            displayName: "Synthetic FHIR",
            standard: "fhir",
            baseUrl: "https://destination.invalid/fhir",
            token: "SYNTHETIC-DESTINATION-SECRET-CANARY",
            resourceTypes: ["Patient", "Observation"],
            comment: "Authorised synthetic destination",
        };
        const preview = await dest.preview(f.session, definition);
        assert.ok(!JSON.stringify(preview).includes(definition.token));
        const saved = await dest.commit(f.session, preview.confirmation);
        assert.ok(!JSON.stringify(saved).includes(definition.token));
        const owner = f.processing.owner(f.session),
            connection = dest.connections(owner, "lab")[0];
        assert.equal(readFileSync(connection.tokenFile, "utf8"), definition.token);
        const rotated = await dest.preview(f.session, {
            ...definition,
            id: saved.id,
            expectedRevision: 1,
            token: "SYNTHETIC-ROTATED-SECRET-CANARY",
        });
        await dest.commit(f.session, rotated.confirmation);
        assert.equal(dest.connections(owner, "lab")[0].id, saved.id);
        await assert.rejects(
            dest.preview(f.session, {
                ...definition,
                id: saved.id,
                expectedRevision: 2,
                baseUrl: "https://different.invalid",
            }),
            /new destination/,
        );
        await dest.setEnabled(f.session, {
            projectId: "lab",
            id: saved.id,
            expectedRevision: 2,
            enabled: false,
            comment: "Pause synthetic destination",
        });
        assert.equal(dest.connections(owner, "lab").length, 0);
        const temporary = dest.temporary;
        dest.close();
        assert.equal(existsSync(temporary), false);
        const restarted = new ClinicalDestinations(f.config, f.core, f.processing);
        try {
            assert.equal(restarted.temporary, temporary);
            await restarted.setEnabled(f.session, {
                projectId: "lab",
                id: saved.id,
                expectedRevision: 3,
                enabled: true,
                comment: "Resume after synthetic restart",
            });
            assert.equal(restarted.connections(owner, "lab")[0].tokenFile, connection.tokenFile);
        } finally {
            restarted.close();
        }
    } finally {
        dest.close();
        f.close();
    }
});
