# Requirements — openEHR Modelling Assistant

> Part of the [Specification-Driven Development docs](README.md). Each requirement
> has a stable ID (`REQ-F#` functional, `REQ-N#` non-functional). IDs are
> referenced by [architecture.md](architecture.md), the
> [decision records](decisions/), and the [traceability matrix](traceability.md).
> When behaviour changes, update the requirement here **first**, then the design,
> code, and tests that cite it.

## Purpose

The openEHR Modelling Assistant exposes openEHR domain knowledge — archetypes,
templates, guides, examples, terminology, and Reference/Archetype Model type
specifications — to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io).
It is a *knowledge and authoring-assistance* server: it helps agents discover,
explain, design, and review openEHR artefacts. It is **not** a clinical data
repository and stores no patient data.

## Functional requirements

| ID | Requirement | Primary capability surface |
|----|-------------|----------------------------|
| **REQ-F1** | Search and retrieve archetypes and templates from the openEHR Clinical Knowledge Manager (CKM), with relevance scoring and result sizing. | Tools `ckm_archetype_search`, `ckm_archetype_get`, `ckm_template_search`, `ckm_template_get` |
| **REQ-F2** | Discover and retrieve implementation guides by category, and look up ADL constraint idioms. | Tools `guide_search`, `guide_get`, `guide_adl_idiom_lookup`; resource `openehr://guides/{category}/{name}` |
| **REQ-F3** | Discover and retrieve curated worked examples (AQL, FLAT, STRUCTURED payloads, gold-standard ADL archetypes). | Tools `examples_search`, `examples_get`; resource `openehr://examples/{kind}/{name}` |
| **REQ-F4** | Resolve openEHR terminology IDs, codes, and rubrics. | Tool `terminology_resolve`; resource `openehr://terminology` |
| **REQ-F5** | Look up Reference Model, Archetype Model, and BASE type specifications, including per-class attribute/function/invariant detail (BMM-backed). | Tools `type_specification_search`, `type_specification_get`; resource `openehr://spec/type/{component}/{name}` |
| **REQ-F6** | Provide guided MCP prompts for explaining, designing/reviewing, and exploring openEHR artefacts (archetypes, templates, AQL, simplified formats, terminology, type specs), plus ADL syntax fixing and translation. | `src/Prompts/*` (14 prompts) |
| **REQ-F7** | Expose retrievable resources for guides, examples, type specifications, and terminology via stable `openehr://` URIs. | `src/Resources/*` |
| **REQ-F8** | Offer argument auto-completion for guide names, example names, and specification components. | `src/CompletionProviders/*` |
| **REQ-F9** | Serve over two transports: `streamable-http` (default) and `stdio` (CLI/desktop clients). | `public/index.php`, `Helpers/CliOptions` |
| **REQ-F10** | Publish always-on server instructions encoding global tool-usage policy (Guide-First, Spec-Lookup-First, Digest-First, Examples-First). | `resources/server-instructions.md` |

## Non-functional requirements

