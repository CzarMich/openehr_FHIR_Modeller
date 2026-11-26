# Security model

HTTP production startup requires API-key or native OIDC authentication. Generate a high-entropy secret of at least 32 characters, store it outside Git, configure clients through their credential store and rotate by recreating the application and updating clients. API keys represent one deployment service principal and do not provide user/tenant isolation. Native [OIDC](OIDC.md) verifies access tokens, isolates signed tenants and enforces draft-write scopes/roles; project-scoped repository access additionally requires PROJECT_RBAC_ENABLED and assigned project scopes. Stdio relies on local process permissions.

The guard validates Host and Origin independently, rejects unexpected body sizes and checks keys with constant-time comparison. SDK DNS-rebinding middleware remains active. CORS defaults to no browser origins. Production `AUTH_MODE=none` fails closed; native OIDC rejects missing configuration, invalid signatures, mismatched trust claims and unauthorized scopes/roles. An API gateway can add enterprise identity and rate limits while forwarding an application key. Health/readiness contain no model content and should remain on a restricted monitoring path.

External CKM and terminology endpoints are administrator-configured HTTPS origins. Tools select source names rather than arbitrary URLs. Relative path validation, bounded requests/responses, TLS verification, disabled redirects and timeouts limit outbound exposure. Use network egress controls to restrict configured destinations; this is not a general DNS/IP anti-SSRF resolver. A CA bundle supports enterprise certificates without disabling TLS validation.

XML rejects DTDs, entities, network resolution, oversized bodies and excessive elements. Artifact roots/paths reject traversal and symlinks. Repository contents are untrusted: notes, metadata and retrieved text cannot authorize a tool, prove approval or override client instructions. Do not submit patient data to this modelling service. No LLM inference or telemetry endpoint is embedded in the runtime.

JSON logs allowlist request metadata and omit tool arguments, bodies, secrets and exception traces. Infrastructure access logs may contain request URLs; clients should not put credentials or clinical content in query strings. Protect Docker access, secret files and model volumes. Non-root containers run with a read-only root filesystem, dropped capabilities, temporary scratch storage and private FPM networking. TLS termination, rate limiting, backup encryption, monitoring and HA remain deployment responsibilities.

Validation scope is a safety boundary: malformed/unavailable upstream responses never become successful validation, missing stages remain NOT_EXECUTED, and preflight cannot approve a clinical model. See [governance](GOVERNANCE.md). Dependency audit and executable security cases are part of [testing](testing.md).

## Browser chat

The optional [chat service](BROWSER_CHAT.md) validates OIDC identity independently of MCP authentication. It uses same-origin CSRF checks, opaque secure cookies, private per-user conversations and a fixed tool allowlist. Its shared MCP service credential stays server-side. Each repository write requires a browser confirmation bound to the current user, conversation and exact proposed arguments; it is not clinical approval. Personal provider connections are encrypted and bound to the verified user; provider workers use a shared connection only when the native platform owner has explicitly granted usage. Registration starts without shared-provider access, private credentials take precedence, and shared management is separately authorised and audited. The isolated browser container has no host workspace or Docker socket and exposes no shell, image or delegation tools. The browser MCP client uses a deployment service principal: browser sign-in alone does not give it per-user repository scopes. Model visibility follows that service identity unless a separately verified user-scoped adapter is configured. Native MCP OIDC is implemented separately and does not turn the chat client's shared service key into a user token.

