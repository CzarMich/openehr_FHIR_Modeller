import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderStore } from "./provider-store.mjs";
import { problem } from "./personal-http.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export class ClinicalDestinations {
    constructor(config, core, processing, { store } = {}) {
        this.config = config;
        this.core = core;
        this.processing = processing;
        this.store = store;
        this.root = join(config.dataDir, "clinical-destinations");
        this.temporary = mkdtempSync(join(tmpdir(), "modeller-destination-"));
    }
    vault() {
        if (this.store) return this.store;
        const file = this.core.configuration?.operationalKeyFile;
        if (!file || !existsSync(file)) return null;
        const key = readFileSync(file);
        if (key.length !== 32) throw problem("Destination encryption is unavailable.", 503);
        const derived = Buffer.from(
            hkdfSync(
                "sha256",
                key,
                Buffer.from("modeller-destination-vault/v1"),
                Buffer.from("owner-bound-destinations"),
                32,
            ),
        );
        this.store = new ProviderStore(join(this.root, "profiles"), derived.toString("hex"), ["destinations"]);
        return this.store;
    }
    all(owner) {
        return this.vault()?.get(owner, "destinations")?.credential || [];
    }
    visible(item) {
        const { token, history, identityIssuer, ...visible } = item;
        return { ...visible, credentialConfigured: !!token, installationQualified: false };
    }
    async authorise(session, projectId) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(projectId || "")) throw problem("Choose a project.");
        return this.core.request(session, "POST", "/api/v1/integration/projects/" + projectId + "/destination-access", {
            action: "configure",
        });
    }
    async list(session, projectId) {
        await this.authorise(session, projectId);
        return {
            items: this.all(this.processing.owner(session))
                .filter((item) => item.projectId === projectId)
                .map((item) => this.visible(item)),
            credentialsReturned: false,
        };
    }
    async preview(session, input) {
        const allowed = [
            "id",
            "expectedRevision",
            "projectId",
            "displayName",
            "standard",
            "baseUrl",
            "token",
            "resourceTypes",
            "readResourceTypes",
            "openEhr",
            "comment",
        ];
        if (!input || Object.keys(input).some((key) => !allowed.includes(key)))
            throw problem("Invalid destination fields.");
        await this.authorise(session, input.projectId);
        if (
            typeof input.displayName !== "string" ||
            !input.displayName.trim() ||
            input.displayName.length > 100 ||
            typeof input.comment !== "string" ||
            input.comment.trim().length < 8 ||
            input.comment.length > 2000
        )
            throw problem("Name the destination and record its authorisation reason.");
        let url;
        try {
            url = new URL(input.baseUrl);
        } catch {
            throw problem("Use an exact HTTPS destination base URL.");
        }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
            throw problem("Use an exact HTTPS destination base URL.");
        if (
            typeof input.token !== "string" ||
            input.token.length < 16 ||
            input.token.length > 8192 ||
            /[^!-~]/.test(input.token)
        )
            throw problem("Provide the destination bearer credential.");
        if (!["fhir", "openehr"].includes(input.standard)) throw problem("Choose FHIR or openEHR.");
        for (const types of [input.resourceTypes, input.readResourceTypes || input.resourceTypes])
            if (
                !Array.isArray(types) ||
                !types.length ||
                types.length > 100 ||
                types.some((type) => !/^([A-Z][A-Za-z0-9]{1,63}|COMPOSITION)$/.test(type))
            )
                throw problem("Declare the destination resource scope.");
        if (input.standard === "openehr") {
            const o = input.openEhr;
            if (
                !o ||
                Object.keys(o).some(
                    (key) =>
                        ![
                            "templateIds",
                            "identifierIssuer",
                            "identifierType",
                            "versionType",
                            "versionKind",
                            "updateExisting",
                            "clientAssignedIdsQualified",
                            "targetNamespace",
                        ].includes(key),
                ) ||
                !Array.isArray(o.templateIds) ||
                !o.templateIds.length ||
                o.templateIds.length > 100 ||
                o.templateIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
                [o.identifierIssuer, o.identifierType, o.versionType, o.targetNamespace].some(
                    (value) => typeof value !== "string" || !value || value.length > 256 || /[\r\n\0]/.test(value),
                ) ||
                o.identifierType === o.versionType ||
                typeof o.updateExisting !== "boolean" ||
                typeof o.clientAssignedIdsQualified !== "boolean" ||
                !["integer", "utc-timestamp"].includes(o.versionKind || "integer")
            )
                throw problem("Declare exact template, business identity, source version and CDR namespace policies.");
            try {
                new URL(o.targetNamespace);
            } catch {
                throw problem("Use a stable URI identifying this CDR across all its connection profiles.");
            }
            if (input.resourceTypes.length !== 1 || input.resourceTypes[0] !== "COMPOSITION")
                throw problem("openEHR destinations accept COMPOSITION output.");
        } else if (input.openEhr) throw problem("openEHR policy cannot be applied to a FHIR destination.");
        const owner = this.processing.owner(session),
            before = input.id ? this.all(owner).find((item) => item.id === input.id) : null;
        const definition = {
            projectId: input.projectId,
            displayName: input.displayName,
            standard: input.standard,
            baseUrl: url.href.replace(/\/$/, ""),
            resourceTypes: input.resourceTypes,
            readResourceTypes: input.readResourceTypes || input.resourceTypes,
            openEhr: input.standard === "openehr" ? input.openEhr : null,
        };
        if (input.id && (!before || before.revision !== input.expectedRevision))
            throw problem("Reload this destination before rotating its credential.", 409);
        if (
            before &&
            JSON.stringify(Object.fromEntries(Object.keys(definition).map((key) => [key, before[key]]))) !==
                JSON.stringify(definition)
        )
            throw problem(
                "Create a new destination to change routing or write policy. Rotation preserves the existing destination identity.",
                409,
            );
        const result = this.processing.ticket(owner, "destination", {
            ...definition,
            id: input.id || "destination-" + randomBytes(24).toString("hex"),
            expectedRevision: before?.revision || 0,
            token: input.token,
            comment: input.comment,
            identityIssuer: session.reviewIdentity?.issuer || null,
        });
        return {
            ...result,
            summary: {
                ...definition,
                id: result.summary.id,
                credentialConfigured: true,
                credentialSha256: hash(input.token),
                comment: input.comment,
                clinicalModelApproval: "SEPARATE",
                sourceDatabaseAccess: "READ ONLY",
            },
        };
    }
    async commit(session, confirmation) {
        const value = this.processing.take(session, confirmation, "destination");
        await this.authorise(session, value.projectId);
        const owner = this.processing.owner(session),
            items = this.all(owner),
            before = items.find((item) => item.id === value.id);
        if ((before?.revision || 0) !== value.expectedRevision)
            throw problem("The destination changed; review it again.", 409);
        if (!before && items.length >= 128) throw problem("The private destination limit was reached.", 429);
        const { expectedRevision, comment, ...definition } = value;
        const next = {
            ...definition,
            revision: (before?.revision || 0) + 1,
            enabled: true,
            history: [
                ...(before?.history || []),
                {
                    at: new Date().toISOString(),
                    actor: owner,
                    comment,
                    configurationSha256: hash(JSON.stringify(definition)),
                },
            ].slice(-256),
        };
        this.vault().set(owner, "destinations", [...items.filter((item) => item.id !== next.id), next]);
        return this.visible(next);
    }
    async setEnabled(session, input) {
        await this.authorise(session, input.projectId);
        if (typeof input.enabled !== "boolean" || typeof input.comment !== "string" || input.comment.trim().length < 8)
            throw problem("Review the destination state change and supply a reason.");
        const owner = this.processing.owner(session),
            items = this.all(owner),
            item = items.find((item) => item.id === input.id && item.projectId === input.projectId);
        if (!item || item.revision !== input.expectedRevision)
            throw problem("Reload the destination before changing its state.", 409);
        item.enabled = input.enabled;
        item.revision++;
        item.history = [
            ...(item.history || []),
            { at: new Date().toISOString(), actor: owner, comment: input.comment, enabled: input.enabled },
        ].slice(-256);
        this.vault().set(owner, "destinations", items);
        return this.visible(item);
    }
    connections(owner, project) {
        return this.all(owner)
            .filter(
                (item) =>
                    item.enabled &&
                    (!project || item.projectId === project) &&
                    (!this.canOperateOwner || this.canOperateOwner(owner, item.identityIssuer)),
            )
            .map((item) => {
                const directory = join(this.temporary, owner);
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                const file = join(directory, item.id + ".token");
                if (!existsSync(file) || readFileSync(file, "utf8") !== item.token)
                    writeFileSync(file, item.token, { mode: 0o600 });
                return {
                    id: item.id,
                    displayName: item.displayName,
                    baseUrl: item.baseUrl,
                    standard: item.standard,
                    openEhr: item.openEhr,
                    resourceTypes: item.resourceTypes,
                    readResourceTypes: item.readResourceTypes,
                    tokenFile: file,
                    owners: [owner],
                    projects: [item.projectId],
                    managed: true,
                };
            });
    }
    close() {
        rmSync(this.temporary, { recursive: true, force: true });
    }
}
