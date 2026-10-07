import { randomUUID, createHash } from "node:crypto";
import { problem } from "./personal-http.mjs";
import { artifactPath, fhirArtifactPath } from "./repository-paths.mjs";

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
const fingerprint = (chat) => {
    const { movePlan, updatedAt, ...state } = chat;
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
};

// Only server-recorded successful saves belong to a chat. Older files can be
// explicitly included by their owner; assistant prose is never a file manifest.
export function recordArtifact(chat, args, receipt = {}) {
    const previous = (chat.artifacts || []).find(
        (item) => item.repository === args.repository && item.path === args.path,
    );
    const artifact = {
        repository: args.repository,
        path: args.path,
        folder: chat.folder || "",
        ...(["FHIR", "mappings"].includes(args.standard) ? { standard: args.standard } : {}),
        ...(receipt.dependency === true ? { dependency: true } : {}),
        ...(sha(receipt.commit)
            ? { commit: receipt.commit }
            : receipt.changed === false && receipt.sha256 === previous?.sha256 && sha(previous?.commit)
              ? { commit: previous.commit }
              : {}),
        ...(/^[a-f0-9]{64}$/.test(receipt.sha256 || "") ? { sha256: receipt.sha256 } : {}),
        ...(["created", "updated", "unchanged"].includes(receipt.change) ? { change: receipt.change } : {}),
        ...(["github", "gitlab"].includes(receipt.repository?.kind)
            ? {
                  destination: {
                      kind: receipt.repository.kind,
                      url: receipt.repository.url,
                      branch: receipt.repository.branch,
                  },
              }
            : {}),
    };
    chat.artifacts = (chat.artifacts || []).filter(
        (item) => item.repository !== artifact.repository || item.path !== artifact.path,
    );
    chat.artifacts.push(artifact);
    return artifact;
}

