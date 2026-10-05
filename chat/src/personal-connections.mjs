import { GLOBAL_IDENTITY } from "./access.mjs";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { ProviderStore } from "./provider-store.mjs";
import { httpsUrl, personalRequest, problem } from "./personal-http.mjs";
import { artifactKind } from "./repository-paths.mjs";
import { ProjectMoves } from "./project-moves.mjs";

const canonical = (value) => {
    const url = httpsUrl(value);
    return url.origin + url.pathname.replace(/\/+$/, "");
};
const visible = ({ token, ...connection }) => ({ ...connection, authenticated: !!token });

function githubFailure(response, writing) {
    let message = "";
    try {
        message = String(JSON.parse(response.text).message || "").slice(0, 2000);
    } catch {}
    if (response.status === 401)
        return Object.assign(
            problem(
                "GitHub rejected the saved token. Open Settings → My sources and repositories → Update access, enter a valid token and press Save connection.",
                403,
            ),
            { accessCode: "GITHUB_TOKEN_INVALID" },
        );
    if (response.status === 429 || (response.status === 403 && /rate limit|secondary rate/i.test(message)))
        return problem(
            "GitHub temporarily limited requests. Wait a few minutes, then retry; changing the repository or token is unnecessary.",
            429,
        );
    if (
        writing &&
        response.status === 403 &&
        /resource not accessible by (?:personal access token|integration)/i.test(message)
    )
        return Object.assign(
            problem(
                "GitHub refused this token's permission to save files. In GitHub token settings, select this repository and grant Contents: Read and write. Then open Settings → My sources and repositories → Update access and press Save connection (enter the new token only if you replaced it).",
                403,
            ),
            { accessCode: "GITHUB_CONTENTS_WRITE_REQUIRED" },
        );
    if (
        writing &&
        [403, 409, 422].includes(response.status) &&
        /protected branch|branch protection|repository rule|pull request|GH006|GH013/i.test(message)
    )
        return Object.assign(
            problem(
                "GitHub requires changes through a permitted branch or pull request. Connect an allowed draft branch in Settings, select it as the save destination, then retry.",
                403,
            ),
            { accessCode: "GITHUB_BRANCH_RESTRICTED" },
        );
    return null;
}

export function unpack(result) {
    if (result?.isError || result?.structuredContent?.success === false)
        throw problem("The modelling service could not list enterprise connections.", 503);
    let data = result.structuredContent;
    if (!data) {
        try {
            data = JSON.parse(result.content.find((item) => item.type === "text").text);
        } catch {
            throw problem("The modelling service could not list enterprise connections.", 503);
        }
    }
    return data.result || data;
}

