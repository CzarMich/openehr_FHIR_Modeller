# Implementation and verification report

## Delivered scope

The standalone project is named **openEHR Modelling Assistant**, with repository `CzarMich/openehr-modelling-assistant` and directory `/home/hyq/workspace/openehr-modelling-assistant`. Original MIT copyright and attribution remain intact. The application is independent of the CDR checkout, upstream hosting, client plugins, model-provider SDKs and a CDR.

The implementation exposes 73 MCP tools, preserves all 14 original prompts, 91 concrete resources and three resource templates, and keeps the bundled guides, BMM definitions, examples and terminology. It adds configurable branding, named CKM sources, provider-neutral projects with persistent revisions, bounded validation/diff/draft OET services, explicit terminology/value-set/binding records and a local/FHIR provider boundary. See the complete [capability matrix](../CAPABILITIES.md) and [generated tool catalogue](MCP_TOOLS.md).

## Incremental changes

1. Captured the upstream surface and ran the baseline before refactoring: 536 tests / 2640 assertions, PHPStan and spec-check passing. Recorded the original dependency advisories.
2. Replaced runtime/vendor-specific naming with deployment settings, retained existing modelling resources/tool contracts, upgraded affected dependencies, and introduced domain/storage/terminology interfaces.
3. Added filesystem persistence and concurrency, secure XML/preflight/diff, source-grounded draft generation, explicit terminology records and conservative governance/QA policy.
4. Hardened transports, upstream clients, resource paths, logs and containers; corrected real SAPI Host duplication and unknown body-size handling found by HTTP integration tests.
5. Documented installation, configuration, environments, Microsoft/generic clients, tools, repository/terminology workflows, limits and future integrations. Added independent protocol/security probes and CI deployment automation.

## Executed checks

Execution metadata belongs in [evidence](evidence/), including the baseline and final command logs.

| Check | Result / evidence |
|---|---|
| PHP 8.4 unit and regression suite | PASS: 651 tests / 2978 assertions; `designer-unit-tests.txt` |
| PHPStan level 8 and requirement drift gate | PASS in the same final log |
| Composer dependency audit | No known advisories after compatible dependency updates |
| Production app/ingress and development image build | PASS; readiness confirmed through Caddy/FPM |
| HTTP initialization, all intended tools, prompts/resources/read/get and invalid inputs | PASS: `http-smoke.json`, `development-smoke.json` |
| Independent stdio initialization and tool discovery | PASS: `stdio.json` |
| Production API-key acceptance/rejection, Host/Origin enforcement, body limit | PASS: `http-security.json` |
| Startup and tools without CDR or external terminology | PASS: `authenticated-no-cdr-smoke.json` |
| Project creation, immutable revisions and stale-write rejection | PASS: `live-smoke.json` |
| Artifact content and history after container restart | PASS: `restart-persistence.json` |
| Live international CKM archetype/template search and retrieval | PASS: `live-smoke.json` |
| Draft OET generated from retrieved COMPOSITION/ENTRY archetypes | PASS for documented draft scope; no compilation/clinical approval |
| Live terminology server capability, lookup, CodeSystem validation, bounded expansion and ValueSet membership | PASS: `live-smoke.json`; service key kept outside the repository |
| Official MCP conformance suite | Expected-failure baseline passed: 8 checks passed, 23 failed as explicitly expected. This is not full suite conformance. See `mcp-conformance.txt`. |
| Microsoft tenant integration | NOT TESTED: no Copilot tenant test performed; official-source configuration is documented |

The official suite expects synthetic tools/resources/prompts not provided by this product, plus optional sampling/elicitation/subscription features. Its localhost-Origin success assertion conflicts with the deployment's default deny-browser-origin policy; its malicious Host assertion passes. Product-specific resource, prompt and tool paths are exercised separately. No baseline entry was added to hide a new failure.

Multiple named CKMs now have public international/Norwegian live discovery/retrieval evidence and isolated authenticated HTTPS contracts; organisation account acceptance remains separate. terminology server initially required an explicit `system` compatibility parameter for CodeSystem validation. The fix in `CzarMich/AmTerminology` is deployed to development, the server and Kubernetes. Live development/server probes verify GET/POST standard `url` validation, API-key authentication, browser-session ICD-10-GM lookup, Swagger security schemes and rejected credentials; see `amyterm-deployed-verification.json`. A service key sees its configured namespaces; a missing code is not proof of missing content for every user. No restricted expansion or patient content is committed as evidence.