| ID | Requirement | Rationale |
|----|-------------|-----------|
| **REQ-N1** | All openEHR-standard content must be grounded in authoritative sources (`specifications.openehr.org`, CKM, BMM); never invented from model memory. | Correctness of clinical/standards content is the product's core value. → [ADR-0005](decisions/0005-spec-aligned-content-retrieval.md) |
| **REQ-N2** | Every application class has a mirrored `*Test`; external HTTP (CKM) is mocked, never called live in tests. | Deterministic, offline-capable test suite. → [ADR-0002](decisions/0002-single-ckmclient-http-boundary.md) |
| **REQ-N3** | Code follows PSR-12 and passes PHPStan static analysis before merge. | Maintainability and reviewability. |
| **REQ-N4** | MCP capability discovery is cached at startup to keep server boot fast. | Responsiveness under repeated client connections. → [ADR-0001](decisions/0001-attribute-driven-discovery.md) |
| **REQ-N5** | The runtime is Docker-only and reproducible; no host PHP/Composer is assumed. | Consistent environment across maintainers (WSL2 on Windows). → [ADR-0004](decisions/0004-docker-only-runtime.md) |
| **REQ-N6** | Run the official MCP conformance suite against its explicit expected-failure baseline and separately verify the actual product tools over HTTP. | Interoperability with arbitrary MCP clients. |
| **REQ-N7** | Guide and prompt content is concise and scannable, optimised for AI context economy. | Content is consumed by agents under token budgets. → [ADR-0003](decisions/0003-prompt-policy-split.md) |
| **REQ-N8** | The requirement↔code↔test↔decision traceability map is machine-validated in CI; a missing artefact, dangling path, or index/map disagreement fails the build. | Keeps the SDD chain from silently rotting. → [ADR-0006](decisions/0006-machine-checked-traceability.md) |
| **REQ-N9** | Every published MCP tool schema is validated in CI: closed input schemas (`additionalProperties: false`, nullable optional enums, numbers bounded so out-of-range values are rejected rather than clamped), search results returned in a `{items, total}` envelope that is itself closed and `required`, and output payloads conforming to their declared `outputSchema`. Authoring recipe: [conventions.md](conventions.md#mcp-capabilities-authoring). | The SDK validates tool *input* against `inputSchema` but never validates tool *output*, so the output contract has no runtime enforcement — CI is the only thing standing between a schema edit and a broken wire contract. |
| **REQ-N10** | `docs/install.md` documents independent deployment of this fork and keeps all relative links resolvable. | The product does not require the upstream hosted service; ADR-0008 supersedes its installation contract. |

## Current extension boundaries

Native ADL 2/OPT 2 compilation and AQL syntax parsing are available through the optional engine. Exact-template structural AQL validation and read-only CDR execution are available in the dedicated workspace. Complete legacy OET/AOM coverage, full project/team RBAC and a visual editor remain separate work. See CAPABILITIES.md for exact scope. No model SDK or client plugin is required.

## Modelling platform requirements

| ID | Requirement | Implementation |
|---|---|---|
| **REQ-F11** | Configurable branding and named CKM sources. | landed; exact boundaries in CAPABILITIES.md |
| **REQ-F12** | Provider-neutral persistent projects, artifacts and revisions. | landed; exact boundaries in CAPABILITIES.md |
| **REQ-F13** | Draft OET generation, bounded validation and structural diff. | partial; exact boundaries in CAPABILITIES.md |
| **REQ-F14** | Optional local/FHIR terminology, canonical discovery, review-only translation, independent versions, explicit bindings and provenance. | partial; exact boundaries in CAPABILITIES.md |
| **REQ-F15** | Authenticated browser chat with MFA-gated native signup after owner setup, immutable owner-controlled shared-connection grants, five-attempt native sign-in lockout and email-free code/admin recovery, personal or explicitly authorised shared Claude/Codex/Copilot Studio connections, grounded tool calls, private conversation history grouped into user-managed chat projects, streaming and activity indicators, clickable single/multiple decision options, explicit confirmation of model writes and a built-in user guide available before sign-in. | landed; exact boundaries in CAPABILITIES.md |
| **REQ-N11** | Authenticated bounded transport and redacted failures. | landed; exact boundaries in CAPABILITIES.md |
| **REQ-N12** | Client-neutral deployment and truthful capability documentation. | landed; exact boundaries in CAPABILITIES.md |

| **REQ-F16** | Persist exact-revision governance and immutable audit events; permit clinical approval only through an independent authenticated human session after qualified validation, never through an AI/MCP caller. | `Application/ModelGovernance`, `Domain/Governance`, `Rest/ReviewApi`, browser review workspace |

## Queryable project requirements

| ID | Requirement | Primary capability surface |
|---|---|---|
| **REQ-F17** | Persist typed requirements, decisions and exact model/evidence links; answer element rationale and requirement coverage deterministically, with stale/missing/unexecuted evidence and declared clinical satisfaction kept distinct. | `model_traceability_*`, shared application/domain services and repository/audit contracts |

| **REQ-F18** | Separate deterministic document validation stages and formal QA findings; connect exact repository revisions to recorded provenance, requirements and authentic validation/review evidence without inferring release qualification. | `model_validate`, `model_qa`, `model_project_qa` and shared services |

| **REQ-F19** | Support source-bound CKM service authentication and bounded federated discovery with explicit source/version provenance, failures, result-window limits and no credential disclosure or source substitution. | `ckm_federated_search`, `CkmClient`, shared knowledge port/application service |

| **REQ-F20** | Negotiate supported MCP revisions, advertise only delivered capabilities and continuously verify actual HTTP/stdio discovery, prompts, resources, completion, errors and security boundaries. | MCP adapter and isolated product/official acceptance |

| **REQ-N13** | Support PostgreSQL governance with atomic, hash-preserving migration and optional bounded, tenant/revision-scoped model caching that cannot override authorization or audit authority. | AuditStore, immutable model reads and real service acceptance |

| **REQ-F21** | Compile validated ADL 2 templates into OPT 2 ADL and supported OET/ADL 1.4 into OPT 1.4 XML with explicit hash-pinned dependencies, revalidate serialized output, inspect native paths and parse AQL; atomically persist native builds and revision/compiler evidence without clinical approval. | Native engine port, private engine sidecar, MCP and project build service |

| **REQ-F22** | Preserve exact externally supplied original bytes, distinguish source declarations and format detection from conformance, record protected idempotent import provenance, reject original mutation and prevent imports from implying clinical approval. | `model_import_inspect`, `model_artifact_import`, `model_artifact_provenance`, original repository port and browser source download |

| **REQ-F23** | Provide profile-private CKMs without duplicating enterprise sources, personal GitHub/GitLab artifact destinations with persistent profile/project folder defaults, separate folders for every supported artefact type, default stable-path artefact versioning with hash detection, repository-first designer sources for template authoring and deliberate CKM upgrades, current/history/exact-version references, unchanged-save reuse and confirmed revision-conditional saves with exact archetype dependency packages for templates and previewed moves of a chat’s saved artefacts into its project folder, bounded source-file extraction and PNG/JPG interpretation with composer attachment previews for modelling, private recoverable draft/evidence checkpoints and resumable browser progress across interruptions without replaying unconfirmed writes, activity-based session continuity, and revocable read-only chat snapshots for authenticated workspace users. | Browser personal connections, attachment tools and snapshot sharing; limits in [browser chat](BROWSER_CHAT.md) |

| **REQ-F24** | Provide a separate AQL workspace with native syntax and exact-template path validation, model-derived queries, automatic revision-pinned template dependency loading, exact-path completion and assistant query drafting directly into the query editor from loaded artefacts, bounded encrypted revision-aware archetype caching, profile-private encrypted CDR connections, standard read-only Query API execution, cancellation, bounded results, user-and-environment-scoped saved queries/history and remote template inspection while prohibiting AI query execution, result access and reads of potentially identifying query-library contents; results are not persisted. | [CDR workspace](CDR_WORKSPACE.md), provider-neutral CDR adapter and controlled MCP tools |

## FHIR modelling extension

| ID | Requirement | Implementation |
|---|---|---|
| **REQ-F25** | Provide an isolated FHIR R4/R4B/R5 authoring provider with exact package dependencies, authoritative reuse discovery, typed FSH generation, real SUSHI/validator evidence, FHIRPath, semantic comparison, synthetic examples and versioned cross-standard mapping proposals. Preserve openEHR behaviour and separate clinical approval from computation. | `FhirModelling`, `FhirTools`, private `fhir/` service; Dev verification described in FHIR_DEV.md |
| **REQ-F26** | Prepare locally validated conformance artefacts and connect to the existing IG platform using its actual authenticated API and exact-commit Git import contract. Git is engineering source; the existing IG platform alone owns publication/distribution. Preserve actor, source, revision, digest, tool and validation evidence; never expose connection credentials as model configuration. | `FhirConnections`, private ledger, browser Git adapter; production promotion requires explicit user direction |

The source task is retained in [the implementation plan](plans/fhir-modelling/README.md).
Authoritative clinical choices cannot be inferred from tool success. Runtime
patient reads are outside the MCP boundary. FHIR workspace access follows the
configured MCP principal/project permissions; a shared service credential creates
a shared workspace, not per-browser-user isolation.