export class PersonalConnections {
    constructor(config, { request = personalRequest, store } = {}) {
        this.config = config;
        this.request = request;
        this.store =
            store ||
            (config.providerEncryptionKey
                ? new ProviderStore(join(config.dataDir, "connections"), config.providerEncryptionKey, ["workspace"])
                : null);
    }
    all(identity) {
        return this.store?.get(identity, "workspace")?.credential || [];
    }
    list(identity) {
        return [
            ...this.all(identity).map(visible),
            ...(identity !== GLOBAL_IDENTITY && this.canUseGlobal?.(identity)
                ? this.all(GLOBAL_IDENTITY).map((item) => ({ ...visible(item), scope: "global" }))
                : []),
        ];
    }
    get(identity, id, kind) {
        let item = this.all(identity).find((c) => c.id === id && (!kind || c.kind === kind));
        if (!item && identity !== GLOBAL_IDENTITY && this.canUseGlobal?.(identity)) {
            const shared = this.all(GLOBAL_IDENTITY).find((c) => c.id === id && (!kind || c.kind === kind));
            if (shared) item = { ...shared, scope: "global" };
        }
        if (!item) throw problem("Personal connection not found.", 404);
        return item;
    }
    async enterprise(mcp) {
        const data = unpack(await mcp.call("ckm_sources", {}));
        if (!data.sources || typeof data.sources !== "object" || Array.isArray(data.sources))
            throw problem("The enterprise CKM list is unavailable.", 503);
        return Object.entries(data.sources).map(([id, url]) => ({
            id,
            label: id,
            url,
            kind: "ckm",
            scope: "enterprise",
        }));
    }
    add(identity, input, enterprise = []) {
        if (!this.store) throw problem("Personal connections are not configured.", 503);
        if (
            !["ckm", "github", "gitlab"].includes(input.kind) ||
            typeof input.label !== "string" ||
            !input.label.trim() ||
            input.label.length > 80 ||
            typeof input.url !== "string" ||
            (input.token !== undefined &&
                (typeof input.token !== "string" || !/^[\x21-\x7e]{1,2000}$/.test(input.token)))
        )
            throw problem("Enter a name, a supported connection type and a valid access token if needed.");
        let url = canonical(input.url);
        const items = this.all(identity);
        if (input.kind === "ckm") {
            const existing = enterprise.find((item) => canonical(item.url) === url);
            if (existing) return { connection: existing, duplicate: true };
        } else {
            const parsed = new URL(url);
            if (input.kind === "github" && parsed.hostname !== "github.com")
                throw problem("Use a github.com repository URL.");
            const path = parsed.pathname.replace(/\.git$/, "");
            if (
                !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) ||
                path.split("/").some((p) => p === "." || p === "..") ||
                (input.kind === "github" && path.split("/").length !== 3)
            )
                throw problem("Enter the repository URL, without a branch or file path.");
            url = parsed.origin + path;
            if (
                typeof input.branch !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch) ||
                /\.\.|\/\/|\/$|\.lock$/.test(input.branch)
            )
                throw problem("Enter a valid target branch.");
        }
        const duplicate = items.find(
            (item) => item.kind === input.kind && item.url === url && (item.branch || "") === (input.branch || ""),
        );
        if (duplicate) {
            if (input.kind !== "ckm" && (input.token !== undefined || duplicate.lastWriteError)) {
                if (input.token !== undefined) duplicate.token = input.token;
                duplicate.label = input.label.trim();
                delete duplicate.lastWriteError;
                this.store.set(identity, "workspace", items);
                return { connection: visible(duplicate), duplicate: true, updated: true };
            }
            return { connection: visible(duplicate), duplicate: true };
        }
        if (items.length >= 20) throw problem("Remove an unused connection before adding another (limit 20).", 429);
        const connection = {
            id: randomUUID(),
            kind: input.kind,
            label: input.label.trim(),
            url,
            token: input.token || "",
            ...(input.kind !== "ckm" ? { branch: input.branch } : {}),
        };
        this.store.set(identity, "workspace", [...items, connection]);
        return { connection: visible(connection), duplicate: false };
    }
    remove(identity, id) {
        if (!this.all(identity).some((item) => item.id === id)) throw problem("Personal connection not found.", 404);
        this.store.set(
            identity,
            "workspace",
            this.all(identity).filter((item) => item.id !== id),
        );
    }
    async remote(connection, suffix, options = {}) {
        const response = await this.request(connection.url + suffix, {
            ...options,
            token: connection.token,
            allowedHosts: this.config.personalAllowedHosts || [],
        });
        if (![200, 201, 404].includes(response.status)) {
            if (connection.kind === "github") {
                const failure = githubFailure(response, !!options.method && options.method !== "GET");
                if (failure) throw failure;
            }
            throw problem(
                response.status === 409 || response.status === 422
                    ? "Repository changed. Read the current revision and retry."
                    : "The personal connection refused the request. Check the URL, branch and token permissions.",
                response.status === 409 || response.status === 422 ? 409 : 503,
            );
        }
        return response;
    }
    async ckm(identity, args, signal) {
        const source = this.get(identity, args.source, "ckm");
        if (!["archetypes", "templates"].includes(args.kind)) throw problem("Choose archetypes or templates.");
        let suffix = "/v1/" + args.kind;
        if (args.cid !== undefined) {
            if (typeof args.cid !== "string" || !/^\d+(?:\.\d+){1,5}$/.test(args.cid))
                throw problem("Use a CID returned by this CKM.");
            const format = args.kind === "archetypes" ? "adl" : "oet";
            suffix += "/" + args.cid + "/" + format;
        } else {
            if (typeof args.keyword !== "string" || !args.keyword.trim() || args.keyword.length > 200)
                throw problem("Enter a CKM search term.");
            suffix +=
                "?" +
                new URLSearchParams({
                    "search-text": args.keyword,
                    size: "20",
                    offset: "0",
                    "restrict-search-to-main-data": "true",
                    "require-all-search-words": "true",
                    "sort-key": "RELEVANCE",
                });
        }
        const result = await this.remote(source, suffix, { signal });
        if (result.status === 404) throw problem("CKM resource not found.", 404);
        let content = result.text;
        if (!args.cid) {
            try {
                content = JSON.parse(content);
            } catch {
                throw problem("Invalid CKM search response.", 503);
            }
            if (!Array.isArray(content)) throw problem("Invalid CKM search response.", 503);
            content = content.slice(0, 20);
        }
        return { source: visible(source), content, ...(args.cid ? {} : { limit: 20, windowed: true }) };
    }
    repoApi(repo) {
        const url = new URL(repo.url);
        return {
            ...repo,
            url:
                repo.kind === "github"
                    ? "https://api.github.com/repos" + url.pathname
                    : url.origin + "/api/v4/projects/" + encodeURIComponent(url.pathname.slice(1)),
        };
    }
    validatePath(path) {
        if (
            typeof path !== "string" ||
            path.length > 300 ||
            !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) ||
            path.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith("."))
        )
            throw problem("Use a relative artifact path without hidden directories or traversal.");
        if (!artifactKind(path)) throw problem("Choose a modelling artifact file extension.");
        return path;
    }
    async listRepository(identity, args, signal) {
        const repo = this.get(identity, args.repository);
        if (repo.kind === "ckm") throw problem("Choose a repository.");
        const suffix =
            repo.kind === "github"
                ? "/git/trees/" + encodeURIComponent(repo.branch) + "?recursive=1"
                : "/repository/tree?recursive=true&per_page=100&ref=" + encodeURIComponent(repo.branch);
        const response = await this.remote(this.repoApi(repo), suffix, { signal });
        if (response.status === 404) throw problem("Repository or branch not found.", 404);
        let data;
        try {
            data = JSON.parse(response.text);
        } catch {
            throw problem("Invalid repository response.", 503);
        }
        const rows = repo.kind === "github" ? data.tree : data;
        if (!Array.isArray(rows)) throw problem("Invalid repository response.", 503);
        return {
            repository: visible(repo),
            items: rows
                .slice(0, 100)
                .map((item) => ({ path: item.path, type: item.type, revision: item.sha || item.id })),
            windowed: repo.kind === "github" ? !!data.truncated || rows.length > 100 : rows.length === 100,
            limit: 100,
        };
    }
    async readRepository(identity, args, signal, ref) {
        const repo = this.get(identity, args.repository);
        if (repo.kind === "ckm") throw problem("Choose a repository.");
        const path = this.validatePath(args.path);
        const suffix =
            repo.kind === "github"
                ? "/contents/" +
                  path.split("/").map(encodeURIComponent).join("/") +
                  "?ref=" +
                  encodeURIComponent(ref || repo.branch)
                : "/repository/files/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(ref || repo.branch);
        const response = await this.remote(this.repoApi(repo), suffix, { signal });
        if (response.status === 404) return { exists: false, revision: null, path, repository: visible(repo) };
        let data;
        try {
            data = JSON.parse(response.text);
        } catch {
            throw problem("Invalid repository response.", 503);
        }
        // GitHub omits base64 bodies above 1 MiB. Read the exact verified blob
        // so a large compiled OPT can still advance at its existing filename.
        if (
            repo.kind === "github" &&
            data.type === "file" &&
            data.encoding === "none" &&
            /^[a-f0-9]{40}$/.test(data.sha || "")
        ) {
            const { RepositoryModels } = await import("./repository-models.mjs");
            const reader = new RepositoryModels(this, identity, signal);
            const content = await reader.readBlob(repo, data.sha);
            return { exists: true, revision: data.sha, path, content, repository: visible(repo) };
        }
        if (
            (data.type && data.type !== "file") ||
            data.encoding !== "base64" ||
            typeof data.content !== "string" ||
            data.size > 2 * 1024 * 1024
        )
            throw problem("The repository file is unavailable or too large.", 413);
        const revision = repo.kind === "github" ? data.sha : data.last_commit_id;
        if (typeof revision !== "string" || !/^[a-f0-9]{40,64}$/.test(revision))
            throw problem("Invalid repository revision.", 503);
        const content = Buffer.from(data.content, "base64").toString("utf8");
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw problem("The repository file exceeds 2 MiB.", 413);
        return {
            exists: true,
            revision,
            path,
            content,
            repository: visible(repo),
        };
    }
    async publish(identity, args, signal, plan = null) {
        if (!this.config.allowWrites) throw problem("Repository writes are disabled.", 403);
        const repo = this.get(identity, args.repository);
        try {
            return plan
                ? await this.publishBundle(identity, args, signal, repo, plan)
                : await this.publishFile(identity, args, signal, repo);
        } catch (error) {
            if (error.accessCode) {
                const owner = repo.scope === "global" ? GLOBAL_IDENTITY : identity;
                const items = this.all(owner),
                    current = items.find((item) => item.id === repo.id);
                // A response for an older token must not invalidate a newly updated connection.
                if (current?.token === repo.token) {
                    current.lastWriteError = {
                        code: error.accessCode,
                        message: error.message,
                        at: new Date().toISOString(),
                    };
                    this.store.set(owner, "workspace", items);
                }
            }
            throw error;
        }
    }
    async prepareBundle(identity, args, files, signal) {
        const repo = this.get(identity, args.repository);
        if (!this.config.allowWrites || repo.kind === "ckm" || !repo.token)
            throw problem("Choose a repository with a personal write token.", 403);
        if (
            !Array.isArray(files) ||
            files.length < 2 ||
            files.length > 68 ||
            typeof args.message !== "string" ||
            !args.message.trim() ||
            args.message.length > 200 ||
            new Set(files.map((file) => file.path)).size !== files.length
        )
            throw problem("Invalid template package or commit message.");
        const git = new ProjectMoves(null, this, true, signal);
        const base = await git.head(repo);
        const { RepositoryModels } = await import("./repository-models.mjs");
        const reader = new RepositoryModels(this, identity, signal);
        const verified = [];
        for (const file of files) {
            this.validatePath(file.path);
            if (
                typeof file.content !== "string" ||
                !file.content.trim() ||
                Buffer.byteLength(file.content) > 2 * 1024 * 1024
            )
                throw problem("A template package file is empty or too large.", 413);
            const current = await reader.get({ repository: repo.id, path: file.path, ref: base });
            if (Object.hasOwn(file, "expectedRevision") && current.revision !== file.expectedRevision)
                throw problem("Repository changed. Read the current template revision and retry.", 409);
            if (file.identicalOnly && current.exists && current.content !== file.content)
                throw problem(
                    "A dependency or compiled output with different contents already exists at " +
                        file.path +
                        ". Review that revision explicitly before replacing it or choose a different project folder. No files were saved.",
                    409,
                );
            verified.push({
                path: file.path,
                content: file.content,
                revision: current.revision,
                dependency: file.dependency === true || file.identicalOnly === true,
                changed: !current.exists || current.content !== file.content,
                change: !current.exists ? "created" : current.content === file.content ? "unchanged" : "updated",
                previousSha256: current.exists ? createHash("sha256").update(current.content).digest("hex") : null,
                sha256: createHash("sha256").update(file.content).digest("hex"),
            });
        }
        return {
            base,
            repository: repo.id,
            destination: { kind: repo.kind, url: repo.url, branch: repo.branch },
            files: verified,
        };
    }
    async publishBundle(identity, args, signal, repo, plan) {
        if (
            repo.kind === "ckm" ||
            !repo.token ||
            plan.repository !== repo.id ||
            Object.entries(plan.destination).some(([key, value]) => repo[key] !== value)
        )
            throw problem("The repository selection changed. Review the template package again.", 409);
        const git = new ProjectMoves(null, this, true, signal);
        if ((await git.head(repo)) !== plan.base)
            throw problem("Repository changed after the package was prepared. Review it again before saving.", 409);
        let commit = plan.base;
        const changed = plan.files.filter((file) => file.changed);
        if (changed.length && repo.kind === "github") {
            const previous = await git.remote(repo, "/git/commits/" + plan.base);
            if (!/^[a-f0-9]{40}$/.test(previous.tree?.sha || "")) throw problem("Invalid repository tree.", 503);
            const tree = await git.remote(repo, "/git/trees", {
                method: "POST",
                body: {
                    base_tree: previous.tree.sha,
                    tree: changed.map((file) => ({
                        path: file.path,
                        mode: "100644",
                        type: "blob",
                        content: file.content,
                    })),
                },
            });
            if (!/^[a-f0-9]{40}$/.test(tree.sha || "")) throw problem("Invalid repository tree.", 503);
            const created = await git.remote(repo, "/git/commits", {
                method: "POST",
                body: {
                    message: args.message,
                    tree: tree.sha,
                    parents: [plan.base],
                },
            });
            if (!/^[a-f0-9]{40}$/.test(created.sha || "")) throw problem("Invalid repository commit.", 503);
            const updated = await git.remote(
                repo,
                "/git/refs/heads/" + repo.branch.split("/").map(encodeURIComponent).join("/"),
                {
                    method: "PATCH",
                    body: { sha: created.sha, force: false },
                },
            );
            if (updated.object?.sha !== created.sha)
                throw problem(
                    "The repository did not confirm the package commit. Read the branch before retrying.",
                    503,
                );
            commit = created.sha;
        } else if (changed.length) {
            const created = await git.remote(repo, "/repository/commits", {
                method: "POST",
                body: {
                    branch: repo.branch,
                    start_sha: plan.base,
                    force: false,
                    commit_message: args.message,
                    // Include unchanged dependencies with revision guards as well, so
                    // a concurrent dependency edit cannot enter the compiled package.
                    actions: plan.files.map((file) => ({
                        action: file.revision ? "update" : "create",
                        file_path: file.path,
                        content: file.content,
                        ...(file.revision ? { last_commit_id: file.revision } : {}),
                    })),
                },
            });
            if (!/^[a-f0-9]{40,64}$/.test(created.id || "")) throw problem("Invalid repository commit.", 503);
            commit = created.id;
        }
        const url = (path, ref = repo.branch) =>
            repo.url +
            (repo.kind === "github" ? "/blob/" : "/-/blob/") +
            encodeURIComponent(ref) +
            "/" +
            path.split("/").map(encodeURIComponent).join("/");
        return {
            saved: true,
            repository: visible(repo),
            path: args.path,
            status: "DRAFT",
            clinicalApproval: false,
            commit,
            changed: changed.length > 0,
            sha256: plan.files.find((file) => file.path === args.path)?.sha256,
            change: plan.files.find((file) => file.path === args.path)?.change,
            url: url(args.path),
            files: plan.files.map(({ path, sha256, changed, dependency, change, previousSha256 }) => ({
                path,
                sha256,
                changed,
                dependency,
                change,
                previousSha256,
                previousCommit: previousSha256 ? plan.base : null,
                versionUrl: url(path, commit),
                url: url(path),
            })),
        };
    }
    async publishFile(identity, args, signal, repo) {
        if (repo.kind === "ckm" || !repo.token) throw problem("Choose a repository with a personal write token.");
        const path = this.validatePath(args.path);
        if (
            typeof args.content !== "string" ||
            !args.content.trim() ||
            Buffer.byteLength(args.content) > 2 * 1024 * 1024 ||
            !(
                args.expectedRevision === null ||
                (typeof args.expectedRevision === "string" && /^[a-f0-9]{40,64}$/.test(args.expectedRevision))
            ) ||
            typeof args.message !== "string" ||
            !args.message.trim() ||
            args.message.length > 200
        )
            throw problem(
                "Supply artifact content, a commit message and the exact previous revision (null for a new file).",
            );
        const current = await this.readRepository(identity, args, signal);
        if (current.revision !== args.expectedRevision)
            throw problem("Repository changed. Read the current revision and retry.", 409);
        const sha256 = createHash("sha256").update(args.content).digest("hex");
        const version = {
            sha256,
            previousSha256: current.exists ? createHash("sha256").update(current.content).digest("hex") : null,
            changed: !current.exists || current.content !== args.content,
            change: !current.exists ? "created" : current.content === args.content ? "unchanged" : "updated",
        };
        const url =
            repo.url +
            (repo.kind === "github" ? "/blob/" : "/-/blob/") +
            encodeURIComponent(repo.branch) +
            "/" +
            path.split("/").map(encodeURIComponent).join("/");
        if (!version.changed)
            return {
                saved: true,
                repository: visible(repo),
                path,
                status: "DRAFT",
                clinicalApproval: false,
                revision: current.revision,
                url,
                ...version,
            };
        let suffix, body, method;
        if (repo.kind === "github") {
            suffix = "/contents/" + path.split("/").map(encodeURIComponent).join("/");
            method = "PUT";
            body = {
                branch: repo.branch,
                message: args.message,
                content: Buffer.from(args.content).toString("base64"),
                ...(current.exists ? { sha: current.revision } : {}),
            };
        } else {
            suffix = "/repository/commits";
            method = "POST";
            body = {
                branch: repo.branch,
                commit_message: args.message,
                actions: [
                    {
                        action: current.exists ? "update" : "create",
                        file_path: path,
                        content: args.content,
                        ...(current.exists ? { last_commit_id: current.revision } : {}),
                    },
                ],
            };
        }
        const response = await this.remote(this.repoApi(repo), suffix, { method, body, signal });
        if (response.status === 404) throw problem("Repository or branch not found.", 404);
        let receipt = {};
        try {
            receipt = JSON.parse(response.text);
        } catch {}
        const commit = repo.kind === "github" ? receipt?.commit?.sha : receipt?.id;
        return {
            saved: true,
            repository: visible(repo),
            path,
            status: "DRAFT",
            clinicalApproval: false,
            ...version,
            ...(typeof commit === "string" && /^[a-f0-9]{40,64}$/.test(commit) ? { commit } : {}),
            url:
                repo.url +
                (repo.kind === "github" ? "/blob/" : "/-/blob/") +
                encodeURIComponent(repo.branch) +
                "/" +
                path.split("/").map(encodeURIComponent).join("/"),
        };
    }
}
