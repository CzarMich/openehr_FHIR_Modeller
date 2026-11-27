import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    existsSync,
    openSync,
    closeSync,
    unlinkSync,
    lstatSync,
    fsyncSync,
} from "node:fs";
import { join } from "node:path";
import { problem } from "./personal-http.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const idPattern = /^[a-f0-9]{64}$/;
const rights = new Set(["view", "monitor"]);
const canCreate = (actor) => actor.roles.some((r) => ["modelling-modeller", "modelling-administrator"].includes(r));
const allowedFields = (input, keys) => {
    if (
        !input ||
        Array.isArray(input) ||
        typeof input !== "object" ||
        Object.keys(input).some((key) => !keys.includes(key))
    )
        throw problem("Invalid group settings.");
};
function name(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value))
        throw problem("Enter a name within 100 characters. Use operational names without patient information.");
    return value.trim();
}

// Browser-only access records live outside the editable model repository and clinical databases.
export class ChannelGroups {
    constructor(config, processing, { clock = Date.now } = {}) {
        this.config = config;
        this.processing = processing;
        this.clock = clock;
        this.root = join(config.dataDir, "channel-access");
        this.file = join(this.root, "access.json");
        this.lock = join(this.root, "access.lock");
        this.keys = config.integrationApprovalKeys || { [config.reviewKeyId]: config.reviewSigningKey };
        this.activeKey = config.reviewKeyId;
    }
    actor(session, changing = false) {
        const identity = session?.reviewIdentity,
            now = Math.floor(this.clock() / 1000);
        if (
            !identity ||
            typeof identity.issuer !== "string" ||
            typeof identity.subject !== "string" ||
            identity.tenant !== identity.issuer ||
            !["interactive_local", "interactive_oidc"].includes(identity.method || "interactive_oidc") ||
            session.identity !== identity.issuer + "\n" + identity.subject ||
            session.mfaSetupRequired ||
            !Number.isFinite(identity.started) ||
            identity.started > now ||
            now - identity.started > (changing ? this.config.reviewSessionSeconds : this.config.sessionSeconds)
        )
            throw problem("Refresh your interactive sign-in to use channel groups.", 401);
        return {
            id: hash(session.identity),
            tenant: hash(identity.issuer),
            roles: identity.roles || [],
            label: String(session.name || "Workspace user").slice(0, 160),
        };
    }
    signature(key, body) {
        if (typeof this.keys[key] !== "string" || this.keys[key].length < 32)
            throw problem("Channel access signing is unavailable.", 503);
        return createHmac("sha256", this.keys[key])
            .update("openehr-channel-access-v1\n" + body)
            .digest("hex");
    }
    read() {
        if (!existsSync(this.file)) return { schema: 1, sequence: 0, principals: [], groups: [], teams: [], audit: [] };
        try {
            if (lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 8 * 1024 * 1024) throw new Error();
            const envelope = JSON.parse(readFileSync(this.file, "utf8"));
            const expected = this.signature(envelope.key, envelope.body);
            if (
                !/^[a-f0-9]{64}$/.test(envelope.signature) ||
                !timingSafeEqual(Buffer.from(expected), Buffer.from(envelope.signature))
            )
                throw new Error();
            const state = JSON.parse(envelope.body);
            if (state.schema !== 1) throw new Error();
            return state;
        } catch {
            throw problem("Channel access metadata cannot be verified. Ask the platform operator to recover it.", 503);
        }
    }
    transaction(actor, operation, apply) {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        let lock;
        try {
            lock = openSync(this.lock, "wx", 0o600);
        } catch {
            throw problem(
                "Channel access is being changed. Reload and retry; a persistent lock needs operator recovery.",
                409,
            );
        }
        let temporary;
        try {
            const state = this.read();
            const before = structuredClone([...state.groups, ...state.teams]);
            const result = apply(state);
            const accessRecord = (item) =>
                item
                    ? { owner: item.owner, grants: item.grants, members: item.members, channels: item.channels }
                    : null;
            const previous = accessRecord(before.find((item) => item.id === result.id));
            const updated = accessRecord([...state.groups, ...state.teams].find((item) => item.id === result.id));
            state.sequence++;
            state.audit.push({
                sequence: state.sequence,
                actor: actor.id,
                tenant: actor.tenant,
                operation,
                at: new Date(this.clock()).toISOString(),
                resource: result.id,
                revision: result.revision,
                before: previous,
                after: updated,
            });
            if (state.audit.length > 10000)
                throw problem("Channel access audit storage needs archiving by the operator.", 409);
            const body = JSON.stringify(state),
                envelope = JSON.stringify({
                    key: this.activeKey,
                    body,
                    signature: this.signature(this.activeKey, body),
                });
            if (Buffer.byteLength(envelope) > 8 * 1024 * 1024)
                throw problem("Channel access storage limit reached.", 409);
            temporary = this.file + "." + randomBytes(16).toString("hex") + ".tmp";
            const fd = openSync(temporary, "wx", 0o600);
            try {
                writeFileSync(fd, envelope);
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            renameSync(temporary, this.file);
            return structuredClone(result);
        } finally {
            if (temporary && existsSync(temporary)) unlinkSync(temporary);
            closeSync(lock);
            unlinkSync(this.lock);
        }
    }
    directory(session, localUsers = []) {
        const actor = this.actor(session);
        const current = this.read();
        if (
            !canCreate(actor) &&
            ![...current.groups, ...current.teams].some(
                (item) => item.owner === actor.id && item.tenant === actor.tenant,
            )
        )
            throw problem("A group owner or modeller manages the sharing directory.", 403);
        const additions = [{ id: actor.id, tenant: actor.tenant, label: actor.label }, ...localUsers];
        const changed = additions.some(
            (p) => !current.principals.some((q) => q.id === p.id && q.tenant === p.tenant && q.label === p.label),
        );
        if (changed)
            this.transaction(actor, "DIRECTORY_UPDATED", (state) => {
                for (const item of additions) {
                    if (item.tenant !== actor.tenant || !idPattern.test(item.id))
                        throw problem("Invalid sharing directory.");
                    const previous = state.principals.findIndex((p) => p.id === item.id && p.tenant === actor.tenant);
                    if (previous < 0)
                        state.principals.push({
                            id: item.id,
                            tenant: actor.tenant,
                            label: String(item.label).slice(0, 160),
                        });
                    else state.principals[previous].label = String(item.label).slice(0, 160);
                }
                if (state.principals.length > 2000) throw problem("The sharing directory limit was reached.", 409);
                return { id: actor.id, revision: state.sequence + 1 };
            });
        return {
            self: actor.id,
            items: this.read()
                .principals.filter((p) => p.tenant === actor.tenant)
                .map(({ id, label }) => ({ id, label })),
        };
    }
    access(state, group, actor) {
        if (group.tenant !== actor.tenant) return [];
        if (group.owner === actor.id) return ["manage", "view", "monitor"];
        const granted = new Set();
        for (const grant of group.grants) {
            const matches =
                grant.kind === "user"
                    ? grant.id === actor.id
                    : state.teams.some(
                          (team) =>
                              team.id === grant.id && team.tenant === actor.tenant && team.members.includes(actor.id),
                      );
            if (matches) {
                granted.add("view");
                for (const right of grant.permissions) granted.add(right);
            }
        }
        return [...granted];
    }
    list(session) {
        const actor = this.actor(session);
        let state = this.read();
        if (!state.principals.some((p) => p.id === actor.id && p.tenant === actor.tenant)) {
            this.transaction(actor, "PRINCIPAL_REGISTERED", (current) => {
                if (current.principals.length >= 2000) throw problem("The sharing directory limit was reached.", 409);
                current.principals.push({ id: actor.id, tenant: actor.tenant, label: actor.label });
                return { id: actor.id, revision: current.sequence + 1 };
            });
            state = this.read();
        }
        return {
            self: actor.id,
            canCreate: canCreate(actor),
            groups: state.groups.flatMap((group) => {
                const permissions = this.access(state, group, actor);
                if (!permissions.length) return [];
                const visible = {
                    id: group.id,
                    name: group.name,
                    revision: group.revision,
                    owner: group.owner,
                    permissions,
                    channels: group.channels.map((binding) => this.summary(binding, permissions.includes("monitor"))),
                };
                if (group.owner === actor.id) visible.grants = group.grants;
                return [visible];
            }),
            teams: state.teams
                .filter(
                    (team) =>
                        team.tenant === actor.tenant &&
                        (team.owner === actor.id ||
                            team.members.includes(actor.id) ||
                            state.groups.some(
                                (g) =>
                                    g.owner === actor.id &&
                                    g.tenant === actor.tenant &&
                                    g.grants.some((grant) => grant.kind === "team" && grant.id === team.id),
                            )),
                )
                .map((team) => ({ ...team, tenant: undefined })),
        };
    }
    summary(binding, monitor) {
        const channel = this.processing.channels.get(binding.owner + ":" + binding.channel);
        if (!channel) return { reference: binding.reference, unavailable: true };
        const summary = {
            reference: binding.reference,
            name: channel.name,
            projectId: channel.projectId,
            revision: channel.revision,
            mapping: channel.subject,
            mode: channel.mode,
        };
        if (!monitor) return summary;
        summary.status = ["RUNNING", "STOPPING", "STOPPED", "INTERRUPTED", "PAUSED"].includes(channel.status)
            ? channel.status
            : "UNKNOWN";
        summary.hasFailure = !!channel.error;
        summary.waitingJobs = Math.min(1000000, channel.waitingJobs?.length || 0);
        summary.completedFiles = Math.min(1000000, Object.keys(channel.completedFiles || {}).length);
        if (channel.activeJob) {
            // Never forward the complete private job/report, filenames, errors or output.
            const state = this.processing.status(binding.owner, channel.activeJob);
            summary.active = !!state.active;
            summary.jobStatus = [
                "RUNNING",
                "PENDING",
                "CANCELLED",
                "INTERRUPTED",
                "COMPLETED",
                "COMPLETED_WITH_FAILURES",
                "FAILED",
                "WAITING_DEPENDENCIES",
                "DELIVERY_UNCERTAIN",
                "BLOCKED",
            ].includes(state.status)
                ? state.status
                : "UNKNOWN";
            for (const key of ["read", "rejected", "emitted", "held"])
                if (Number.isSafeInteger(state[key]) && state[key] >= 0) summary[key] = state[key];
        }
        return summary;
    }
    change(session, input) {
        const actor = this.actor(session, true);
        allowedFields(input, [
            "kind",
            "action",
            "id",
            "expectedRevision",
            "name",
            "members",
            "grants",
            "channelId",
            "reference",
            "newOwner",
        ]);
        if (
            !["group", "team"].includes(input.kind) ||
            !["create", "rename", "members", "grants", "attach", "detach", "transfer"].includes(input.action)
        )
            throw problem("Choose a group or team action.");
        return this.transaction(actor, input.kind.toUpperCase() + "_" + input.action.toUpperCase(), (state) => {
            const items = input.kind === "group" ? state.groups : state.teams;
            if (input.action === "create") {
                if (!canCreate(actor)) throw problem("Only a verified modeller can create groups or teams.", 403);
                if (items.filter((item) => item.tenant === actor.tenant).length >= 128)
                    throw problem("The group/team limit was reached.", 409);
                const item = {
                    id: randomBytes(32).toString("hex"),
                    tenant: actor.tenant,
                    name: name(input.name),
                    owner: actor.id,
                    revision: 1,
                    ...(input.kind === "group" ? { grants: [], channels: [] } : { members: [actor.id] }),
                };
                items.push(item);
                return { id: item.id, revision: item.revision };
            }
            const item = items.find(
                (entry) => entry.id === input.id && entry.tenant === actor.tenant && entry.owner === actor.id,
            );
            if (!item) throw problem("Only the owner can change this group or team.", 403);
            if (item.revision !== input.expectedRevision)
                throw problem("The group or team changed. Reload before saving.", 409);
            const known = (id) => state.principals.some((p) => p.id === id && p.tenant === actor.tenant);
            if (input.action === "rename") item.name = name(input.name);
            else if (input.action === "transfer") {
                if (input.kind === "group" && item.channels.length)
                    throw problem(
                        "Detach channel assignments before transferring group ownership. Private channel ownership cannot be transferred by a group grant.",
                        409,
                    );
                if (!known(input.newOwner) || input.newOwner === actor.id)
                    throw problem("Choose another registered person in your organisation.");
                item.owner = input.newOwner;
                // Every group always retains one owner; former owners lose management immediately.
            } else if (input.action === "members" && input.kind === "team") {
                if (
                    !Array.isArray(input.members) ||
                    input.members.length > 200 ||
                    new Set(input.members).size !== input.members.length ||
                    !input.members.every(known)
                )
                    throw problem("Choose registered team members in this organisation.");
                item.members = input.members;
            } else if (input.action === "grants" && input.kind === "group") {
                if (!Array.isArray(input.grants) || input.grants.length > 200)
                    throw problem("Choose up to 200 sharing grants.");
                const unique = new Set();
                for (const grant of input.grants) {
                    allowedFields(grant, ["kind", "id", "permissions"]);
                    const valid =
                        grant.kind === "user"
                            ? known(grant.id)
                            : grant.kind === "team" &&
                              state.teams.some(
                                  (t) =>
                                      t.id === grant.id &&
                                      t.tenant === actor.tenant &&
                                      (t.owner === actor.id ||
                                          item.grants.some((g) => g.kind === "team" && g.id === t.id)),
                              );
                    const key = grant.kind + ":" + grant.id;
                    if (
                        !valid ||
                        unique.has(key) ||
                        !Array.isArray(grant.permissions) ||
                        !grant.permissions.length ||
                        !grant.permissions.every((p) => rights.has(p))
                    )
                        throw problem("Choose registered people or teams you manage, with view or monitor access.");
                    unique.add(key);
                }
                item.grants = structuredClone(input.grants);
            } else if (input.action === "attach" && input.kind === "group") {
                if (!idPattern.test(input.channelId) || !this.processing.channels.has(actor.id + ":" + input.channelId))
                    throw problem("Choose a channel you own.", 403);
                if (item.channels.length >= 128) throw problem("This group has reached its channel limit.", 409);
                if (item.channels.some((b) => b.owner === actor.id && b.channel === input.channelId))
                    throw problem("The channel is already in this group.", 409);
                item.channels.push({
                    owner: actor.id,
                    channel: input.channelId,
                    reference: hash(actor.id + "\n" + input.channelId),
                });
            } else if (input.action === "detach" && input.kind === "group") {
                if (!item.channels.some((b) => b.reference === input.reference))
                    throw problem("Channel assignment not found.", 404);
                item.channels = item.channels.filter((b) => b.reference !== input.reference);
            } else throw problem("Unsupported group or team action.");
            item.revision++;
            return { id: item.id, revision: item.revision };
        });
    }
    audit(session, id) {
        const actor = this.actor(session),
            state = this.read();
        if (
            ![...state.groups, ...state.teams].some(
                (item) => item.id === id && item.tenant === actor.tenant && item.owner === actor.id,
            )
        )
            throw problem("Only the owner can review this access history.", 403);
        return { items: state.audit.filter((entry) => entry.resource === id && entry.tenant === actor.tenant) };
    }
}
