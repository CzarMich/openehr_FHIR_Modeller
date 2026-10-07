import { createHash, randomUUID } from "node:crypto";
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    readdirSync,
    unlinkSync,
    statSync,
    lstatSync,
    rmdirSync,
    rmSync,
} from "node:fs";
import { join } from "node:path";

import { repositoryFolder, projectFolder } from "./repository-paths.mjs";
import { safeMetadata } from "./task-execution.mjs";

export class Store {
    constructor(directory, retentionDays = 30) {
        this.directory = directory;
        this.retentionMs = retentionDays * 86400000;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    prune() {
        for (const owner of readdirSync(this.directory)) {
            if (!/^[a-f0-9]{64}$/.test(owner)) continue;
            const directory = join(this.directory, owner);
            if (!lstatSync(directory).isDirectory()) continue;
            for (const file of readdirSync(directory)) {
                if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
                const path = join(directory, file);
                if (Date.now() - lstatSync(path).mtimeMs > this.retentionMs) {
                    unlinkSync(path);
                    rmSync(path.slice(0, -5), { recursive: true, force: true });
                }
            }
            if (readdirSync(directory).length === 0) rmdirSync(directory);
        }
    }
    owner(identity) {
        return createHash("sha256").update(identity).digest("hex");
    }
    directoryFor(identity) {
        const directory = join(this.directory, this.owner(identity));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        return directory;
    }
    path(identity, id) {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw Object.assign(new Error("Conversation not found"), { status: 404 });
        return join(this.directoryFor(identity), id + ".json");
    }
    projects(identity) {
        try {
            return JSON.parse(readFileSync(join(this.directoryFor(identity), "projects.json"), "utf8")).map(
                (project) => ({
                    ...project,
                    repository: project.repository ?? null,
                    folder: project.folder ?? projectFolder(project.name),
                }),
            );
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
    }
    project(identity, id) {
        const project = this.projects(identity).find((item) => item.id === id);
        if (!project) throw Object.assign(new Error("Chat project not found."), { status: 404 });
        return project;
    }
    saveProjects(identity, projects) {
        const path = join(this.directoryFor(identity), "projects.json"),
            temp = path + "." + randomUUID() + ".tmp";
        writeFileSync(temp, JSON.stringify(projects), { mode: 0o600 });
        renameSync(temp, path);
    }
    destination(identity, project = null) {
        if (project) {
            const value = this.project(identity, project);
            return { repository: value.repository, folder: value.folder };
        }
        try {
            return JSON.parse(readFileSync(join(this.directoryFor(identity), "destination.json"), "utf8"));
        } catch (error) {
            if (error.code === "ENOENT") return { repository: null, folder: "" };
            throw error;
        }
    }
    saveDestination(identity, repository, folder, project = null) {
        folder = repositoryFolder(folder);
        if (project) {
            const value = this.project(identity, project);
            this.saveProject(identity, value.name, project, { repository, folder });
        }
        const path = join(this.directoryFor(identity), "destination.json"),
            temp = path + "." + randomUUID() + ".tmp";
        writeFileSync(temp, JSON.stringify({ repository, folder }), { mode: 0o600 });
        renameSync(temp, path);
    }
    saveProject(identity, name, id = null, destination = {}) {
        if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name))
            throw Object.assign(new Error("Enter a project name of 1 to 80 characters."), { status: 400 });
        const projects = this.projects(identity);
        if (id) this.project(identity, id);
        if (projects.some((item) => item.id !== id && item.name.toLowerCase() === name.trim().toLowerCase()))
            throw Object.assign(new Error("A chat project with that name already exists."), { status: 409 });
        if (!id && projects.length >= 40)
            throw Object.assign(new Error("Chat project limit reached (40). Remove an unused project."), {
                status: 429,
            });
        const project = id ? projects.find((item) => item.id === id) : { id: randomUUID() };
        if (
            Object.hasOwn(destination, "expectedRevision") &&
            destination.expectedRevision !== (project.revision || null)
        )
            throw Object.assign(new Error("Project settings changed. Reload before saving."), { status: 409 });
        if (destination.instructions !== undefined) {
            if (typeof destination.instructions !== "string" || destination.instructions.length > 4000)
                throw Object.assign(new Error("Project instructions must be at most 4,000 characters."), {
                    status: 400,
                });
            project.instructions = safeMetadata(destination.instructions);
        }
        if (destination.standards !== undefined) {
            const standards = destination.standards;
            if (
                !standards ||
                typeof standards !== "object" ||
                Array.isArray(standards) ||
                Object.entries(standards).some(
                    ([key, value]) =>
                        !["openehr", "fhir", "implementationGuide", "terminology"].includes(key) ||
                        typeof value !== "string" ||
                        value.length > 200,
                )
            )
                throw Object.assign(new Error("Use short standard/version identifiers without credentials."), {
                    status: 400,
                });
            project.standards = safeMetadata(standards);
        }
        project.revision = randomUUID();
        project.name = name.trim();
        project.repository =
            destination.repository !== undefined
                ? destination.repository
                : id
                  ? project.repository
                  : this.destination(identity).repository;
        project.folder = repositoryFolder(
            destination.folder !== undefined ? destination.folder : (project.folder ?? projectFolder(project.name)),
        );
        if (!id) projects.push(project);
        this.saveProjects(identity, projects);
        return project;
    }
    deleteProject(identity, id) {
        this.project(identity, id);
        for (const item of this.list(identity).filter((item) => item.project === id)) {
            const conversation = this.get(identity, item.id);
            conversation.stateScope = id;
            conversation.project = null;
            this.save(identity, conversation);
        }
        this.saveProjects(
            identity,
            this.projects(identity).filter((item) => item.id !== id),
        );
    }
    list(identity) {
        const directory = this.directoryFor(identity),
            items = [];
        for (const file of readdirSync(directory)) {
            if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
            const path = join(directory, file);
            if (Date.now() - statSync(path).mtimeMs > this.retentionMs) {
                unlinkSync(path);
                rmSync(path.slice(0, -5), { recursive: true, force: true });
                continue;
            }
            const conversation = JSON.parse(readFileSync(path, "utf8"));
            items.push({
                id: conversation.id,
                title: conversation.title,
                updatedAt: conversation.updatedAt,
                project: conversation.project || null,
            });
        }
        return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    create(identity, provider = "codex", repository = undefined, project = null, folder = undefined) {
        const defaults = this.destination(identity, project);
        repository = repository === undefined ? defaults.repository : repository;
        folder = repositoryFolder(folder === undefined ? defaults.folder : folder);
        if (this.list(identity).length >= 100)
            throw Object.assign(new Error("Conversation limit reached. Delete an older chat."), { status: 429 });
        const conversation = {
            id: randomUUID(),
            title: "New conversation",
            provider,
            ...(repository ? { repository } : {}),
            folder,
            ...(project ? { project } : {}),
            messages: [],
            updatedAt: new Date().toISOString(),
        };
        this.save(identity, conversation);
        return conversation;
    }
    get(identity, id) {
        try {
            const path = this.path(identity, id);
            if (Date.now() - statSync(path).mtimeMs > this.retentionMs) {
                unlinkSync(path);
                rmSync(path.slice(0, -5), { recursive: true, force: true });
                throw new Error("Expired");
            }
            return JSON.parse(readFileSync(path, "utf8"));
        } catch {
            throw Object.assign(new Error("Conversation not found"), { status: 404 });
        }
    }
    save(identity, conversation) {
        conversation.updatedAt = new Date().toISOString();
        const path = this.path(identity, conversation.id),
            temp = path + "." + randomUUID() + ".tmp";
        writeFileSync(temp, JSON.stringify(conversation), { mode: 0o600 });
        renameSync(temp, path);
    }
    delete(identity, id) {
        this.get(identity, id);
        unlinkSync(this.path(identity, id));
        rmSync(this.path(identity, id).slice(0, -5), { recursive: true, force: true });
    }
}
