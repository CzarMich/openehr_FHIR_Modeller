# ADR-0025: Bounded AI execution backed by persistent project state

Status: Proposed

## Context

REQ-F25 requires long-lived projects without indefinitely growing AI context. Browser providers already create disposable runtimes per response, but formerly replayed a 60,000-character transcript, every tool schema, and duplicate MCP result representations. Chat retention and its bounded recovery cache could also remove unsaved work that a later project task needed.

## Decision

Keep the existing provider `run`/abort/cleanup interface and disposable Codex, Claude and Copilot Studio runtimes. Add provider-neutral logical session records and task orchestration above it. Reuse a bounded context cohort for coherent follow-ups; rotate it on explicit request, independent review, family/provider/model/security/project/repository changes, age, failure, milestone completion or configured limits. Never resume a permanent native conversation ID or automatically replay a failed write.

Build context by authority and priority, preserving complete current instructions. Retrieve source content through existing tools. Discover large tool catalogues on demand, remove only exact duplicate MCP text, and page large results with execution-scoped references. Account for instructions, schemas, images and tool exchanges using conservative estimates, plus provider telemetry when available. Abort before further work when the execution budget is exhausted.

Extend the existing encrypted browser store, checkpoint cache and template-package cache with independent project task records and exact project draft/package archives. Project records outlive conversations; private drafts remain unapproved. Git and the existing requirements/decision graph, provenance, deterministic validation and human governance remain authoritative. Handoffs separate assistant reports from actual tool receipts. No second clinical approval or enterprise decision subsystem is introduced.

Independent review starts with current instructions/configuration and source metadata. It excludes chat, generator handoffs and checkpoint retrieval tools. It obtains artefacts, requirements, standards and dependencies from existing source tools, and uses deterministic validators before supplementary AI findings.

## Consequences

Input size is bounded independently of project age, and successful tool receipts/drafts survive provider failure. Per-task files avoid competing whole-project history writes within the supported single browser-service instance; existing expected-revision and non-forced Git updates continue to protect artefact writes. Project settings use optimistic revision checks. Multiple browser replicas remain unsupported.

Token counts are estimates, not billing measurements or a guarantee of a provider's context window. Tool discovery adds calls, and large artefacts can exhaust a deliberately small budget; retained draft IDs avoid retranscribing complete packages. External MCP clients manage their own model sessions. FHIR task labels do not add unsupported FHIR profiling/IG engines. Storage must be backed up with its encryption key and sized for persistent project records. Details and verified boundaries: [Task execution](../TASK_EXECUTION.md).