## Validation and platform limits

XML well-formedness is deterministic. OET/OPT structural checks and ADL header checks are partial. The draft generator supports direct ENTRY placements and explicit parent-linked SECTION/ENTRY/CLUSTER/ELEMENT placement paths; generated drafts receive a bounded native compile check when the engine is configured. The optional native engine adds ADL 2/AOM/RM validation, pinned dependency checks, ADL 2-to-OPT 2 compilation and native AQL syntax parsing. The separate OET compatibility adapter compiles supported nested placements, original internal references, RM attribute refinements and finite existing-name narrowing to OPT 1.4 XML. Project QA verifies saved build evidence against the exact source, output and pinned dependency hashes. Complete OET editing, inherited/dependency semantic analysis, native binding application, and composition validation remain separate work. The optional [AQL workspace](CDR_WORKSPACE.md) now supports exact-template path checks, private CDR credentials and read-only execution; results remain outside chat, model repositories and query history. Compiler output does not bypass the existing governance qualification gate. Missing stages are NOT_EXECUTED and QA never marks a draft release-eligible.

Filesystem snapshots and generic Git storage are implemented. Git supports ordinary model files, GitHub/GitLab remotes, commit history, remote conflict detection and offline operation. Visual editing and model-release automation remain separate work. The generic openEHR REST CDR adapter is implemented as an optional client subsystem. Persisted human governance is implemented, with qualified validation still required before clinical approval. Native OIDC, signed draft-write permissions and tenant storage isolation are implemented with separate evidence below. Interfaces and rejection behaviour are documented; selecting an unsupported provider or incomplete OIDC configuration fails clearly. One API key is one deployment principal, not a human approval identity. Requirement coverage represents explicit links, not clinical correctness or executed tests.

## Deployment and operations

Target MCP endpoint: `https://openehr-modelling.sandbox.hygeoniq.com/mcp`. `.github/workflows/pr-validation.yml` gates delivery with tests/audit/image and protocol checks; `deploy-vps.yml` deploys only a successfully validated main SHA. `scripts/watch-ci.sh` watches every run for the exact commit and reports failures. The initial production rollout and all its GitHub checks succeeded. Exact accepted revisions, workflow links and environment results are recorded in `evidence/deployment.json`. Public live tools and integration checks passed in `deployed-live-smoke.json`. Public authentication, Origin and request-size checks are in `deployed-public-security.json`; the Host check runs separately against the deployed application listener in `deployed-listener-security.json`, because an invalid Host selects another virtual host at the shared public proxy. Security probes refuse redirects so credentials cannot follow a redirect to another host.

The server uses `/opt/openehr-modelling-assistant`, an existing valid wildcard TLS certificate, loopback-bound Compose services and a dedicated model volume. Runtime secrets live in `config/runtime.env`; local client credentials are in `/home/hyq/.config/openehr-modelling-assistant/client.env` with restrictive permissions. Secret values are never included here. See [deployment](DEPLOYMENT.md), [configuration](CONFIGURATION.md), [security](SECURITY.md) and [Microsoft integration](MICROSOFT_AGENT_INTEGRATION.md).

terminology server delivery now builds images on the hosted acceptance runner, transfers checksummed artifacts to the trusted publisher, then verifies GitOps, development and server rollout. It no longer rebuilds on the Kubernetes host. This followed a measured disk-pressure outage; raising guards, restoring ingress and reclaiming unused images/cache restored all cluster deployments. Cleanup preserved containers, persistent volumes and rollback images. Harbor garbage collection completed successfully. The exact cleanup counts are in the deployment evidence.

The active GitHub repository was recreated independently with a new repository identity, preserving Git history. GitHub confirms `fork:false` and no parent. The former fork is read-only at `CzarMich/openehr-modelling-assistant-fork-archive`; its deployment credentials were removed. Historical workflow evidence links point to that archive. Required MIT attribution remains intact. See [Archetype Designer integration](ARCHETYPE_DESIGNER_INTEGRATION.md) for the verified repository connection path and current adapter limits.

## Git and development integration

Real Git tests exercise local history, two independent remote writers, rejected stale writes, native-file round trips through an external Git client, rejected pushes without advancing the accepted local branch, branch/diff operations, remote history rewrites, symlink rejection and disabled writes. The authenticated development deployment uses Git with no external terminology server; its HTTP evidence verifies persistence, history, conflict rejection and empty terminology manifests. This is not evidence of a hosted Designer account connection or a clinical model round trip.

