# Design and requirement mapping

The current design is documented in [Architecture](ARCHITECTURE.md). The [requirements](requirements.md) and [traceability map](traceability.md) connect capabilities to code and tests. Historical architectural decisions remain under [decisions](decisions/README.md); ADR-0008 supersedes deployment and plugin assumptions from the upstream product.

## Browser client

REQ-F15 adds an optional Node chat service alongside the PHP MCP core. It uses verified OIDC identity, private per-user conversations, personal Claude, Codex or [Copilot Studio](COPILOT_BROWSER.md) connections and streamed responses and exact-change confirmation before model writes. See [browser architecture and deployment](BROWSER_CHAT.md), [system architecture](ARCHITECTURE.md) and the browser/security tests in `chat/test/`. It does not introduce a visual archetype editor. Native inbound MCP bearer verification is a separate [identity adapter](OIDC.md).

The browser-only `request_user_choice` tool pauses a turn for a bounded single/multiple-choice question. SSE carries the question; an owner-authenticated, CSRF-protected endpoint validates the answer against its pending ID and offered options. The answer is returned to the provider and saved in private history. Timeout, stop and disconnect cancel the question. Decision answers remain separate from exact-change write confirmation and governance approval.

Chat projects are a private history index in each owner's conversation directory. Conversation records store an optional project ID; legacy records remain unfiled. Owner-authenticated project and conversation-settings endpoints create, rename and move folders/chats with CSRF protection. Folder removal moves chats to unfiled without deleting messages or files, and is blocked during that owner's active uploads or responses. Moving a chat into a project adopts its repository destination. `ProjectMoves` previews and confirms same-repository file moves with exact revisions; only successful `personal_repository_save` receipts or owner-supplied legacy paths identify the files. Conversations and uploaded originals stay private to the workspace. Project changes do not alter model governance.

## Human governance adapter

REQ-F16 adds transport-independent exact-revision governance, a protected append-only ledger, authenticated browser review and a versioned review API. MCP exposes preparation and review requests, never clinical approval. Browser role claims and dedicated request assertions establish interactive identity; qualified validation remains mandatory. [ADR-0015](decisions/0015-persisted-governance-and-interactive-human-approval.md) records this boundary. [OpenAPI](openapi/reviews.json), [governance](GOVERNANCE.md) and [deployment](REVIEW_DEPLOYMENT.md) describe its contracts.

## Project requirements and evidence graph

REQ-F17 adds shared services for versioned typed requirements, decisions, exact model anchors and governance evidence. Four MCP adapters expose conditional graph saves, reads, element explanations and requirement queries. [ADR-0016](decisions/0016-versioned-requirements-graph-and-evidence-boundaries.md) explains the separation of declarations, reference checks and clinical satisfaction. [The graph contract](REQUIREMENTS_TRACEABILITY.md) documents storage, limits and migration.

REQ-F18 adds separate document validation stages and exact-revision project QA through shared application services. Formal findings retain parse/profile errors, recorded evidence and unavailable engine checks independently. [ADR-0017](decisions/0017-staged-document-validation-and-project-evidence-qa.md) and [Validation and QA](VALIDATION_AND_QA.md) define contracts and migration.

REQ-F19 binds optional service credentials to configured CKM sources and exposes bounded federation through a knowledge port and shared application service. [ADR-0018](decisions/0018-source-bound-ckm-authentication-and-federated-discovery.md) records source identity, deadline and credential boundaries.

REQ-F20: `src/Mcp` bounds the supported protocol profile and SDK integration; clients retain negotiation and correlate responses. Production HTTP/stdio acceptance is independent of clinical services. See [MCP protocol](MCP_PROTOCOL.md).

REQ-N13 adds PostgreSQL governance and optional revision-bound Valkey retrieval caching. [ADR-0021](decisions/0021-postgres-governance-and-immutable-model-cache.md) keeps source, identity and audit authority independent of disposable caches.

REQ-F21: `NativeModels` and `TemplateBuilds` use the provider-neutral `OpenEhrEngine` port. The authenticated private Java adapter runs Archie validation/OPT 2 compilation, the bounded OET/OPT 1.4 compatibility adapter and native AQL parsing. Repository builds save native OPT content and exact-revision evidence atomically. [Compiler architecture and deployment](OPT_COMPILATION.md), [ADR-0020](decisions/0020-native-openehr-engine.md).

REQ-F22: `ModelImports`, `ArtifactTypeInspector` and the `OriginalRepository` port preserve external originals without conversion. A protected intent/receipt workflow records actual platform provenance; separate audit stream filtering prevents import records from entering governance transitions. [Workflow](MODEL_IMPORTS.md), [ADR-0023](decisions/0023-immutable-originals-and-import-receipts.md).

REQ-F23: the browser's `PersonalConnections` stores identity-bound encrypted configuration separately from enterprise settings. `WorkspaceTools` combines the core MCP catalogue with private CKM, repository and attachment operations. A selected personal destination removes enterprise write tools from that turn; confirmed Git API writes check the current file revision and use the user's token. These commits are drafts outside the enterprise governance ledger. `Attachments` preserves originals beside their owning conversation, extracts bounded text and prepares validated PNG/JPG images in a separate process. Paged text is tool-readable; prepared images are sent directly to both providers and served through private preview endpoints. Messages retain attachment metadata without inline image bytes. `Shares` stores fixed message-only snapshots behind revocable, expiring links that still require workspace authentication. [Browser chat](BROWSER_CHAT.md) owns usage, network policy and retention details.

