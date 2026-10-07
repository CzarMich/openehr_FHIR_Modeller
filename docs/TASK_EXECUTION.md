# Task execution and context budgets

AI sessions are disposable. Repository artefacts, project instructions, decisions and task records are persistent.

## Using bounded context

In project settings, enter concise **Project instructions**, including requirement/decision-document paths and target standards. These instructions apply to new tasks in that project. In **Context for next message**, choose:

- **Continue this task**: retain a bounded set of complete recent turns when the task remains coherent.
- **Start a fresh task**: rebuild context from current project state and relevant structured handoffs, without replaying the prior conversation.
- **Independent review**: exclude generator history, handoffs and draft-checkpoint access; retrieve the target artefact and requirements from current sources and run deterministic validation first.

The selection resets after an accepted message. Chats retain their existing 80-message limit; start another chat in the same project when needed. AI review and a successful save never imply clinical approval.

## Authority and retrieval

Precedence is current user instructions, current project configuration, approved project decisions, current repository artefacts, versioned documentation, validated metadata, applicable standards, relevant task summaries, then chat history. A summary cannot approve a decision or override a newer revision.

The existing `model_traceability_*` graph is the enterprise requirements/decision log. Personal projects use versioned repository documents and their Git history through the existing confirmed save tools. Keep decision rationale, evidence, status, affected artefacts and supersession there. Handoff decision text remains an unapproved assistant report and does not replace that log. Current revisions, permissions, terminology versions and validation results must be read through their owning tools.

`ContextBuilder` prioritises current task/configuration and repository identity, then relevant artefact/source metadata, then recovery references and matching task handoffs. Complete user/assistant groups are retained within the history budget; strings and instructions are never silently cut. Material that does not fit remains tool-retrievable. An oversized critical input is rejected explicitly.

`workspace_tools` searches a bounded tool catalogue or describes one schema. `workspace_call` dispatches that exact tool through the existing permissions, argument checks, confirmation and revision guards. Small isolated tool sets remain direct. All providers get the same selection mechanism. Exact duplicate MCP JSON text is removed; distinct warnings remain. Large outputs receive `workspace_result_read` references and lossless pages. Read all pages before using complete bytes; save templates by retained `draftId` whenever possible. References last for one execution and are inaccessible from another execution.

Browser content-based validation, inspection and compilation tools also accept `draftId` instead of retranscribed `content`. The server supplies exact retained bytes and, where applicable, the pinned template dependencies when omitted. Conflicting supplied content is rejected. This keeps large artefact validation within the model's context budget without weakening deterministic checks; public MCP schemas remain unchanged.

## Task and session lifecycle

`workspace_draft_save` retains exact generated artefact bytes privately without publishing them or claiming approval. Each browser turn has a task ID, family, objective, provider/model, timestamps, logical session ID/generation, context estimates, tool evidence and final status. `workspace_task_handoff` records a concise result, assumptions, decisions/references, unresolved issues and next actions. The server adds actual changed-file/commit receipts and tool-reported validation. `workspace_task_history` lists summaries; `workspace_task_read` retrieves one full record. These tools are private to the signed-in profile and selected project.

Logical sessions retain bounded context affinity across short follow-ups. Every native provider runtime is still fresh per response. Rotation occurs for a fresh/independent request, changed family/provider/model/credential/security boundary, changed project configuration or observed repository head, failed/cancelled/completed session, staleness, turn count or context threshold. A bounded branch-head read checks personal repositories; an unavailable head clears affinity and requires live reads before writes. Enterprise revisions are retrieved by the selected modelling operation. Remote state can change after inspection: expected-revision checks remain mandatory at save time.

The message API additionally accepts `sessionMode` (`auto`, `fresh`, `independent`), an extensible uppercase `taskType`, and `completeTask: true` to close a milestone. Classification selects context, not authorization. Task families cover existing openEHR, AQL, terminology and repository operations and can identify FHIR work without claiming new FHIR profile/IG validation support.

Failures preserve task receipts and exact drafts. A restart marks an abandoned task failed when its conversation is reopened; the next turn uses a fresh context cohort. Recovery is user-requested through continuation and never silently retries writes with uncertain outcomes. Different conversations have different task records; no task rewrites another task's history. Shared repository writes still use existing Git concurrency guards.

## Persistence and privacy

`task-state/<identity-and-scope-hash>/` uses the existing AES-256-GCM `ProviderStore`. Task records, draft bytes and template dependency packages are private to the verified profile and project. Each task is saved separately. Project drafts/packages persist beyond the ordinary 30-day conversation caches and can be reused from another chat in the project. The recent recovery view is bounded; older draft references remain available through the owning task record.

Project records are not deleted by chat expiry or deletion. Deleting a project grouping keeps its archived work accessible to its remaining unfiled chats, matching the existing non-destructive grouping semantics. Archives are retained on disk; operators must include them in storage planning and backup/retention procedures. Unfiled task records without a project archive follow chat retention and are removed on explicit chat deletion. This feature does not extend uploaded source-file retention: originals and extracted source documents still follow their conversation's lifecycle. Save authoritative source references and completed artefacts in the repository.

Connection secrets never enter task context; project configuration contains only bounded instructions and version identifiers. Task records contain selected evidence metadata, not raw provider errors, full tool logs, CDR results or transcripts. Common credential patterns are redacted from report text; this is defence in depth, not a general secret detector. Never include credentials in source documents or handoffs. Existing CDR patient-data and independent human-approval boundaries remain enforced. External MCP clients retain responsibility for their own AI context management.

## Configuration and telemetry

| Variable | Default | Meaning |
|---|---:|---|
| `CHAT_CONTEXT_INPUT_TOKENS` | 12000 | Approximate initial provider input, including instructions, schemas and image allowance |
| `CHAT_CONTEXT_HISTORY_TOKENS` | 2000 | Maximum historical conversation contribution |
| `CHAT_TOOL_RESULT_TOKENS` | 4000 | Approximate maximum tool-result page |
| `CHAT_CONTEXT_SESSION_TOKENS` | 48000 | Execution/context threshold, with an 8192-token reserve |
| `CHAT_SESSION_MAX_TURNS` | 8 | Maximum turns in a logical context cohort |
| `CHAT_SESSION_IDLE_SECONDS` | 1800 | Maximum idle age before rotation |

Settings reject non-integers, unsafe ranges and inconsistent budgets at startup. Estimates use UTF-8 bytes / 3 and a fixed image allowance, and cover supplied context, arguments, returned results and streamed text. They cannot measure hidden reasoning, provider framing, server-side agent instructions or actual image tokenisation. Claude also reports input/output/cache counts when supplied by its API; those are recorded separately from estimates. Provider-reported context usage can stop execution earlier. Billing savings depend on the provider and task; no fixed cost reduction is promised.

The task record exposes approximate initial input, tool/output contribution, available provider usage, elapsed duration, session rotation reason, success/failure and validation/file receipts. Default application logs contain only safe failure codes and tool names. No raw prompts or secret values are added to logs.

## Verification

`chat/test/task-execution.test.mjs` checks authority/priority budgets, complete-instruction preservation, schema size reduction, exact duplicate removal, lossless Unicode paging, output-limit cancellation, lifecycle triggers, identity/project isolation, independent-review separation, parallel task durability, revision conflicts and cross-chat draft/package recovery. HTTP tests verify that discovered write tools still require the same exact-change confirmation. Browser tests cover the new context selector alongside the existing desktop/mobile flows. Tests use synthetic content and local provider fixtures; they do not claim live-provider cost measurements.