The shared authoring stage adds a configurable model root, native flat-file mapping and Unicode filenames. A real private Git repository and scoped deploy key verify bidirectional native ADL synchronization and stale-write rejection. Live testing also found and fixed an MCP metadata schema declaration that advertised an array instead of an object; the protocol regression suite and HTTP smoke checks now exercise metadata objects. Hosted Designer account access remains unavailable, so no UI round trip is claimed. See `evidence/designer-git-roundtrip.json`.

## Browser chat delivery

The optional browser client now provides OIDC sign-in, isolated persistent conversations, streamed model replies, visible modelling-tool activity, and confirmation of exact repository writes. It uses the existing MCP service through an isolated, pinned Codex runtime. Browser identity does not implement native inbound MCP bearer verification or project-level RBAC.

Verification includes 18 Node security/protocol/retention tests, four deterministic Playwright browser scenarios, and the unchanged PHP suite, PHPStan and traceability checks. Actual development-browser verification used the existing identity provider, Codex account and MCP service with TLS verification enabled. It exercised CKM tool results, follow-up context, explicitly confirmed project creation and draft persistence through the Git adapter, page reload, mobile layout and sign-out. Only synthetic modelling content was used. The runtime's supported tool configuration was checked repeatedly after identifying an unavailable tool-dispatch configuration in early testing.

Evidence: [live checks](evidence/browser-chat-live.json), [security/protocol tests](evidence/browser-chat-security-tests.txt), [browser fixture tests](evidence/browser-chat-ui-tests.txt), [desktop](evidence/browser-chat-desktop.png) and [mobile](evidence/browser-chat-mobile.png). Fixture tests are distinguished from live account/provider tests. The development chat is enabled; other environments keep browser chat disabled until an identity client and Codex account are configured. The default server deployment continues to expose the MCP service independently.

Three simultaneous live provider turns with actual MCP tool calls also pass; see [concurrency evidence](evidence/browser-chat-concurrency.json). This check exposed thread exhaustion under the original container allowance. Explicit provider worker-pool limits and a 512-task container allowance resolve the measured failure. The repeatable probe checks that all three turns finish without new task-limit denials.

See [browser chat](BROWSER_CHAT.md) for the user workflow, environment variables, credential provisioning, persistence, privacy, limits and repeatable checks. Complete legacy OET coverage, CDR and visual-editor gaps remain in the completion queue; the persisted human governance increment is documented below.

## Inbound OIDC authentication

The native HTTP adapter now validates issuer metadata, bounded JWKS retrieval/rotation, RS256 signatures, API audiences, time claims, signed client/scope/role/tenant restrictions and scoped draft writes. It isolates model storage by issuer/tenant and MCP sessions by principal. Distinct remote Git mappings preserve tenant history boundaries. Local and API-key configurations remain compatible. A bearer token never asserts a human approval, including when it carries an MFA claim.

Verification: 31 identity/security/real-Git cases, the complete 682-test PHP suite with 3055 assertions, PHPStan level 8, specification drift checks, dependency audit and production image build pass. [Live native OIDC acceptance](evidence/oidc-live-acceptance.json) uses three disposable clients and real signed access tokens from the available identity provider with verified HTTPS metadata/JWKS. It checks authorization, synthetic persistence, revision conflicts, tenant isolation, cross-principal sessions and malformed/forged credentials over the container HTTP endpoint. The separate [container acceptance](evidence/oidc-container-acceptance.json) uses a disposable HTTPS issuer and runs in CI without external credentials. This does not claim live Microsoft tenant acceptance. See [OIDC configuration](OIDC.md), the [capability backlog](COMPLETION_QUEUE.json) for remaining scope.

## Hosted repository completion

GitHub and GitLab modes now compose the existing Git storage with provider APIs for configured-repository metadata, paginated branches/protection, draft review creation/reuse and review revision metadata. Six MCP tools use a transport-independent application service and the existing write policy. Browser branch/review writes require exact-action confirmation. Repository selection follows the verified tenant mapping; hosting credentials and returned errors remain outside model content.