export class ProjectMoves {
    constructor(store, connections, allowWrites, signal) {
        this.store = store;
        this.connections = connections;
        this.allowWrites = allowWrites;
        this.signal = signal;
    }
    async remote(repo, suffix, options = {}) {
        const response = await this.connections.remote(this.connections.repoApi(repo), suffix, {
            signal: this.signal,
            ...options,
        });
        if (response.status === 404) throw problem("Repository, branch or file not found.", 404);
        try {
            return JSON.parse(response.text);
        } catch {
            throw problem("Invalid repository response.", 503);
        }
    }
    async head(repo) {
        const data = await this.remote(
            repo,
            repo.kind === "github"
                ? "/git/ref/heads/" + repo.branch.split("/").map(encodeURIComponent).join("/")
                : "/repository/branches/" + encodeURIComponent(repo.branch),
        );
        const commit = repo.kind === "github" ? data.object?.sha : data.commit?.id;
        if (!sha(commit)) throw problem("Invalid repository revision.", 503);
        return commit;
    }
    async githubEntry(repo, base, path, cache) {
        if (!cache.has(base)) {
            const commit = await this.remote(repo, "/git/commits/" + base);
            if (!sha(commit.tree?.sha)) throw problem("Invalid repository tree.", 503);
            cache.set(base, commit.tree.sha);
        }
        let tree = cache.get(base);
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            if (!cache.has("tree:" + tree)) {
                const data = await this.remote(repo, "/git/trees/" + tree);
                if (!Array.isArray(data.tree) || data.truncated)
                    throw problem("The repository folder is too large to verify a move.", 413);
                cache.set("tree:" + tree, data.tree);
            }
            const entry = cache.get("tree:" + tree).find((item) => item.path === parts[i]);
            if (!entry) return null;
            if (i === parts.length - 1) return entry;
            if (entry.type !== "tree") throw problem("A file blocks the requested repository folder.", 409);
            tree = entry.sha;
        }
    }
    async preview(identity, chat, projectId, paths = []) {
        if (chat.movePlan?.commit) {
            if (chat.movePlan.project !== projectId)
                throw problem("Finish the pending artefact move before choosing another project.", 409);
            const pending = chat.movePlan,
                repo = this.connections.get(identity, pending.repository);
            const head = await this.head(repo);
            if (head === pending.base || head === pending.commit) return pending;
            if (repo.kind === "github") {
                const comparison = await this.remote(repo, "/compare/" + pending.commit + "..." + head);
                if (["ahead", "identical"].includes(comparison.status)) return pending;
            }
            // A competing commit rejected our non-forced update. Build a fresh
            // read-only preview rather than trapping the chat on an orphan commit.
            delete chat.movePlan;
        }
        if (!Array.isArray(paths) || paths.length > 50) throw problem("Include at most 50 existing artefact paths.");
        const project = projectId === null ? null : this.store.project(identity, projectId);
        const target = project || { repository: chat.repository || null, folder: chat.folder || "" };
        const repository = target.repository ? this.connections.get(identity, target.repository) : null;
        if (repository?.kind === "ckm") throw problem("Choose a repository in project settings.");
        const artifacts = [...(chat.artifacts || [])];
        for (const path of paths) {
            this.connections.validatePath(path);
            if (!chat.repository) throw problem("Select the repository containing the older artefacts first.");
            if (!artifacts.some((item) => item.repository === chat.repository && item.path === path))
                artifacts.push({ repository: chat.repository, path, folder: chat.folder || "" });
        }
        const legacy = chat.messages.some((message) =>
            (message.tools || []).some(
                (tool) => tool.name === "personal_repository_save" && tool.status === "completed" && !tool.artifact,
            ),
        );
        if (project && legacy && !chat.legacyArtifactsIncluded && !paths.length)
            throw problem(
                "This older chat has saved artefacts without recorded paths. Include their repository paths below to move them.",
            );
        const moves = [];
        if (project) {
            if (artifacts.length > 200) throw problem("A chat move supports up to 200 saved artefacts.", 413);
            for (const artifact of artifacts) {
                const source = this.connections.get(identity, artifact.repository);
                if (!repository || source.url !== repository.url || source.branch !== repository.branch)
                    throw problem(
                        "To move saved artefacts, choose a project using the same repository and branch as those files.",
                    );
                const relative =
                    artifact.folder && artifact.path.startsWith(artifact.folder + "/")
                        ? artifact.path.slice(artifact.folder.length + 1)
                        : artifact.path;
                const targetPath = (target.folder ? target.folder + "/" : "") + relative;
                const to = this.connections.validatePath(
                    ["FHIR", "mappings"].includes(artifact.standard)
                        ? fhirArtifactPath(targetPath, target.folder || "", artifact.standard)
                        : artifactPath(targetPath, target.folder || ""),
                );
                if (to !== artifact.path)
                    moves.push({
                        from: artifact.path,
                        to,
                        repository: artifact.repository,
                        ...(artifact.dependency ? { retainSource: true } : {}),
                    });
            }
        }
        if (new Set(moves.map((move) => move.to)).size !== moves.length)
            throw problem("Two artefacts would have the same destination. Rename one before moving.", 409);
        let base = null;
        if (moves.length) {
            if (!this.allowWrites) throw problem("Repository writes are disabled.", 403);
            if (!repository.token)
                throw problem("Add a write token in Settings → My sources and repositories first.", 403);
            base = await this.head(repository);
            const cache = new Map();
            for (const move of moves) {
                if (repository.kind === "github") {
                    const source = await this.githubEntry(repository, base, move.from, cache);
                    if (
                        !source ||
                        source.type !== "blob" ||
                        !["100644", "100755"].includes(source.mode) ||
                        !sha(source.sha)
                    )
                        throw problem("A saved artefact is missing or is not a regular file: " + move.from, 409);
                    if (await this.githubEntry(repository, base, move.to, cache))
                        throw problem(
                            "A file already exists at " + move.to + ". Rename it or choose another project folder.",
                            409,
                        );
                    move.revision = source.sha;
                    move.mode = source.mode;
                } else {
                    const source = await this.connections.readRepository(
                        identity,
                        { repository: repository.id, path: move.from },
                        undefined,
                        base,
                    );
                    const destination = await this.connections.readRepository(
                        identity,
                        { repository: repository.id, path: move.to },
                        undefined,
                        base,
                    );
                    if (!source.exists) throw problem("A saved artefact is missing: " + move.from, 409);
                    if (destination.exists)
                        throw problem("A file already exists at " + move.to + ". Choose another folder.", 409);
                    move.revision = source.revision;
                    if (move.retainSource) move.content = source.content;
                }
            }
        }
        const plan = {
            id: randomUUID(),
            expiresAt: Date.now() + 10 * 60000,
            fingerprint: fingerprint(chat),
            project: projectId,
            repository: target.repository || null,
            folder: target.folder || "",
            destination: repository ? { kind: repository.kind, url: repository.url, branch: repository.branch } : null,
            artifacts,
            moves,
            base,
            legacyArtifactsIncluded: legacy && paths.length > 0,
        };
        chat.movePlan = plan;
        this.store.save(identity, chat);
        return plan;
    }
    async apply(identity, chat, id) {
        const plan = chat.movePlan;
        if (
            !plan ||
            plan.id !== id ||
            (!plan.commit && plan.expiresAt < Date.now()) ||
            plan.fingerprint !== fingerprint(chat)
        )
            throw problem("This move preview has expired or the chat changed. Preview the move again.", 409);
        if (plan.project) {
            const project = this.store.project(identity, plan.project);
            if (project.repository !== plan.repository || project.folder !== plan.folder)
                throw problem("The project destination changed. Preview the move again.", 409);
        }
        if (plan.moves.length) {
            if (!this.allowWrites) throw problem("Repository writes are disabled.", 403);
            const repo = this.connections.get(identity, plan.repository);
            plan.destination.kind = repo.kind;
            if (!repo.token || repo.url !== plan.destination.url || repo.branch !== plan.destination.branch)
                throw problem("Repository access changed. Check Settings and preview the move again.", 409);
            const head = await this.head(repo);
            const alreadyCommitted =
                head === plan.commit ||
                (plan.commit &&
                    repo.kind === "github" &&
                    ["ahead", "identical"].includes(
                        (await this.remote(repo, "/compare/" + plan.commit + "..." + head)).status,
                    ));
            // A lost HTTP response can be retried using the same preview without
            // repeating the commit or moving an already-moved file.
            if (!alreadyCommitted) {
                if (head !== plan.base) throw problem("The repository changed. Preview the move again.", 409);
                if (repo.kind === "github") {
                    if (!plan.commit) {
                        const parent = await this.remote(repo, "/git/commits/" + plan.base);
                        if (!sha(parent.tree?.sha)) throw problem("Invalid repository tree.", 503);
                        const tree = await this.remote(repo, "/git/trees", {
                            method: "POST",
                            body: {
                                base_tree: parent.tree.sha,
                                tree: plan.moves.flatMap((move) => [
                                    ...(move.retainSource
                                        ? []
                                        : [{ path: move.from, mode: move.mode, type: "blob", sha: null }]),
                                    { path: move.to, mode: move.mode, type: "blob", sha: move.revision },
                                ]),
                            },
                        });
                        if (!sha(tree.sha)) throw problem("Invalid repository tree.", 503);
                        const commit = await this.remote(repo, "/git/commits", {
                            method: "POST",
                            body: {
                                message: "Move modelling artefacts to " + (plan.folder || "repository root"),
                                tree: tree.sha,
                                parents: [plan.base],
                            },
                        });
                        if (!sha(commit.sha)) throw problem("Invalid repository commit.", 503);
                        plan.commit = commit.sha;
                        this.store.save(identity, chat);
                    }
                    await this.remote(
                        repo,
                        "/git/refs/heads/" + repo.branch.split("/").map(encodeURIComponent).join("/"),
                        {
                            method: "PATCH",
                            body: { sha: plan.commit, force: false },
                        },
                    );
                } else {
                    const commit = await this.remote(repo, "/repository/commits", {
                        method: "POST",
                        body: {
                            branch: repo.branch,
                            start_sha: plan.base,
                            force: false,
                            commit_message: "Move modelling artefacts to " + (plan.folder || "repository root"),
                            actions: plan.moves.map((move) => ({
                                action: move.retainSource ? "create" : "move",
                                file_path: move.to,
                                ...(move.retainSource
                                    ? { content: move.content }
                                    : { previous_path: move.from, last_commit_id: move.revision }),
                            })),
                        },
                    });
                    if (!sha(commit.id)) throw problem("Invalid repository commit.", 503);
                    plan.commit = commit.id;
                    this.store.save(identity, chat);
                }
            }
        }
        chat.project = plan.project;
        chat.repository = plan.repository;
        chat.folder = plan.folder;
        chat.artifacts = plan.artifacts.map((artifact) => {
            const move = plan.moves.find(
                (item) => item.repository === artifact.repository && item.from === artifact.path,
            );
            return move
                ? {
                      repository: plan.repository,
                      path: move.to,
                      folder: plan.folder,
                      ...(artifact.dependency ? { dependency: true } : {}),
                      destination: plan.destination,
                      ...(plan.commit ? { commit: plan.commit } : {}),
                  }
                : artifact;
        });
        chat.lastMove = { id: plan.id, count: plan.moves.length, ...(plan.commit ? { commit: plan.commit } : {}) };
        if (plan.legacyArtifactsIncluded) chat.legacyArtifactsIncluded = true;
        delete chat.movePlan;
        this.store.save(identity, chat);
        return chat;
    }
}
