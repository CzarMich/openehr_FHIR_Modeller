import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { ProviderStore } from "./provider-store.mjs";
import { artifactKind } from "./repository-paths.mjs";
import { problem } from "./personal-http.mjs";

const hash = (content) => createHash("sha256").update(content).digest("hex");
const canonical = (value) =>
    Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map((key) => [key, canonical(value[key])]),
            )
          : value;
const gitBlobs = (content) =>
    Object.fromEntries(
        ["sha1", "sha256"].map((algorithm) => [
            algorithm,
            createHash(algorithm)
                .update("blob " + Buffer.byteLength(content) + "\0" + content)
                .digest("hex"),
        ]),
    );
export const isTemplate = (path) => ["oet", "adlTemplates"].includes(artifactKind(path));
export const modelResult = (result) => {
    let value = result?.structuredContent;
    if (!value) {
        try {
            value = JSON.parse(result?.content?.find((item) => item.type === "text")?.text);
        } catch {
            return null;
        }
    }
    if (result?.isError || value?.success === false) return null;
    return value?.result || value;
};

function dependencies(value) {
    if (!Array.isArray(value) || !value.length || value.length > 64)
        throw problem(
            "Include the exact archetypes used by this template (up to 64 dependencies). Rebuild it with template_build_oet or supply dependencies with identifier and content.",
        );
    const seen = new Set();
    const result = value.map((item) => {
        if (
            !item ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,199}$/.test(item.identifier || "") ||
            typeof item.content !== "string" ||
            !item.content.trim() ||
            item.content.includes("\0") ||
            Buffer.byteLength(item.content) > 1024 * 1024 ||
            seen.has(item.identifier)
        )
            throw problem(
                "Template dependencies must have unique archetype identifiers and bounded, non-empty ADL content.",
            );
        seen.add(item.identifier);
        const sha256 = hash(item.content);
        if (item.sha256 && item.sha256 !== sha256)
            throw problem("An archetype's contents no longer match its source hash.");
        return { identifier: item.identifier, content: item.content, sha256 };
    });
    if (Buffer.byteLength(JSON.stringify(result)) > 6 * 1024 * 1024)
        throw problem("The template dependency package is too large.", 413);
    return result.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