[Live GitHub evidence](evidence/hosted-github-acceptance.json) records metadata/branch reads, draft creation, duplicate reuse, revision retrieval and cleanup without changing the default branch. [HTTP evidence](evidence/hosted-http-smoke.json) exercises actual tool discovery, persistent drafts, branch creation, diffs and unsupported-provider errors. GitLab HTTP contract tests include nested group paths and draft semantics; live GitLab tenant acceptance remains unmeasured pending credentials. See [hosted repositories](HOSTED_REPOSITORIES.md) for setup, migration and repeatable tests.

## SharePoint repository completion

The SharePoint provider now implements project/artifact persistence, immutable revisions, metadata, history, tombstones, archive and remote conflicts. Filesystem and SharePoint share one snapshot-domain implementation; the filesystem on-disk layout remains compatible. Graph uses immutable candidate uploads and a unique, conditionally updated list pointer. Tests reject competing updates, forged metadata, altered snapshot bytes, cross-folder references, untrusted pagination/download destinations and malformed service credentials. A newly identified metadata-depth problem is fixed before saving across snapshot and Git providers.

[Production-container evidence](evidence/sharepoint-container-smoke.json) exercises real MCP operations against isolated HTTPS Graph/OAuth fixtures, including credential-free redirected downloads and terminology-free operation. The CLI harness independently checks historical reads, tombstones and synthetic project cleanup. This is fixture verification: live SharePoint tenant acceptance remains external pending account credentials/permissions. [Setup and repeatable tests](SHAREPOINT_REPOSITORY.md) document identifiers, provisioning, limits, migration and backup.

## Terminology protocol increment

The optional FHIR adapter supports ConceptMap translation, canonical CodeSystem/ValueSet/ConceptMap discovery, exact resource resolution, multilingual lookup and bounded expansion pages. It preserves repeated Parameters values and separates code-system, value-set and map edition evidence. Local snapshot checks no longer confuse value-set and code-system versions. Returned mappings are review candidates and never change a binding automatically.

[Production-container contracts](evidence/terminology-contract-smoke.json) exercise these operations through MCP and authenticated HTTPS. [Development acceptance](evidence/terminology-development-acceptance.json) and [server acceptance](evidence/terminology-server-acceptance.json) record actual provider support independently. Missing server search endpoints or an unavailable live ConceptMap are not converted into successful acceptance. Native binding application remains queued; the project terminology catalogue is implemented below. See [terminology configuration, response interpretation and migration](TERMINOLOGY.md).

The separately requested ICD-10-GM code was also probed with the authorized service principals: [development result](evidence/terminology-development-requested-dataset.json) and [server result](evidence/terminology-server-requested-dataset.json). Dataset visibility depends on principal and namespace; these probes do not establish availability for browser users. The successful core acceptance uses a code and expansion visible to the service principal.

## Project terminology catalogue

The application catalogue stores CodeSystem, multi-system ValueSet and ConceptMap records through every repository provider. It preserves canonical/edition identity, provenance, historical revisions and conditional draft writes. Pure local operations support explicit code membership, fragments, Unicode case rules, multilingual designations, bounded expansion and review-only mapping candidates. External references pin their recorded edition and never fall back to invented local success.

Repository contracts exercise filesystem, Git and stateful SharePoint storage. Actual MCP container checks cover offline operation, versions, candidate review and stale-write rejection. Browser saves require exact-record confirmation. Invalid external edits remain QA findings. The [catalogue guide](TERMINOLOGY_CATALOGUE.md) documents schema, limits, migration and repeatable checks; native model binding application and terminology approval/publication remain separate work.

[Catalogue verification](evidence/catalogue-verification.json), [Git MCP evidence](evidence/catalogue-git-smoke.json), [filesystem MCP evidence](evidence/catalogue-filesystem-smoke.json) and [SharePoint MCP evidence](evidence/catalogue-sharepoint-smoke.json) retain execution results. These are synthetic storage/protocol checks; they do not constitute clinical review or live SharePoint tenant acceptance.


## Revision-bound terminology binding plans

The [binding-plan service](TERMINOLOGY_BINDING_PLANS.md) inspects explicit OET/OPT coded choices, preserves named queries and canonical references, proposes project ValueSets from exact membership, and validates codes against explicitly pinned local CodeSystem editions. Plans retain source/catalogue revisions and detect source changes, new catalogue editions and modified analysis. Filesystem, Git and isolated HTTPS SharePoint contract runs pass. Browser saves confirm both source and plan revisions. Existing ambiguous relative targets now fail unless an exact revision-specific location is supplied.

