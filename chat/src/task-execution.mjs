import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderStore } from "./provider-store.mjs";
import { budgetFor, ContextBuilder, estimateTokens, relevance } from "./context-budget.mjs";
import { problem } from "./personal-http.mjs";
import { INSTRUCTIONS } from "./provider-tools.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const taskId = /^[0-9]{13}-[a-f0-9-]{36}$/;
export const executionScope = (conversation) => conversation.project || conversation.stateScope || conversation.id;
// Only structured, modelling-specific metadata is recorded. Credentials stay
// in the existing connection layer; no raw provider errors or transcripts.
export function safeMetadata(value) {
    if (typeof value === "string")
        return value
            .replace(
                /\b(?:sk-(?:ant-|proj-)?[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|glpat-[\w-]{12,}|Bearer\s+[\w.+/=-]+)/gi,
                "[redacted]",
            )
            .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/g, "[redacted]")
            .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
    if (Array.isArray(value)) return value.map(safeMetadata);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(
                    ([key]) =>
                        !/^(?:token|password|apiKey|credential|authorization|secret|content|messages)$/i.test(key),
                )
                .map(([key, item]) => [key, safeMetadata(item)]),
        );
    return value;
}

// The browser's existing encrypted store backs project records. Task files are
// independent, so parallel conversations never rewrite one shared history blob.
// Explicit project records outlive chat retention. Unfiled records use chat scope.
export class TaskLedger {
    constructor(config, identity, scope, { persistent = false } = {}) {
        this.directory = join(config.dataDir, "task-state", hash([identity, scope]));
        this.key = config.providerEncryptionKey;
        this.owner = identity + "\0" + scope;
        this.memory = new Map();
        if (this.key) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (this.key && persistent) writeFileSync(join(this.directory, ".project"), "", { mode: 0o600 });
    }
    storage(id, kind = "task") {
        if (kind === "task" && !taskId.test(id)) throw problem("Task not found.", 404);
        return this.key
            ? new ProviderStore(kind === "task" ? join(this.directory, id) : this.directory, this.key, [kind])
            : null;
    }
    put(id, value, kind = "task") {
        const storage = this.storage(id, kind);
        if (storage) storage.set(this.owner + "\0" + id, kind, value);
        else this.memory.set(kind + id, structuredClone(value));
    }
    get(id, kind = "task") {
        if (kind === "task" && (!taskId.test(id) || (this.key && !existsSync(join(this.directory, id))))) return null;
        return (
            this.storage(id, kind)?.get(this.owner + "\0" + id, kind)?.credential || this.memory.get(kind + id) || null
        );
    }
    list({ offset = 0, limit = 20 } = {}) {
        if (!Number.isSafeInteger(offset) || offset < 0) throw problem("Invalid task offset.");
        const ids = this.key
            ? readdirSync(this.directory).filter((id) => taskId.test(id))
            : [...this.memory.keys()].filter((key) => key.startsWith("task")).map((key) => key.slice(4));
        ids.sort().reverse();
        return {
            items: ids
                .slice(offset, offset + limit)
                .map((id) => this.get(id))
                .filter(Boolean),
            total: ids.length,
            nextOffset: offset + limit < ids.length ? offset + limit : null,
        };
    }
    delete() {
        if (this.key) rmSync(this.directory, { recursive: true, force: true });
        this.memory.clear();
    }
    static prune(config) {
        const root = join(config.dataDir, "task-state");
        if (!existsSync(root)) return;
        for (const name of readdirSync(root)) {
            if (!/^[a-f0-9]{64}$/.test(name)) continue;
            const path = join(root, name);
            if (
                !existsSync(join(path, ".project")) &&
                Date.now() - statSync(path).mtimeMs > (config.retentionDays || 30) * 86400000
            )
                rmSync(path, { recursive: true, force: true });
        }
    }
}

// Extensible task-family registry; classification controls relevance, never tool
// authorization or clinical capability claims. Follow-ups inherit affinity.
export const TASK_FAMILIES = [
    ["FHIR", /\b(fhir|structuredefinition|implementation guide|valueset|conceptmap)\b/i],
    ["TERMINOLOGY", /\b(terminology|snomed|loinc|ucum|binding)\b/i],
    ["AQL", /\b(aql|query)\b/i],
    ["TEMPLATE", /\b(template|oet|opt2?)\b/i],
    ["ARCHETYPE", /\b(archetype|adl)\b/i],
    ["REPOSITORY", /\b(repository|git|branch|commit)\b/i],
];
export function taskFamily(objective, previous = "MODELLING", type) {
    if (type) return type;
    return TASK_FAMILIES.find(([, pattern]) => pattern.test(objective))?.[0] || previous;
}

