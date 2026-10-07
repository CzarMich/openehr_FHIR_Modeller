# Capability matrix

WORKING means the described subset is implemented; it does not imply clinical approval. Statuses describe delivered functionality on the main branch. Execution evidence and environment limits are in [the implementation report](docs/IMPLEMENTATION_REPORT.md). Planned work is tracked in the [capability backlog](docs/COMPLETION_QUEUE.json).

| Capability | Status | Implemented boundary |
|---|---|---|
| MCP HTTP and stdio; discovery, prompts and resources | WORKING | Explicit version/capability profile with production HTTP/stdio product probes and applicable official scenarios; no model SDK |
| Branding and named CKM selection | WORKING | Administrator-configured HTTPS sources and source-specific Basic/session/bearer/API-key credentials; same CKM REST contract |
| Federated CKM discovery | WORKING | Bounded lexical/status ranking, distinct source/version provenance, per-source failures and honest window totals; public international/Norwegian and isolated authenticated acceptance |
| Existing CKM, guide, examples, terminology and type tools | WORKING | Upstream features retained |
| Persistent projects, artifacts, metadata and history | WORKING | Filesystem/SharePoint snapshots or plain files in Git; expected revisions and opt-in writes |
| Project terminology catalogue | WORKING | Versioned local CodeSystem, multi-system ValueSet and ConceptMap records; repository revisions, deterministic search and explicit external references |
| Local terminology operations | WORKING | Offline lookup, membership, expansion and review-only mapping candidates; independent editions, language, fragment and hierarchy rules |
| Modelling without terminology server or bindings | WORKING | Authenticated Git persistence, local checks and empty terminology manifests verified over HTTPS |
| External FHIR terminology (optional) | WORKING | Capabilities, multilingual lookup, code/value-set validation, bounded expansion and version evidence; provider-dependent datasets |
| FHIR ConceptMap translation | WORKING | Explicit map and source coding; repeated candidates retained, human review required, no automatic application |
| FHIR terminology resource discovery | WORKING | Configured-server CodeSystem/ValueSet/ConceptMap search and exact canonical resolution; server search support required |
| Draft OET generation | PARTIAL | Retrieved COMPOSITION with direct ENTRY placements or explicit parent-linked SECTION/ENTRY/CLUSTER/ELEMENT placement paths; generated drafts are compile-checked against the exact retrieved ADL bytes when the engine is configured; slots and full authoring semantics remain bounded |
| OET/OPT validation | PARTIAL | Separate parse/structure stages, typed OET root/placement identity checks, identity/reference syntax and overflow-safe intervals; engine adds OPT 1.4 XML schema/RM structure and supported OET dependency compilation; exact paths, inherited constraints and full legacy semantics remain incomplete |
| FLAT/STRUCTURED document profiles | WORKING | Unambiguous JSON, field/array/raw-value shapes and explicit stage findings; OPT/RM/terminology conformance remains unexecuted |
| ADL validation | WORKING for ADL 2 | Native Archie grammar/AOM/BMM/RM checks with explicit dependencies; legacy compiler additionally parses ADL 1.4 and checks its documented RM structure profile |
| Model diff | PARTIAL | Structured XML changes classified by archetype/node identifiers, RM types, paths, cardinalities, constraints, terminology, language and other explicit dimensions; uniquely identifiable explicit placements can be reported as moved, while inherited/dependency semantics are not resolved |
| Binding validation | PARTIAL | Explicit records, path presence, selected-code validation; no native application |
| Explicit XML terminology inspection | WORKING | Bounded OET/OPT coded choices, named queries and native reference preservation; revision-specific locations, without inherited ADL semantics |
| Terminology binding plans | WORKING | Offline exact-membership proposals, explicit aliases, pinned local code validation, repository history and stale-evidence detection; review required |
| Terminology impact and manifest | PARTIAL | Concept/property diff, explicit parent-edge comparison when supplied and declared dependencies; no inferred hierarchy or cross-model index |
| Requirements traceability | WORKING | Versioned typed graph, deterministic element/requirement queries, exact XML/JSON anchors, authoritative audit references, stale-evidence findings and repository conflicts; coverage remains a modeller assertion, with native inherited paths awaiting the engine |
| Persisted model governance | WORKING | Exact-revision lifecycle, server-produced validation evidence, append-only audit chain, sequence conflicts and independent human decisions; real approval remains blocked until qualified validation is available |
| Browser human review and versioned review REST API | WORKING | Source/evidence inspection, role-based decisions, explicit confirmation and single-use request-bound assertions; ordinary MCP credentials cannot approve |
| Project QA and evidence checks | WORKING | Exact revisions, hash/freshness, recorded provenance, requirement trails, authoritative validation/review links and explicit terminology findings across storage providers |
| Full model QA and release qualification | PARTIAL | Formal findings include exact-source saved compiler evidence with output/dependency hash verification; missing model-aware, terminology, clinical and release checks remain NOT_EXECUTED and release eligibility stays false |
| API-key authentication and hardened containers | WORKING | One deployment principal, single tenant; enterprise gateway required |
| Native inbound OIDC | WORKING | Pinned issuer/API audience, discovery/JWKS, RS256 verification, bounded rotation and signed scopes/roles; live identity-provider acceptance, Entra-style fixture coverage |
| Tenant storage and draft-write authorization | WORKING | Issuer/tenant namespaces, principal-bound sessions, scoped writes and distinct mapped Git remotes; API-key mode remains one service principal |
| Enterprise project/team RBAC | PARTIAL | Opt-in OIDC project read/write scopes enforced at the shared repository boundary and propagated to human review; identity-provider team mapping is required and in-app membership administration remains separate work; see [OIDC configuration](docs/OIDC.md) |
| Git storage with GitHub/GitLab/other remotes | WORKING | Plain model files, commit history, remote sync, CAS updates; MCP branch creation and revision diff |
| Archetype Designer repository layouts | WORKING | Configurable content root; category folders or flat native files; Unicode/spaces preserved; real private Git round trip |
| Hosted Archetype Designer UI connection | NOT TESTED | Login required; repository integration verified independently, account linking and visual import/export not yet verified |
| Codex development connection | WORKING | Installed Codex app-server initialized the HTTPS service and discovered the modelling tool catalogue using the configured authentication headers |
| Browser modelling chat | WORKING | OIDC sign-in, private persistent conversations, streamed replies, actual tool activity and confirmed draft writes through personal provider connections; optional service |
| Copilot Studio browser provider | IMPLEMENTED | Delegated Microsoft sign-in, profile-private tokens, published-agent replies and native workspace client tools; SDK/security/browser fixtures verified, target-tenant sign-in and tool acceptance required through [setup](docs/COPILOT_BROWSER.md) |
| Browser identity and session isolation | WORKING | Authorization code flow with PKCE, signed identity claims, secure cookies, CSRF and per-user conversation ownership; shared model repository principal |
| Native browser user management | PARTIAL | One-time owner bootstrap, password+TOTP login, recovery, invitations, role administration, revocable sessions, service credential lifecycle and chained audit; single-instance local storage, no email/passkeys or shared transactional identity backend |
| Unified browser workspace | WORKING | Root URL serves Chat, Models, Governance and role-gated Accounts tabs with shared identity and preserved conversation/draft state |
| GitHub/GitLab hosting capabilities | WORKING | Shared Git storage plus configured-repository metadata, branches/protection and draft reviews; live GitHub acceptance, GitLab contract tests |
| GitLab live hosted acceptance | NOT TESTED | Adapter and contract tests implemented; requires a configured GitLab account/token |
| SharePoint storage | WORKING | Graph-backed immutable snapshots, conditional index updates, revisions/history/metadata and tenant mappings; OAuth and production-container contracts verified |
| SharePoint live tenant acceptance | NOT TESTED | Implementation and integration harness complete; requires external tenant credentials, identifiers and permissions |
| ADL 2 template compilation and OPT 2 validation | WORKING | Archie 3.20.0, pinned dependencies, nested archetypes, revalidated serialization, deterministic output and atomic native-file/build evidence persistence; [profile](docs/OPT_COMPILATION.md) |
| Legacy OET-to-OPT 1.4 compilation | PARTIAL | Working explicit OET/ADL 1.4 compatibility profile: nested slots, reused nodes, RM attribute narrowing, finite existing-name narrowing, original terms, schema/RM output checks and saved DRAFT evidence; complete legacy AOM/OET semantics remain incomplete; [limits](docs/LEGACY_OPT_COMPILATION.md) |
| Manual source import and platform provenance | WORKING | Exact text/binary originals in filesystem/Git/SharePoint, protected intent/receipt ledger, idempotence, format assurance and verified source download; [boundaries](docs/MODEL_IMPORTS.md) |
| External-tool semantic exchange and release synchronisation | PARTIAL | Exact original preservation, structured bounded XML comparison and caller-declared external release-status provenance; proprietary conversion, verified semantic round trip, retrospective migration and external release sync remain pending |
| Full native template editing/terminology application | NOT IMPLEMENTED | Separate editor/binding work; Designer authoring JSON is never relabelled as OPT |
| AQL syntax parser | WORKING | Native openEHR SDK 2.35.0 grammar/AST, independent of a CDR |
| Template-aware AQL paths | WORKING | Exact OPT 1.4/OPT 2 structural and RM paths; unsupported constructs explicitly INCOMPLETE, no value/function/clinical assurance |
| AQL workspace and CDR query execution | WORKING | Private encrypted connections, read-only Query API, cancellation, table/JSON/raw views, saved queries and history; [scope](docs/CDR_WORKSPACE.md) |
| Composition validation and CDR deployment | NOT IMPLEMENTED | No clinical data persistence or model deployment operations |
| Copilot Studio tenant connection | NOT TESTED | Current official deployment guide; no tenant available |
| Visual editor | NOT IMPLEMENTED | Architecture prepared |
| General REST application API and CLI | PARTIAL | Versioned project/artifact REST endpoints with OpenAPI, optimistic revisions, project archival, shared repository authorization, and a Composer model CLI; broader application operations and OIDC-interactive CLI support remain; see [API and CLI guide](docs/MODEL_API.md) and [isolated OIDC acceptance](docs/evidence/model-api-oidc-smoke.json) |
| Optional client packaging | WORKING | Default browser review image contains no model-provider executable; conversational adapter uses an explicit image target |

Chat and model governance share the verified browser identity. Explicit platform-administrator permissions cover all governance roles; validation and human-review policy still govern transitions. See [review deployment](docs/REVIEW_DEPLOYMENT.md).

PostgreSQL governance storage and optional Valkey/Redis model retrieval caching are implemented. SQLite migration preserves event bytes, hashes and nonce history. Cache invalidation follows authoritative revisions; cache failures fall back to model storage. See [deployment and acceptance](docs/POSTGRES_AND_CACHE.md).

The [browser workspace](docs/BROWSER_WORKSPACE.md) integrates Chat, exact-revision model browsing, Governance and local account administration in one responsive interface with keyboard navigation. This is a model browser and review workspace; full visual model editing remains separate implementation work.

Browser AI tasks use configurable context budgets, selective tool schemas and lossless result paging. Private project task records, exact drafts, dependency packages and validation evidence persist separately from chat history. Independent review excludes generator transcripts and recovery tools; Git, the existing decision graph and human governance remain authoritative. Provider token counts are approximate unless reported; this adds no unsupported FHIR profile/IG engine or external-client session management. See [task execution](docs/TASK_EXECUTION.md).