The source model remains unchanged. Clinical suitability, binding strength, inherited ADL semantics, native application and compiler round trips are not inferred. These remain explicit review/qualified-engine gates. Tests and repeatable limits are documented in the binding guide; execution metadata is in `evidence/binding-verification.json`.

## Persisted human governance

The application now registers exact model revisions, executes the installed validator, requests independent review and records human review/approval/publication policy in a separate append-only ledger. Six MCP tools expose preparation and reads. A dedicated versioned REST adapter and OIDC browser workspace expose explicitly confirmed human decisions; ordinary bearer/API-key tools cannot approve. Audit sequences, source changes, assertion replay, tenant scope, roles and validation digests are enforced. Model metadata cannot supply authoritative approval or validation.

Real preflight remains incomplete and cannot qualify approval/publication. Positive lifecycle tests use a clearly labelled qualified validator fixture; this fixture does not qualify the installed native engine for clinical release. Repository contracts cover filesystem, Git and isolated SharePoint, and the production-container HTTP fixture verifies source inspection, human review, rejected approval, replay/stale-input protections and restart persistence. [Governance verification](evidence/governance-verification.json) records execution results; [governance](GOVERNANCE.md), [review deployment](REVIEW_DEPLOYMENT.md) and [OpenAPI](openapi/reviews.json) document use and limits.

Default browser builds contain the provider-neutral OIDC/review workspace. Conversational chat requires the explicit `chat` image target and separate provider credentials. The existing development chat deployment keeps that target.

The actual development HTTPS browser path passes OIDC sign-in, signed role mapping, source/evidence inspection and an explicitly confirmed synthetic review; the temporary reviewer account is removed afterward. See [live browser evidence](evidence/governance-dev-browser.json). The server browser client remains unconfigured because its available identity-administration credential was rejected; this is distinct from the implemented adapter and tested core deployment. No real clinical model was approved.

## Queryable requirements traceability

Four MCP tools now adapt shared project traceability services. A versioned graph records requirements, decisions, model/constraint/binding references and authoritative validation/review event hashes. Deterministic queries answer an element's explicit rationale trail and a requirement's declared model coverage. Reads verify pinned source identities, exact XML/JSON locations and tenant/project-scoped audit evidence, and report stale, invalid, unavailable or unexecuted references. Graph data cannot fabricate authoritative approval or passing validation.

Filesystem, Git and isolated SharePoint contracts cover conditional saves, historical queries and stale-source detection. Security cases cover incompatible/cyclic graphs, forged audit hashes, cross-tenant evidence, different-source validation, ambiguous JSON, unsafe paths and evaluation limits. Native inherited openEHR path resolution and clinical satisfaction remain qualified-engine/human-review concerns. See [the graph guide](REQUIREMENTS_TRACEABILITY.md), [verification](evidence/traceability-verification.json) and the independent MCP evidence under `evidence/traceability-*-smoke.json`.

## Staged validation and project QA

Document operations now separate parse, structure, semantics, terminology, openEHR conformance and repository policy. Bounded FLAT/STRUCTURED profiles and stronger template diagnostics complement read-only exact-revision project QA, recorded provenance and authoritative traceability evidence. [Verification evidence](evidence/validation-qa-verification.json) records the executed contracts; [Validation and QA](VALIDATION_AND_QA.md) documents remaining qualified-engine checks and migration.

## Authenticated and federated CKM discovery

Source-specific credentials, mounted secret rotation, bounded shared search time and distinct model/version provenance are implemented through the existing CKM HTTP boundary. [CKM documentation](CKM_SOURCES.md) explains authentication, configuration and result windows. [Public acceptance](evidence/ckm-public-smoke.json), [isolated HTTPS acceptance](evidence/ckm-container-smoke.json) and [verification metadata](evidence/ckm-verification.json) preserve their respective scopes.

MCP acceptance now gates the advertised product surface over real HTTP and stdio, plus applicable pinned official scenarios without expected failures. The SDK upgrade preserves error correlation, while explicit negotiation/capability configuration avoids unsupported push claims. See [protocol scope](MCP_PROTOCOL.md) and [verification](evidence/protocol-verification.json).