export class SessionManager {
    constructor(config) {
        this.budget = budgetFor(config);
    }
    select(previous, { provider, model, family, boundary, mode = "auto", messageIndex }) {
        const reason = !previous
            ? "initial"
            : mode === "independent"
              ? "independent_validation"
              : mode === "fresh"
                ? "user_request"
                : previous.boundary !== boundary
                  ? "project_state_changed"
                  : previous.provider !== provider || previous.model !== model
                    ? "provider_changed"
                    : previous.family !== family
                      ? "task_family_changed"
                      : ["failed", "cancelled", "completed"].includes(previous.status)
                        ? previous.status
                        : Date.now() - Date.parse(previous.lastUsedAt) > this.budget.idleMs
                          ? "stale"
                          : previous.estimatedContextUsage >= this.budget.session - 8192 ||
                              previous.turns >= this.budget.turns
                            ? "context_threshold"
                            : null;
        const session = reason
            ? {
                  sessionId: randomUUID(),
                  parentSessionId: previous?.sessionId || null,
                  generation: (previous?.generation || 0) + 1,
                  provider,
                  model,
                  family,
                  boundary,
                  createdAt: now(),
                  since: messageIndex,
                  turns: 0,
                  estimatedContextUsage: 0,
                  rotationReason: reason,
                  metadata: { providerRuntime: "ephemeral_per_turn" },
              }
            : { ...previous, rotationReason: null };
        session.lastUsedAt = now();
        session.status = "active";
        session.turns++;
        return session;
    }
    close(session, status, usage) {
        session.status = status;
        session.lastUsedAt = now();
        session.estimatedContextUsage =
            (usage.estimatedInputTokens || 0) + (usage.estimatedToolTokens || 0) + (usage.estimatedOutputTokens || 0);
        session.estimatedContextUsage = Math.max(session.estimatedContextUsage, usage.reportedContextTokens || 0);
        session.usage = usage;
    }
}

