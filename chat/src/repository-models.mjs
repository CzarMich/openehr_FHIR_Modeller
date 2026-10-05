import { createHash } from "node:crypto";
import { problem } from "./personal-http.mjs";
import { ProjectMoves } from "./project-moves.mjs";
import { modelResult } from "./template-packages.mjs";
import { ModelCache } from "./model-cache.mjs";

const revision = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const modelFile = /\.(opt(?:\.xml)?|oet(?:\.xml)?|adlt|adl|adls|adlf|xml)$/i;
const templateFile = /\.(oet(?:\.xml)?|adlt)$/i;
const archetypeFile = /\.(adl|adls|adlf)$/i;

// Read-only model packages are pinned to one Git commit. Never mix a listed
// template with dependencies fetched from the moving branch head.
export class RepositoryModels {
    constructor(connections, identity, signal) {
        this.connections = connections;
        this.identity = identity;
        this.signal = signal;
        this.git = new ProjectMoves(null, connections, false, signal);
        this.trees = new Map();
        this.files = new Map();
        this.cachedBytes = 0;
        this.cache = new ModelCache(connections.config);
        this.authorised = new Map();
        this.cacheHits = 0;
    }
    async authorise(repo) {
        // Recheck upstream access once per operation, including immutable cache
        // hits. A removed connection or revoked token must not unlock old sources.
        this.connections.get(this.identity, repo.id);
        if (!this.authorised.has(repo.id))
            this.authorised.set(
                repo.id,
                this.retry(() => this.git.head(repo)),
            );
        return this.authorised.get(repo.id);
    }
    async retry(read) {
        try {
            this.signal?.throwIfAborted();
            return await read();
        } catch (error) {
            // One retry for interrupted reads only; no writes enter this class.
            if (error.status !== 503 || this.signal?.aborted) throw error;
            return read();
        }
    }
    async source(args) {
        const repo = this.connections.get(this.identity, args.repository);
        if (repo.kind === "ckm") throw problem("Choose a Git repository.");
        if (args.ref !== undefined && !revision(args.ref))
            throw problem("Reload the source to choose an exact revision.");
        const head = await this.authorise(repo);
        return { repo, ref: args.ref || head };
    }
    async tree(repo, ref) {
        const key = repo.id + ":" + ref;
        await this.authorise(repo);
        if (!this.trees.has(key))
            this.trees.set(
                key,
                this.cached(repo, ref, "tree", "", () => this.readTree(repo, ref)),
            );
        return this.trees.get(key);
    }
    async cached(repo, ref, kind, path, read) {
        this.signal?.throwIfAborted();
        const key = this.cache.key(this.identity, repo, ref, kind, path);
        const hit = this.cache.get(key);
        if (hit !== null) {
            this.cacheHits++;
            return hit;
        }
        const value = await read();
        this.signal?.throwIfAborted();
        this.cache.set(key, value);
        return value;
    }
    async readTree(repo, ref) {
        if (repo.kind === "github") {
            const data = await this.retry(() => this.git.remote(repo, "/git/trees/" + ref + "?recursive=1"));
            if (!Array.isArray(data.tree) || data.truncated)
                throw problem(
                    "This repository is too large to list completely. Load the template and archetype files from your computer.",
                    413,
                );
            return data.tree;
        }
        const rows = [];
        for (let page = 1; page <= 50; page++) {
            const data = await this.retry(() =>
                this.git.remote(repo, "/repository/tree?recursive=true&per_page=100&ref=" + ref + "&page=" + page),
            );
            if (!Array.isArray(data)) throw problem("Invalid repository listing.", 503);
            rows.push(...data);
            if (data.length < 100) return rows;
        }
        throw problem("This repository is too large to list completely. Load model files from your computer.", 413);
    }
    async list(args) {
        const { repo, ref } = await this.source(args);
        const rows = await this.tree(repo, ref);
        const items = rows
            .filter((item) => item.type === "blob" && modelFile.test(item.path))
            .map((item) => ({ path: item.path, type: "blob", revision: item.sha || item.id, ref }))
            .sort(
                (a, b) =>
                    Number(archetypeFile.test(a.path)) - Number(archetypeFile.test(b.path)) ||
                    a.path.localeCompare(b.path),
            );
        if (items.length > 5000)
            throw problem("Too many model files. Load the required files from your computer.", 413);
        return { items, ref, windowed: false };
    }
    async read(args, ref) {
        const repo = this.connections.get(this.identity, args.repository);
        await this.authorise(repo);
        const key = JSON.stringify([args.repository, ref, args.path]);
        if (this.files.has(key)) return this.files.get(key);
        const file = await this.cached(repo, ref, "file", args.path, () => this.readFile(args, ref));
        const bytes = Buffer.byteLength(file.content || "");
        if (this.files.size < 130 && this.cachedBytes + bytes <= 8 * 1024 * 1024) {
            this.files.set(key, file);
            this.cachedBytes += bytes;
        }
        return file;
    }
    async readFile(args, ref) {
        const repo = this.connections.get(this.identity, args.repository);
        if (repo.kind !== "github")
            return this.retry(() => this.connections.readRepository(this.identity, args, this.signal, ref));
        const path = this.connections.validatePath(args.path);
        const entry = (await this.tree(repo, ref)).find((item) => item.path === path);
        const repository = { id: repo.id, kind: repo.kind, label: repo.label, url: repo.url, branch: repo.branch };
        if (!entry) return { exists: false, revision: null, path, repository };
        if (
            entry.type !== "blob" ||
            (entry.mode && !["100644", "100755"].includes(entry.mode)) ||
            !revision(entry.sha) ||
            entry.size > 2097152
        )
            throw problem("The selected repository model is not a regular file or exceeds 2 MiB.", 413);
        const content = await this.readBlob(repo, entry.sha);
        return { exists: true, revision: entry.sha, path, repository, content };
    }
    async readBlob(repo, objectId) {
        if (!revision(objectId)) throw problem("Invalid archetype Git object.", 409);
        await this.authorise(repo);
        return this.cached(repo, objectId, "blob", "", async () => {
            const response = await this.retry(() =>
                this.connections.remote(
                    this.connections.repoApi(repo),
                    repo.kind === "github" ? "/git/blobs/" + objectId : "/repository/blobs/" + objectId + "/raw",
                    {
                        signal: this.signal,
                        accept: repo.kind === "github" ? "application/vnd.github.raw+json" : "text/plain",
                        timeoutMs: 45000,
                    },
                ),
            );
            if (response.status !== 200) throw problem("The model blob is unavailable at this revision.", 404);
            const content = response.text;
            if (Buffer.byteLength(content) > 2097152) throw problem("The repository model exceeds 2 MiB.", 413);
            const actual = createHash(objectId.length === 40 ? "sha1" : "sha256")
                .update("blob " + Buffer.byteLength(content) + "\0" + content)
                .digest("hex");
            if (actual !== objectId)
                throw problem("The downloaded model did not match its Git revision. Reload the source and retry.", 503);
            return content;
        });
    }
    // Current authoring sources are separate from historical manifest pins.
    // One operation uses one immutable branch snapshot; caches are revision keyed.
    async currentArchetypes(repository, folder, identifiers) {
        const { repo, ref } = await this.source({ repository });
        const rows = await this.tree(repo, ref);
        const prefix = (folder ? folder + "/" : "") + "archetypes/";
        const found = new Map();
        for (const identifier of new Set(identifiers)) {
            if (!/^openEHR-[A-Z_]+-[A-Z_]+\.[A-Za-z0-9_.-]+\.v[0-9]+(?:\.[0-9]+)*$/.test(identifier))
                throw problem("Use full openEHR archetype identifiers when building from a personal repository.");
            const matches = rows.filter(
                (item) =>
                    item.type === "blob" &&
                    item.path.startsWith(prefix) &&
                    item.path.slice(item.path.lastIndexOf("/") + 1) === identifier + ".adl",
            );
            if (matches.length > 1)
                throw problem(
                    "Multiple repository copies of " +
                        identifier +
                        " exist in this project. Resolve the duplicate sources before building.",
                    409,
                );
            if (!matches.length) continue;
            const file = await this.get({ repository, path: matches[0].path, ref });
            found.set(identifier, {
                identifier,
                content: file.content,
                sha256: file.sha256,
                path: file.path,
                revision: file.revision,
                ref,
            });
        }
        return found;
    }
    async history(args) {
        const { repo, ref } = await this.source(args);
        const path = this.connections.validatePath(args.path);
        const versions = await this.cached(repo, ref, "history", path, async () => {
            const query = new URLSearchParams({
                path,
                per_page: "20",
                [repo.kind === "github" ? "sha" : "ref_name"]: ref,
            });
            const rows = await this.retry(() =>
                this.git.remote(repo, (repo.kind === "github" ? "/commits?" : "/repository/commits?") + query),
            );
            if (!Array.isArray(rows) || rows.length > 20) throw problem("Invalid repository version history.", 503);
            return rows.map((row) => {
                const commit = repo.kind === "github" ? row.sha : row.id;
                if (!revision(commit)) throw problem("Invalid repository version history.", 503);
                return {
                    commit,
                    message: String(row.commit?.message || row.message || "").slice(0, 200),
                    date: String(row.commit?.committer?.date || row.committed_date || "").slice(0, 40),
                };
            });
        });
        return { path, ref, versions, windowed: versions.length === 20 };
    }
    async get(args) {
        const { ref } = await this.source(args);
        const file = await this.read(args, ref);
        return { ...file, ref, ...(file.exists ? { sha256: digest(file.content) } : {}) };
    }
    async package(args) {
        const { repo, ref } = await this.source(args);
        const primary = await this.read(args, ref);
        if (!primary.exists)
            throw problem("The selected model does not exist at this revision. Reload the source.", 404);
        const result = { ...primary, ref, dependencies: [], dependencySource: "none" };
        if (!templateFile.test(args.path)) return result;
        const location = args.path.match(/^(.*?)(?:templates\/(?:oet|adl)\/)(.+)$/);
        if (!location) return result;
        const folder = location[1];
        const manifestPath = folder + "data/json/template-packages/" + location[2] + ".json";
        const saved = await this.read({ repository: repo.id, path: manifestPath }, ref);
        let dependencies, manifestRevision;
        if (saved.exists) {
            let manifest;
            try {
                manifest = JSON.parse(saved.content);
            } catch {
                throw problem("The template package manifest is not valid JSON. Save the template package again.", 409);
            }
            if (
                !["openehr-template-package/1", "openehr-template-package/2"].includes(manifest?.schema) ||
                manifest.template?.path !== args.path.slice(folder.length) ||
                manifest.template.sha256 !== digest(primary.content) ||
                !Array.isArray(manifest.archetypes)
            )
                throw problem(
                    "The template no longer matches its saved package. Save the template with its exact archetypes again.",
                    409,
                );
            dependencies = manifest.archetypes.map((dep) => {
                if (
                    !dep ||
                    typeof dep.identifier !== "string" ||
                    !/^openEHR-[A-Za-z0-9_.-]+$/.test(dep.identifier) ||
                    typeof dep.path !== "string" ||
                    !dep.path.startsWith("archetypes/") ||
                    !archetypeFile.test(dep.path) ||
                    typeof dep.sha256 !== "string" ||
                    !/^[a-f0-9]{64}$/.test(dep.sha256)
                )
                    throw problem("The template package contains an invalid archetype entry.", 409);
                if (
                    manifest.schema === "openehr-template-package/2" &&
                    (!dep.git_blob ||
                        !/^[a-f0-9]{40}$/.test(dep.git_blob.sha1 || "") ||
                        !/^[a-f0-9]{64}$/.test(dep.git_blob.sha256 || ""))
                )
                    throw problem("The template package contains an invalid archetype version.", 409);
                return {
                    ...dep,
                    git_blob: manifest.schema === "openehr-template-package/2" ? dep.git_blob : undefined,
                    path: this.connections.validatePath(folder + dep.path),
                };
            });
            result.dependencySource = "verified_manifest";
        } else {
            // Older projects have no manifest. Use only their own archetype
            // folder; compilation still checks the complete dependency closure.
            dependencies = (await this.tree(repo, ref))
                .filter(
                    (item) =>
                        item.type === "blob" &&
                        item.path.startsWith(folder + "archetypes/") &&
                        archetypeFile.test(item.path),
                )
                .map((item) => ({
                    path: item.path,
                    identifier: item.path.split("/").at(-1).replace(archetypeFile, ""),
                }));
            result.dependencySource = "project_folder";
        }
        if (dependencies.length > 64)
            throw problem(
                "This template has more than 64 candidate archetypes. Save an exact template package or load the required model files locally.",
                413,
            );
        if (
            new Set(dependencies.map((dep) => dep.identifier)).size !== dependencies.length ||
            new Set(dependencies.map((dep) => dep.path)).size !== dependencies.length
        )
            throw problem("The template package contains duplicate archetypes.", 409);
        let bytes = Buffer.byteLength(primary.content);
        // Keep repository request pressure bounded; a second read can progress
        // while a large archetype is downloading.
        for (let i = 0; i < dependencies.length; i += 2) {
            const loaded = await Promise.all(
                dependencies.slice(i, i + 2).map(async (dep) => {
                    const blob = dep.git_blob?.[ref.length === 40 ? "sha1" : "sha256"];
                    let file = blob
                        ? { exists: true, content: await this.readBlob(repo, blob), revision: blob }
                        : await this.read({ repository: repo.id, path: dep.path }, ref);
                    // Legacy manifests predate blob pins. Recover only from the exact
                    // commit that wrote their bytes, never from a guessed CKM version.
                    if (!blob && dep.sha256 && (!file.exists || digest(file.content) !== dep.sha256)) {
                        manifestRevision ||= (async () => {
                            const history = await this.history({ repository: repo.id, path: manifestPath, ref });
                            const originalRef = history.versions[0]?.commit;
                            if (!originalRef)
                                throw problem("The archetype package has no recoverable version history.", 409);
                            const original = await this.read({ repository: repo.id, path: manifestPath }, originalRef);
                            if (!original.exists || original.content !== saved.content)
                                throw problem("The archetype package history does not match its manifest.", 409);
                            return originalRef;
                        })();
                        file = await this.read({ repository: repo.id, path: dep.path }, await manifestRevision);
                    }
                    if (!file.exists)
                        throw problem(
                            "A required archetype is missing: " +
                                dep.path +
                                ". Save the complete template package again.",
                            409,
                        );
                    if (dep.sha256 && dep.sha256 !== digest(file.content))
                        throw problem(
                            "An archetype no longer matches the saved template package: " +
                                dep.path +
                                ". Save the complete package again.",
                            409,
                        );
                    bytes += Buffer.byteLength(file.content);
                    if (bytes > 6 * 1024 * 1024)
                        throw problem("The template package exceeds the 6 MiB inspection limit.", 413);
                    return {
                        identifier: dep.identifier,
                        content: file.content,
                        path: dep.path,
                        sha256: digest(file.content),
                        ...(blob ? { git_blob: blob } : {}),
                    };
                }),
            );
            result.dependencies.push(...loaded);
        }
        return result;
    }
    async aql(args, mcp) {
        if (!["inspect", "generate", "validate"].includes(args.action))
            throw problem("Choose inspect, generate or validate.");
        if (args.action !== "inspect" && !revision(args.ref))
            throw problem("Inspect the model first and use its exact commit for the query.");
        if (
            args.paths !== undefined &&
            (!Array.isArray(args.paths) ||
                args.paths.length > 30 ||
                args.paths.some((path) => typeof path !== "string" || path.length > 2048))
        )
            throw problem("Choose up to 30 inspected paths.");
        if (args.filter !== undefined && (typeof args.filter !== "string" || args.filter.length > 200))
            throw problem("Use a short path filter.");
        if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > 20000))
            throw problem("Use a valid path offset.");
        if (
            args.action === "validate" &&
            (typeof args.query !== "string" || !args.query.trim() || args.query.length > 65536)
        )
            throw problem("Supply the AQL query to check.");
        const source = await this.package(args);
        const provenance = {
            repository: args.repository,
            path: args.path,
            ref: source.ref,
            source_sha256: digest(source.content),
            dependencySource: source.dependencySource,
            archetypes: source.dependencies.map(({ content, ...dep }) => dep),
        };
        const invoke = async (name, input) => {
            const result = modelResult(await mcp.call(name, input));
            if (!result)
                throw problem(
                    "The model service could not complete " + name + ". Check the model and its dependencies.",
                    422,
                );
            return result;
        };
        let content = source.content;
        let format = /^\s*(?:<\?xml[^>]*>\s*)?</.test(content)
            ? "opt14"
            : /^\s*operational_template\b/i.test(content)
              ? "opt2"
              : "adl2";
        if (templateFile.test(args.path) || /^\s*template\b/i.test(content)) {
            const compiled = await invoke("template_compile", {
                content,
                dependencies: source.dependencies.map(({ identifier, content }) => ({ identifier, content })),
            });
            if (!compiled.valid || !compiled.output) return { ...provenance, valid: false, compilation: compiled };
            content = compiled.output.content;
            format = compiled.output.format === "opt14_xml" ? "opt14" : "opt2";
        }
        if (args.action === "validate") {
            if (format === "adl2") throw problem("Select a template or compiled OPT to verify query paths.");
            return {
                ...provenance,
                validation: await invoke("aql_validate", {
                    content: args.query,
                    templates: [{ identifier: "selected_template", content }],
                }),
            };
        }
        const result = await invoke(args.action === "generate" ? "model_generate_aql" : "model_inspect", {
            content,
            format,
            ...(args.action === "generate" ? { paths: args.paths || [] } : {}),
        });
        if (args.action === "generate") {
            const { inspection, source_sha256: modelHash, ...draft } = result;
            return { ...provenance, ...draft, model_sha256: modelHash };
        }
        const allPaths = result.inspection?.paths || [];
        const paths = allPaths.filter(
            (path) => !args.filter || JSON.stringify(path).toLowerCase().includes(args.filter.toLowerCase()),
        );
        const offset = args.offset || 0;
        return {
            ...provenance,
            valid: result.valid,
            identifier: result.identifier,
            format,
            model_sha256: result.content_sha256,
            findings: result.findings,
            paths: paths.slice(offset, offset + 100),
            totalPaths: paths.length,
            nextOffset: offset + 100 < paths.length ? offset + 100 : null,
        };
    }
}