Browser chat and model governance share one verified human session. Review browsing and decision freshness have separate bounded lifetimes; the explicit platform-administrator role maps to all governance roles. See [review deployment](REVIEW_DEPLOYMENT.md#one-browser-identity-for-chat-and-governance).

## PostgreSQL and optional model caching

The shared audit contract now supports PostgreSQL with indexed tenant/project lookup, transaction-scoped append/replay locks, separate owner/runtime roles and immutable SQL enforcement. SQLite remains compatible; the offline cutover copies and compares canonical histories without changing hashes or timestamps. Model retrieval can use authenticated, bounded Valkey/Redis JSON entries keyed by authoritative repository revision. Cache failures use source reads, and lifecycle/authentication decisions bypass caching. The [storage guide](POSTGRES_AND_CACHE.md) documents configuration, backup and repeatable real-service acceptance. Synthetic retrieval timings in the evidence describe their workload; production capacity is not inferred.

## Unified browser workspace

The landing URL serves an integrated blue-and-white workspace with Chat, Models and Governance tabs. A read-only authenticated browser adapter calls fixed repository MCP tools; model source is escaped and revision context carries to the conversation without submitting automatically. Shared navigation preserves tab state and governance retains exact-revision confirmation. Browser tests exercise mobile/keyboard access, context preservation, error recovery and signed-in review.

## Native compiler and external modelling exchange

The optional engine compiles ADL 2 templates with explicitly pinned dependencies into native OPT 2 ADL. Native source/dependency checks, output reparsing and scoped AOM/RM validation precede a successful result. Seven MCP tools adapt shared application services. Saved builds retain exact input revisions, hashes, compiler identity, native validation and terminology-binding evidence atomically with the native output. They remain DRAFT and cannot grant clinical approval. Browser chat shows exact source/dependency revisions before saving a compiled build.

Synthetic tests cover nested EVALUATION/CLUSTER expansion, English/German terminology, binding URIs, annotations, byte-identical rebuilds, invalid embedded types, missing terms, ambiguity, unresolved slots and mixed RM releases. Container/MCP tests exercise the actual engine and repository save, without external terminology, Designer or a CDR. [Compiler documentation](OPT_COMPILATION.md), [engine evaluation](OPENEHR_ENGINE_EVALUATION.md), [execution evidence](evidence/engine-verification.json) and the [runtime dependency audit](evidence/ci-engine-dependencies-smoke.json) define the tested boundary.

Existing native-file storage and Git exchange preserve model bytes and history. The complete typed external import, canonical semantic model/diff, provenance graph, handoff/reconciliation and migration subsystem remains in the [exchange execution queue](EXTERNAL_MODELLING_REQUIREMENTS.json). Legacy OET-to-OPT 1.4 compilation now has a separate [bounded compatibility profile](LEGACY_OPT_COMPILATION.md); full OET/AOM semantics remain incomplete. Hosted Designer operations and round trips remain unverified; a file stored in Git is not evidence of semantic interoperability. The [integration architecture](MODELLING_TOOL_INTEGRATION.md) and [compatibility matrix](ARCHETYPE_DESIGNER_COMPATIBILITY.md) distinguish these states.

The [legacy compatibility adapter](LEGACY_OPT_COMPILATION.md) adds supported OET/ADL 1.4 compilation to OPT 1.4 XML. Tests preserve original local identifiers, multilingual terms, typed bindings, quantities, ordinals and bounded template refinements. Independent XML schema/RM structure checks run before saving. Unsupported constructs and full-AOM qualification limits remain explicit; neither Designer acceptance nor clinical approval is inferred. See [legacy execution evidence](evidence/legacy-compiler-verification.json).

The legacy compiler regression pipeline also compiles the repository’s existing archetype examples and assembles Encounter with Blood Pressure through actual MCP. Original source hashes, independent OPT XML checks and explicit missing-dependency rejection are recorded in `evidence/ci-engine-examples-smoke.json`; these tests do not establish clinical approval or external Designer round-trip compatibility.

Manual source import now preserves exact UTF-8/BOM/CRLF, other encodings and binary originals through filesystem, native Git and SharePoint contracts. Actual transport identity and stored source revision/hash are recorded in separate protected ledger streams; source-tool claims remain unverified. PostgreSQL/MCP tests cover retry recovery, immutable originals and governance separation. Browser tests cover exact-byte downloads. See [manual imports and limits](MODEL_IMPORTS.md). Retrospective migration, working-copy derivation, proprietary format conversion and release synchronisation remain pending.