// Retain exact build inputs across browser turns without putting source documents
// into chat history or sharing them with another profile/conversation.
export class TemplatePackages {
    static prune(config) {
        const directory = join(config.dataDir, "template-packages");
        let names;
        try {
            names = readdirSync(directory);
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const name of names) {
            if (!/^[a-f0-9]{64}-packages\.json$/.test(name)) continue;
            const path = join(directory, name);
            if (statSync(path).mtimeMs < Date.now() - (config.retentionDays || 30) * 86400000) unlinkSync(path);
        }
    }
    constructor(config, identity, conversation, archive = null) {
        this.archive = archive;
        this.identity = identity + "\0" + conversation;
        this.store = config?.providerEncryptionKey
            ? new ProviderStore(join(config.dataDir, "template-packages"), config.providerEncryptionKey, ["packages"])
            : null;
        this.memory = [];
        this.ttl = (config?.retentionDays || 30) * 86400000;
    }
    entries() {
        return (this.store?.get(this.identity, "packages")?.credential || this.memory).filter(
            (entry) => entry.expires > Date.now(),
        );
    }
    delete() {
        this.store?.delete(this.identity, "packages");
        this.memory = [];
    }
    entry(content) {
        return (
            this.entries().find((item) => item.hash === hash(content)) || this.archive?.get(hash(content), "package")
        );
    }
    capture(name, args, response) {
        const result = modelResult(response);
        if (!result) return;
        const generated = name === "template_build_oet";
        if (!generated && !["template_compile", "template_validate"].includes(name)) return;
        const content = generated ? result.content : args.content;
        const inputs = generated ? result.dependencies : args.dependencies;
        if (typeof content !== "string" || !inputs?.length) return;
        const exact = dependencies(inputs);
        const retained = !generated && this.entry(content);
        const previous = retained && JSON.stringify(retained.dependencies) === JSON.stringify(exact) ? retained : null;
        const entry = {
            ...(previous || {}),
            hash: hash(content),
            dependencies: exact,
            ...(generated && result.provenance ? { provenance: result.provenance } : {}),
            ...(generated && result.ckmUpgrades ? { ckmUpgrades: result.ckmUpgrades } : {}),
            expires: Date.now() + this.ttl,
        };
        const entries = [entry, ...this.entries().filter((item) => item.hash !== entry.hash)].slice(0, 16);
        this.archive?.put(entry.hash, entry, "package");
        while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > 16 * 1024 * 1024) entries.pop();
        if (this.store) this.store.set(this.identity, "packages", entries);
        else this.memory = entries;
    }
    async files(args, folder, mcp, currentArchetypes) {
        const cached = this.entry(args.content);
        let inputs = dependencies(args.dependencies || cached?.dependencies);
        const current = currentArchetypes ? await currentArchetypes(inputs.map((item) => item.identifier)) : new Map();
        const provenance = { ...cached?.provenance };
        inputs = inputs.map((input) => {
            const saved = current.get(input.identifier);
            const upgrade = cached?.ckmUpgrades?.find((item) => item.identifier === input.identifier);
            if (upgrade) {
                if (
                    !cached.dependencies.some(
                        (item) => item.identifier === input.identifier && item.sha256 === input.sha256,
                    )
                )
                    throw problem(
                        "CKM upgrade dependencies differ from the verified build inputs. Build the upgrade again before saving.",
                        409,
                    );
                if ((saved?.sha256 || null) !== upgrade.previousSha256 && saved?.sha256 !== input.sha256)
                    throw problem(
                        "A repository archetype changed after the CKM upgrade was built. Review the latest source before upgrading. No files were saved.",
                        409,
                    );
                return input;
            }
            if (!saved) return input;
            // Existing designer edits are authoritative, even for a recovered draft.
            // Compile the draft again against these exact current bytes below.
            // Preserve unchanged provenance so identical saves remain idempotent.
            if (saved.sha256 !== input.sha256)
                provenance[input.identifier] = {
                    kind: "personal_repository",
                    repository: args.repository,
                    path: saved.path,
                    sha256: saved.sha256,
                };
            return { identifier: input.identifier, content: saved.content, sha256: saved.sha256 };
        });
        inputs = dependencies(inputs);
        const report = modelResult(
            await mcp.call("template_compile", {
                content: args.content,
                dependencies: inputs.map(({ identifier, content }) => ({ identifier, content })),
            }),
        );
        if (
            report?.valid !== true ||
            !report.output?.sha256 ||
            report.dependencies?.length !== inputs.length ||
            inputs.some(
                (item) =>
                    !report.dependencies.some(
                        (checked) => checked.identifier === item.identifier && checked.sha256 === item.sha256,
                    ),
            )
        )
            throw problem(
                "The template package could not be compiled with these exact archetypes. Resolve missing dependencies or validation findings with template_compile before saving. No files were saved.",
            );
        const prefix = folder ? folder + "/" : "";
        const relative = args.path.slice(prefix.length);
        const sources = inputs.map((item) => ({
            path: current.get(item.identifier)?.path || prefix + "archetypes/" + item.identifier + ".adl",
            content: item.content,
            dependency: true,
            expectedRevision: current.get(item.identifier)?.revision || null,
        }));
        const generated = [];
        // Stable current paths; Git preserves earlier bytes and the package pins
        // immutable dependency blobs even when another template updates an ADL.
        for (const [kind, output] of [
            ["opt", report.output],
            ["web_template", report.web_template],
        ]) {
            if (typeof output?.content !== "string") continue;
            if (hash(output.content) !== output.sha256)
                throw problem("A generated template output failed its integrity check.");
            const name = relative.replace(/^templates\/(?:oet|adl)\//, "").replace(/\.(?:oet(?:\.xml)?|adlt)$/i, "");
            const target =
                kind === "opt"
                    ? "templates/opt/" + name + ".opt"
                    : "data/json/web-templates/" + name + ".webtemplate.json";
            generated.push({ kind, path: target, content: output.content, sha256: output.sha256 });
        }
        const manifest = {
            schema: "openehr-template-package/2",
            versioning: "git-history-stable-paths",
            status: "DRAFT",
            clinicalApproval: false,
            template: { path: relative, sha256: hash(args.content) },
            archetypes: inputs.map((item) => ({
                identifier: item.identifier,
                path:
                    current.get(item.identifier)?.path.slice(prefix.length) || "archetypes/" + item.identifier + ".adl",
                sha256: item.sha256,
                git_blob: gitBlobs(item.content),
                ...(provenance[item.identifier]?.sha256 === item.sha256
                    ? { provenance: provenance[item.identifier] }
                    : {}),
            })),
            generated: generated.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
            compilation: {
                profile: report.profile,
                outputSha256: report.output.sha256,
                checks: report.checks,
                limitations: report.limitations,
            },
        };
        return [
            { path: args.path, content: args.content, expectedRevision: args.expectedRevision },
            ...sources,
            ...generated.map((item) => ({ path: prefix + item.path, content: item.content })),
            {
                path:
                    prefix +
                    "data/json/template-packages/" +
                    relative.replace(/^templates\/(?:oet|adl)\//, "") +
                    ".json",
                content: JSON.stringify(canonical(manifest), null, 2) + "\n",
            },
        ];
    }
}