export class TaskOrchestrator {
    constructor(config, store, identity, conversation) {
        Object.assign(this, { config, store, identity, conversation });
        this.ledger = new TaskLedger(config, identity, executionScope(conversation), {
            persistent: !!(conversation.project || conversation.stateScope),
        });
        this.sessions = new SessionManager(config);
        this.builder = new ContextBuilder(config);
        this.builder.budget.input -= estimateTokens(INSTRUCTIONS) + 1600;
    }
    prepare(messages, metadata, input, securityBoundary) {
        const objective = messages.at(-1).content;
        const project = this.conversation.project ? this.store.project(this.identity, this.conversation.project) : null;
        const previous = this.conversation.execution;
        const family = taskFamily(objective, previous?.family, input.taskType);
        // A fresh provider runtime also prevents unseen remote repository changes
        // from inheriting native state. Revisions are checked on each actual read/write.
        const boundary = hash([project, metadata.personalRepositorySave, metadata.repositoryState, securityBoundary]);
        const mode =
            input.sessionMode ||
            (/\b(independent|clean[- ]room)\b.*\b(validat|review|check)/i.test(objective) ? "independent" : "auto");
        this.session = this.sessions.select(previous, {
            provider: this.conversation.provider || "codex",
            model:
                this.conversation.provider === "claude"
                    ? this.config.claudeModel
                    : this.conversation.provider === "copilot"
                      ? "configured-agent"
                      : this.config.model,
            family,
            boundary,
            mode,
            messageIndex: messages.length - 1,
        });
        if (previous && this.session.sessionId !== previous.sessionId) {
            const prior = this.ledger.get(previous.taskId);
            if (prior) {
                prior.session.status = "rotated";
                prior.session.retiredReason = this.session.rotationReason;
                this.ledger.put(prior.id, prior);
            }
        }
        const id = Date.now() + "-" + randomUUID();
        this.task = {
            id,
            projectId: project?.id || null,
            conversationId: this.conversation.id,
            type: family,
            mode,
            objective: safeMetadata(objective),
            status: "running",
            startedAt: now(),
            baseRepository: {
                repository: this.conversation.repository || null,
                branch: metadata.saveDestination?.branch || null,
                revision: null,
            },
            session: this.session,
            usage: {},
            evidence: [],
            handoff: null,
        };
        this.session.taskId = id;
        this.session.projectId = this.task.projectId;
        this.conversation.execution = this.session;
        this.conversation.taskId = id;
        this.persist();
        const independent = mode !== "auto" || (previous && this.session.sessionId !== previous.sessionId);
        const topicWords = (objective.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter(
            (word) =>
                ![
                    "template",
                    "archetype",
                    "create",
                    "review",
                    "validate",
                    "generate",
                    "model",
                    "please",
                    "continue",
                ].includes(word),
        );
        const history =
            mode === "independent"
                ? []
                : relevance(
                      objective,
                      this.ledger
                          .list()
                          .items.filter(
                              (task) =>
                                  task.type === family &&
                                  task.handoff &&
                                  (task.id === previous?.taskId ||
                                      topicWords.some((word) => task.objective.toLowerCase().includes(word))),
                          )
                          .map((task) => ({
                              taskId: task.id,
                              objective: task.objective,
                              status: task.status,
                              ...task.handoff,
                          })),
                      2,
                  );
        const context = this.builder.build({
            messages,
            since: this.session.since,
            independent,
            critical: {
                task: { id, type: family, mode },
                project: project
                    ? {
                          id: project.id,
                          name: project.name,
                          instructions: project.instructions || "",
                          standards: project.standards || {},
                      }
                    : null,
                personalRepositorySave: metadata.personalRepositorySave,
                saveDestination: metadata.saveDestination,
                repositoryState: metadata.repositoryState,
                artifactFolders: metadata.artifactFolders,
                authority:
                    "Current user instructions > current project configuration > approved repository decisions > current artefacts and documentation > validated metadata > standards > historical task summaries > chat. Read current revisions and requirements before editing. Tool evidence and AI summaries are not approval. Persist important decisions and requirements using revisioned project traceability or repository documents; retain generated artefacts with workspace_draft_save and call workspace_task_handoff before finishing. Never depend on chat for project memory.",
                ...(mode === "independent"
                    ? {
                          review: "Independent review: retrieve the target artefact, requirements, standards and dependencies; run deterministic validators first. Do not retrieve generator handoffs, draft reasoning or chat history. AI findings supplement validation; they never establish clinical approval.",
                      }
                    : {}),
            },
            high: {
                attachments: relevance(objective, metadata.attachments, 8),
                savedArtifacts: relevance(objective, [...metadata.savedArtifacts].reverse(), 8),
            },
            medium: mode === "independent" ? {} : { recovery: metadata.recovery },
            low: { historicalTaskSummaries: history },
        });
        this.task.usage = context.usage;
        this.task.baseRepository.revision = metadata.repositoryState?.revision || null;
        this.persist();
        return context.messages;
    }
    usage(value) {
        this.task.usage = { ...this.task.usage, ...value };
    }
    persist() {
        if (this.task) this.ledger.put(this.task.id, safeMetadata(this.task));
    }
    capture(name, args, response, checkpointId = null) {
        if (!this.task) return;
        const data = response?.structuredContent?.result || response?.structuredContent || {};
        const evidence = safeMetadata({
            tool: name,
            checkpointId,
            at: now(),
            success: !response?.isError && response?.structuredContent?.success !== false,
            repository: args.repository || args.project,
            path: args.path,
            baseRevision: args.expectedRevision,
            revision: data.ref || data.revision || data.commit,
            sha256: data.sha256,
            draftId: data.draftId || args.draftId,
            saved: data.saved === true,
            changed: data.changed,
            files: data.files?.map(({ path, revision, sha256, change }) => ({ path, revision, sha256, change })),
            ...(typeof data.valid === "boolean"
                ? {
                      validation: {
                          valid: data.valid,
                          scope: data.scope || data.validation_scope || "tool-reported",
                          tool: name,
                      },
                  }
                : {}),
        });
        this.task.evidence.push(evidence);
        if (args.repository === this.task.baseRepository.repository && data.ref && !this.task.baseRepository.revision)
            this.task.baseRepository.revision = data.ref;
        this.persist();
    }
    handoff(value) {
        const keys = [
            "result",
            "decisions",
            "assumptions",
            "warnings",
            "unresolvedIssues",
            "nextActions",
            "references",
        ];
        if (
            !value ||
            Object.keys(value).some((key) => !keys.includes(key)) ||
            typeof value.result !== "string" ||
            value.result.length > 2000 ||
            keys
                .slice(1)
                .some(
                    (key) =>
                        value[key] !== undefined &&
                        (!Array.isArray(value[key]) ||
                            value[key].length > 12 ||
                            value[key].some((item) => typeof item !== "string" || item.length > 500)),
                )
        )
            throw problem("Supply a concise result and lists of up to twelve short items.");
        this.task.handoff = { ...safeMetadata(value), source: "assistant_report", approval: "not_approved" };
        this.persist();
        return {
            taskId: this.task.id,
            saved: true,
            authority:
                "Historical task summary only. Persist authoritative decisions through the existing revisioned project traceability/repository tools.",
        };
    }
    finish(status, { completeTask = false, reason = null } = {}) {
        if (!this.task) return;
        this.task.status = status;
        this.task.finishedAt = now();
        this.task.durationMs = Date.parse(this.task.finishedAt) - Date.parse(this.task.startedAt);
        this.task.failure = reason;
        this.task.handoff ||= {
            result:
                status === "completed"
                    ? "Execution completed; inspect recorded tool evidence and current repository state."
                    : "Execution interrupted; inspect saved artefacts and checkpoints before continuing. Never repeat an uncertain write blindly.",
            source: "platform",
            unresolvedIssues: reason ? [reason] : [],
        };
        this.task.handoff.filesChanged = this.task.evidence
            .filter((item) => item.saved && item.changed !== false)
            .flatMap((item) => item.files || [{ path: item.path, revision: item.revision, sha256: item.sha256 }]);
        this.task.handoff.validation = this.task.evidence
            .filter((item) => item.validation)
            .map((item) => item.validation);
        this.task.handoff.commits = [
            ...new Set(this.task.evidence.filter((item) => item.saved && item.revision).map((item) => item.revision)),
        ];
        this.task.handoff.clarifications = this.task.clarifications || [];
        this.sessions.close(
            this.session,
            status === "completed" ? (completeTask ? "completed" : "idle") : status,
            this.task.usage,
        );
        this.persist();
    }
}