REQ-F24: `CdrWorkspace` orchestrates actor-scoped encrypted connection/query metadata through `CdrAdapter`; `OpenEhrRestAdapter` implements standard read-only Query/Definition APIs with credential resolution and DNS-pinned transport. Browser CDR assertions are purpose- and request-bound; chat intercepts allowed CDR connection tools to preserve the human identity. AI execution and reads of query history or saved-query contents are blocked at browser and MCP boundaries; only the interactive browser Run returns rows. `AqlWorkbench` and the native engine inspect exact model paths independently of CDR execution. `RepositoryModels` loads profile-owned Git template packages at one immutable revision and checks dependency hashes; the UI and assistant tools share this source for query generation and validation. Editor completion uses only the inspected root model’s paths. An isolated `draftAql` provider session exposes only model-path search and validated draft submission, filling the sole AQL editor without reading existing queries, results or chat history. Query libraries are actor-and-environment scoped. `ModelCache` encrypts revision-pinned personal Git inputs on disk, rechecks upstream access, and bounds retention/size; native computations are rerun after deployment. See [CDR workspace](CDR_WORKSPACE.md) and [ADR-0024](decisions/0024-cdr-client-and-aql-workspace.md).

### Recoverable browser work (REQ-F23)

`Checkpoints` retains encrypted, bounded draft bytes and explicitly allowed modelling evidence per identity and conversation. `WorkspaceTools` exposes metadata, paged evidence reads and exact draft-ID saves; mutable destination checks and write confirmation remain live. `server.mjs` persists partial response state, tracks interruption reasons and keeps running work independent of the SSE socket. Authenticated conversation reads recover pending choices/approvals; after restart they mark abandoned runs interrupted without replaying writes. The UI reconnects by polling and offers continuation and private downloads. `Auth` persists organisation sessions encrypted and renews inactivity expiry only through a CSRF-protected activity request, capped at eight hours without changing sensitive-operation authentication age.

### Exact template repository packages (REQ-F23)

`TemplateAuthoringService` returns the exact ADL dependency bytes and hashes used to build each OET. Browser `TemplatePackages` retains those inputs in an encrypted, conversation-bound, bounded thirty-day cache and recompiles the package before confirmation. For new authoring, current project archetypes are read at one immutable branch head and passed into the generator ahead of CKM; save preparation refreshes these sources and rejects concurrent changes. Explicit CKM upgrades retain their source-selection intent and the pre-upgrade hash. Historical package reads keep their original pins. `PersonalConnections` prepares all file revisions from one Git commit, versions shared archetypes at stable paths, and commits the template, dependencies and relative hash manifest together through GitHub Git trees or GitLab commit actions. Non-forced reference updates and revision guards reject competing edits. Schema `/2` manifests pin immutable Git blobs and SHA-256 hashes so older packages retain their exact dependencies after current-path updates; legacy manifests recover dependencies from their verified manifest commit. Identical saves are reused, and generated OPT/Web Template filenames stay stable. [Artefact versions](ARTEFACT_VERSIONING.md) defines the default. Successful receipts register every file for project organisation; moves retain shared source archetypes for other templates. No package save conveys clinical approval.

### Native ownership and shared connections (REQ-F15, REQ-F23)

`IdentityStore` retains the original bootstrap owner, enforces MFA-gated self-registration and explicit shared-connection grants, and persists bounded failed-login counters. Recovery codes are stored as hashes; code recovery rotates password/MFA, clears lockout and revokes sessions atomically. `access.mjs` resolves current native grants from the store. Shared provider/repository credentials occupy an encrypted non-user namespace; request routes check management rights separately from usage. Providers prefer personal credentials; shared fallback requires current usage authority. Conversations, uploads and checkpoints keep their original identity scopes. Permission revocation cancels the user's active turns and AQL drafts.

### FHIR authoring provider and existing IG adapter (REQ-F26, REQ-F27)

`StandardsProvider` isolates standards-specific operations. `OpenEhrStandardsProvider`
wraps existing behaviour without rewriting the openEHR engine. `HttpFhirProvider`
connects to the private authenticated Node service, which owns exact package resolution,
FHIRPath, SUSHI and HL7 validation. `FhirModelling` owns release-pinned project
configuration, optimistic revisions, immutable imported copies, mapping proposals
and append-only operation evidence. Tenant namespaces and project access wrappers
are inherited; browser service credentials do not become user identity claims.

`FhirConnections` loads administrator-owned named destinations and secret references.
It uses the existing DNS-pinned bounded HTTP transport. The IG adapter maps to actual
project upload, health, status and exact Git commit import endpoints. It never
promotes a draft to a publication. The existing IG platform keeps its reviewed,
validated publication lifecycle. `fhir_ig` stores engineering artefacts, while
`openehr_FHIR_Modeller` stores application code. See [ADR-0026](decisions/0026-fhir-authoring-and-existing-ig-boundary.md).

### Bounded AI execution (REQ-F25)

`TaskOrchestrator` reconstructs task context from current project settings, repository identity/revision, selected artefact metadata and relevant persisted handoffs. `ContextBuilder` budgets priority classes and complete recent turns. `SessionManager` bounds logical context affinity while the existing provider adapters continue creating disposable native runtimes. `executionContext` provides demand-driven tool schemas, duplicate-free paged results and shared budget accounting without bypassing existing tool dispatch or write confirmation. `TaskLedger` extends encrypted browser persistence with separate task records and project draft/package archives; Git, traceability, deterministic validation and human governance remain authoritative. Independent review omits generator history and its retrieval tools. See [Task execution](TASK_EXECUTION.md) and [ADR-0025](decisions/0025-bounded-ai-execution.md).