Hosted repository APIs derive their repository identifier from the tenant-scoped Git remote. They use pinned HTTPS origins, bounded responses, no redirects and redacted errors. Tokens remain deployment secrets, separate from SSH keys. Metadata queries cannot enumerate other repositories. Draft review requests require authorized model-write access and do not create clinical approvals. See [hosted repository security](HOSTED_REPOSITORIES.md#failure-and-security-contract).

SharePoint requires a unique project index and ETag-conditional pointer updates. Snapshot digests and folder/project identity are checked before returning content. Graph bearer tokens never follow download redirects; exact download hostnames are deployment configuration. OIDC tenants require distinct lists/folders. Shared artifact metadata validation rejects excessive nesting before saving, preventing unreadable revisions. See [SharePoint security and recovery](SHAREPOINT_REPOSITORY.md).

FHIR calls stay on the configured terminology endpoint. Canonical identifiers and search pagination links are never fetched as arbitrary URLs; redirects and cookies are disabled. Response bytes, JSON nesting, parameter trees and expansion traversal are bounded. Repeated singleton results, inconsistent translation results and version substitutions fail closed. Clinical mapping candidates always retain human-review requirements and never apply a binding.

Binding-plan inputs are bounded and XML entity expansion is prohibited. Canonical identifiers are never fetched during local planning. Server-generated evidence cannot approve models, and source/plan revisions are separate. Ambiguous relative binding targets fail; positional locators apply only to the recorded source hash. Repository evidence is not a signed attestation.

Human decisions use a separate authentication purpose: the browser backend signs short-lived method/target/body-bound assertions after verified OIDC sign-in. The core consumes each nonce once in persistent storage. The signing key stays outside browser JavaScript and model-worker environments. Native MCP bearer/API-key identities remain non-human. Role claims alone do not promote an agent into a clinical approver; the review UI requires explicit confirmation, and approval additionally requires independent identity and qualified exact-source validation. See [the governance trust boundary](GOVERNANCE.md) and [review deployment](REVIEW_DEPLOYMENT.md).

Audit events reside outside model repository paths, with append-only SQL triggers, sequence compare-and-swap and verified hash chains. These controls do not protect against a privileged operator replacing the database and recalculating its entire history. Backups must preserve SQLite consistency and be retained separately from model storage. External signed attestations remain later work; project scopes are configurable and must be enabled rather than inferred from browser sign-in.

Requirements graphs are bounded, typed draft records. Unknown fields, duplicate IDs/edges, incompatible links, cycles, unsafe paths and missing provenance fail validation. XML positions are not executed as XPath; JSON anchors reject duplicate-key ambiguity and invalid pointer tokens. References cannot supply network destinations. Audit lookups use the authenticated tenant/project and exact hashes, and validation/review links must identify the same model source. Graph content and declared coverage never grant authoritative validation or clinical approval. [Traceability limits and trust](REQUIREMENTS_TRACEABILITY.md#findings-and-trust) remain part of the API contract.

Document QA never fetches schema hints or executes supplied XML/JSON/path content. JSON rejects duplicate keys and escaped aliases; parsing, diagnostics and graph evidence have explicit bounds. Project QA resolves validation/review events in the caller tenant and matches exact model identity, including when a graph also links another binding artifact. Recorded provenance and requirement links never manufacture clinical approval. See [Validation and QA](VALIDATION_AND_QA.md).

CKM credentials are per-source deployment service identities. Secret files are deployment-selected, read-only mounts; agents cannot provide paths or arbitrary destination URLs. Authentication profiles reject unsafe headers, duplicate JSON keys and redirects. Discovery/results never contain secrets or raw upstream errors. Inbound user identity does not automatically delegate private CKM entitlements. See [CKM sources](CKM_SOURCES.md).

The MCP wire gate tests allowed and forbidden origins, hosts, malformed payloads, finite bodies and terminated sessions. Only explicit nonproduction loopback HTTP browser origins are accepted; production browser origins and external service destinations require HTTPS. The private FHIR engine and explicitly allowlisted IG adapter may use HTTP on isolated container networks; the IG adapter additionally requires `FHIR_ALLOW_HTTP=true`. This exception does not permit public HTTP origins or disable external TLS verification. See [MCP protocol](MCP_PROTOCOL.md) and [FHIR connection configuration](FHIR_DEV.md#configuration).

Browser chat and model governance share one verified human session. Review browsing and decision freshness have separate bounded lifetimes; the explicit platform-administrator role maps to all governance roles. See [review deployment](REVIEW_DEPLOYMENT.md#one-browser-identity-for-chat-and-governance).

## PostgreSQL and optional retrieval cache

See [PostgreSQL and cache deployment](POSTGRES_AND_CACHE.md) for the private service stack, restricted database role, migration preserving audit hashes, immutable-revision cache keys, outage fallback and backup/recovery procedure. `GOVERNANCE_DATABASE_PATH` is used only with the legacy SQLite driver. Authorization and clinical decisions always use authoritative state.

The native openEHR engine accepts fixed authenticated content-only operations, checks Host/Origin and JSON ambiguity, and limits input/output, worker heap, concurrency and execution time. Its private service key is separate from browser/LLM credentials. Model source cannot select retrieval URLs or execute code. Compiler evidence is not human approval. [Engine deployment](OPT_COMPILATION.md).

The legacy compiler treats OET and ADL 1.4 as untrusted input inside the existing disposable engine workers. XML parsing rejects DTDs, external entities and external schema resolution; the pinned SDK supplies the output schema. Ambiguous paths/slots, widening and unsupported constructs fail closed. Large escaped XML in JSON uses a bounded linear duplicate-key scan rather than a recursive regex. Compiler profile success cannot approve a model.

External originals remain untrusted, even with a claimed source-tool identity. Imports perform bounded local inspection, never fetch caller URLs or extract packages, reject unsafe filenames/forged provenance fields, and preserve syntax-failing source with findings. Protected receipts bind actual transport identity to exact stored bytes. Other Git clients remain a write trust boundary; mismatched revisions/hashes fail provenance verification. API-key and shared browser MCP calls remain service identities. [Import security and limits](MODEL_IMPORTS.md).

## Golden rule: clinical databases are read-only

**Every direct clinical/source database connection is read-only.** The MCP, agents,
workers and channels must never insert, update, delete, alter schemas, run source
migrations or invoke write-capable procedures. Use read-only credentials and
server-enforced read-only transactions; fail closed if enforcement is unavailable.
FHIR delivery uses a separately authorised FHIR API, never its backing database.
See [the clinical database policy](CLINICAL_DATA_READ_ONLY.md).


## Security and privacy control matrix

These statements describe the current implementation and required deployment
controls. They are not a certification or a claim of automatic regulatory compliance.

| Boundary | Implemented behaviour or precise limitation |
|---|---|
| Clinical/source databases | Read-only is mandatory across MCP, agents and runtime. SQL extraction/drivers are not implemented yet; there is no claimed driver-specific read-only enforcement. Future adapters must pass the golden-rule contract before support is advertised. |
| Existing CDR queries | Read-only query operations through configured connections; source access is not permission to write clinical records. |
| FHIR destination delivery | A separately authorised FHIR HTTP API operation, not a direct backing-database connection. Operational delivery is still under implementation; synthetic previews emit zero records. |
| API keys | One deployment service principal. They do not identify individual users or establish tenant isolation. |
| Native MCP OIDC | Verified token/tenant boundaries; project repository scopes require explicit configuration. Browser sign-in does not turn its shared MCP credential into a user token. |
| Human decisions | Purpose-bound, short-lived assertions, consumed nonces, roles and exact revisions. Model selection is distinct from independent clinical approval/publication. |
| AI providers | The optional browser sends selected conversation/context/tool results to the configured provider. The provider connection, terms and deployment policy determine that external processing. Do not submit patient records as chat messages or modelling attachments. |
| Processing data | Operational records, exports, validation detail and quarantine belong in a separate private runtime. This is a required boundary for the runtime under implementation, not proof that operational processing is already delivered. |
| Encryption at rest | Personal provider credentials and selected identity/session stores use application encryption. Model snapshots and conversation/history files are not generally application-encrypted. Do not assume processing files, PVCs or backups are encrypted; volume/database/backup encryption is an operator responsibility. |
| Network encryption | Hosted browser/MCP entry points require authenticated HTTPS. Some private compiler/service hops use authenticated HTTP on isolated networks; there is no blanket end-to-end TLS claim. Outbound public destinations must verify TLS. |
| Logging | Application request logging allowlists metadata. Infrastructure/access logs, retention, backups and any external services need separate operator review. Avoid credentials or clinical values in URLs, filenames and diagnostic messages. |
| Data lifecycle | Configure access, retention, deletion, backups and recovery for the actual deployment and provider. Private file permissions alone do not establish encryption, data residency or compliance. |
| Compliance/security assurance | No HIPAA/GDPR certification, independent penetration-test completion or universal absence of vulnerabilities is claimed by these controls. Supported dependencies, audits and tested boundaries require ongoing maintenance. |

The golden rule concerns direct clinical/source database access. The modeller
still writes its own separate model and audit stores, and the integration design
needs private queues/checkpoints. Those stores must not be placed inside a
clinical/source database. Keep source-read and destination-write credentials and
permissions separate. See [the full policy](CLINICAL_DATA_READ_ONLY.md).
