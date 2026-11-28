# Security and privacy

The platform handles clinical interoperability specifications and can process clinical records inside a private runtime. Those are different trust boundaries. Model-provider conversations, reusable models and ordinary MCP discovery must not become a secondary patient-data store.

The controls below describe implementation and required deployment practices. They are not a claim of universal interoperability, regulatory certification, independent penetration-test completion or absence of vulnerabilities.

## Golden rule: clinical source databases are read-only

**All direct clinical/source database access is strictly READ ONLY. MCP, agents, browser adapters, workers and channels must never write source records, change source schemas or permissions, run source migrations, or invoke write-capable procedures. There is no override.**

Use dedicated operator-provisioned read-only credentials, database-specific effective-permission checks and closed parameterized read operations. A driver hint is not enforcement. The SQL Server connector verifies certificate-validated encryption, metadata visibility and effective server/database/schema/object/column permissions, and rechecks before discovery. Unknown forbidden privileges fail closed. The platform does not change source permissions itself.

Write-denial tests use disposable synthetic databases only. Production verification must never attempt a clinical database write. The operator remains responsible for maintaining the source principal's privileges, network restrictions and approved query/replica policy. Read-only queries can still consume resources and create contention; enforce suitable bounds and concurrency.

The platform's own model, audit and private job stores are separate from clinical/source databases. Authorised FHIR destination delivery uses a distinct HTTP API credential and policy, never direct access to the destination's backing database. See [the full read-only policy](CLINICAL_DATA_READ_ONLY.md).

## Security and privacy control matrix

| Boundary | Implemented behaviour or required limitation |
|---|---|
| Source selection | Explicit versioned discovery jobs record connector/profile ID, purpose and original narrative. A selection record cannot grant extraction, mapping or delivery permission. |
| SQL Server discovery | Metadata-only operations with bounded discovery and fingerprint-bound structural plan checks. No arbitrary SQL, clinical-row MCP result or SQL polling channel is exposed. |
| Other source types | Oracle, PostgreSQL, MySQL, MariaDB, SAP HANA, Epic, SAP BW and other APIs have separate implementation/qualification states. A list entry does not establish connector support. |
| Source APIs | Only explicitly approved read operations and registered endpoints may be used. GET alone does not prove freedom from side effects. Vendor subscriptions/delta queues and arbitrary remote calls require separate qualification. |
| Clinical records | Records, retained context, validator details, quarantine and exports remain in owner-scoped private processing storage. They must not enter model Git, ordinary MCP calls or AI conversations. |
| AI providers | The optional browser sends selected conversation/context/tool results to the configured provider. The provider's terms and deployment policy govern that external processing. Do not submit patient data in conversation text or modelling attachments. |
| Metadata/dictionaries | Table names, field descriptions and dictionaries can themselves be sensitive. Authorise their disclosure to a model provider and treat retrieved instructions as untrusted content. |
| API keys | A shared deployment service principal; no individual user identity or tenant isolation is implied. Keep keys server-side or in client credential stores. |
| Native MCP OIDC | Signature, algorithm, issuer, audience, lifetime, client, scope and tenant checks. Project access additionally requires explicit project RBAC configuration and scopes. Sessions are bound to the authenticated actor/tenant. |
| Human decisions | Short-lived purpose/method/target/body-bound assertions, persistent replay nonces, verified roles and exact revisions. Ordinary MCP credentials remain non-human. |
| Models and mappings | User confirmation is required for exact supplied or agent-authored FHIR StructureDefinitions and applicable openEHR templates/rules. Technical validation and model selection are distinct from independent clinical approval/publication. |
| Destination delivery | Separate operator enablement, registered HTTPS FHIR destination, approved credentials, confirmed run, successful output validation, conditional create and durable receipt/reconciliation policy. |
| Encryption at rest | Selected credential/identity stores use application encryption. Model snapshots, conversations, operational files and backups are not all application-encrypted. Volume/database/backup encryption is an operator responsibility. |
| Network encryption | Hosted entry points and public destinations require certificate-validated HTTPS. Some private engine/service hops use authenticated HTTP on isolated networks; no blanket end-to-end TLS claim is made. |
| Lifecycle and locality | Retention, deletion, backup/recovery, residency, access reviews and provider policies must be configured for the deployment and jurisdiction. File permissions alone do not provide encryption or compliance. |

## Authentication and human authority

Production HTTP requires configured API-key or OIDC authentication; unauthenticated production access fails closed. API secrets need at least 32 characters and must remain outside Git and prompts. Stdio relies on the trusted local process and filesystem boundary. Configure exact allowed hosts/origins; CORS defaults to no browser origins. Public monitoring paths expose no model content and should remain restricted by infrastructure policy.

The OIDC adapter uses the official JWT bearer stack with a pinned HTTPS JWKS endpoint, allowed RS256 keys and explicit trust claims. Duplicate/invalid token JSON, unsupported algorithms and invalid identities are rejected. JWKS requests are bounded and cached. Repository tenant namespaces derive from signed identity claims. API keys and a browser's shared MCP credential must not be described as per-user repository isolation.

The browser backend verifies the human session and signs a purpose-specific assertion for an explicit action. The core binds it to the method, raw request target and body hash, consumes a persistent one-time nonce and checks roles/project scopes. Signing keys remain outside browser JavaScript and model-provider workers. Stable issuer identifiers and identity/encryption keys must survive upgrades. A role flag or agent statement cannot turn a service call into a human decision.

## Protected source profiles and drivers

Connection profiles are operator-managed files scoped to an exact tenant and projects. Jobs and agents use opaque profile IDs, never connection strings or secret paths. SQL profiles reject unknown fields, unsafe paths/symlinks and group/other-readable files. Mount secrets read-only with the required ownership and permissions; projected symlinks need an operator-controlled private staging step. Credentials are excluded from diagnostic representations and tool results.

The native SQL Server driver is pinned and audited. ODBC/JDBC and proprietary driver artifacts require separate licensing, fixed versions/checksums, protected mounts, restricted loading and synthetic permission/TLS acceptance. Agents cannot fetch, upload or execute arbitrary `.jar`, native driver or plug-in code. Driver support does not establish clinical qualification.

## Outbound APIs and untrusted content

CKM, terminology, repositories and destination endpoints are administrator-configured. Agents select configured source identifiers. Canonical model/terminology identifiers are not arbitrary retrieval URLs. Disable redirects, bound response bytes and time, validate pagination/origins, verify TLS, and restrict egress to approved hosts. The private CDR HTTP adapter additionally checks resolved addresses and pins socket connections. Do not infer that every outbound adapter has the same SSRF controls.

An operator CA bundle can establish additional private trust without bypassing hostname, lifetime or certificate-chain checks. Do not disable TLS verification to make a connector work. Tokens and headers must not follow redirects to another origin.

XML input rejects DTDs, external resolution and excessive size/complexity. Strict JSON parsing rejects duplicate-key ambiguity. Paths reject traversal/symlinks; repository writes use bounded immutable revisions and conditional updates. Documents, schemas, metadata and retrieved text remain untrusted: none can override application policy, select arbitrary destinations or establish approval.

Terminology operations support modelling evidence. Preserve requested/returned versions and source provenance, and report missing, ambiguous or inexact results. Do not silently invent codes, units, time zones or clinical meaning. Per-record enrichment needs explicit reviewed rules, a qualified execution path and private provenance. External terminology requests should contain only necessary codes/identifiers, without patient free text or unrelated clinical context.

## Repositories, audit and operational files

Filesystem snapshots use exclusive locks, compare-and-swap revisions and atomic replacement. Original imports preserve exact bytes and separate caller-declared claims from protected storage receipts. Git changes made outside the platform remain a trust boundary; provenance verification must compare exact revisions and hashes. SharePoint uses immutable candidates and conditional index updates, with provider-specific live acceptance required before deployment use.

The protected audit ledger resides outside model Git. Sequence checks, append-only controls, verified hash chains and one-time nonces guard normal application mutations. These controls do not prevent a privileged administrator replacing the database and recomputing history. Maintain consistent, separately protected backups and review operator access.

Private processing separates source reads, confirmed rules, validation, quarantine, export and destination delivery. A channel pins a mapping version and does not auto-adopt new drafts. Failed validation prevents output delivery; unknown destination outcomes require reconciliation. Retain operational data only for the approved period. Do not copy record-level diagnostics into general logs or reusable modelling artifacts.

## Deployment and ongoing assurance

Use non-root containers, read-only application filesystems, dropped capabilities, private service networking, protected secret mounts and bounded temporary storage. Keep Docker/Kubernetes administration outside model/provider workers. Build application images on hosted CI, verify immutable revisions on Dev and promote the exact cohort to production. Preserve persistent volumes, accounts, secrets and stable identity issuers during upgrades.

Application errors exposed to clients use fixed safe codes rather than raw database/upstream exception text. Infrastructure logs, URLs, filenames, tracing and external services require their own review; never place credentials or clinical values in those fields. The platform does not guarantee that every proxy or operator-added integration is configured to the same policy.

Run dependency audits and meaningful negative tests for authentication, replay, tenant/project boundaries, input ambiguity, source permissions and destination delivery. Maintain the tested-version/connector inventory and installation-specific acceptance evidence. Incident response, patching, rate limits, monitoring, backup restoration, high availability and jurisdiction-specific privacy obligations remain operational responsibilities.

See [source connector status](SOURCE_CONNECTORS.md), [database discovery](DATABASE_DISCOVERY.md), [architecture](ARCHITECTURE.md), [identity](IDENTITY_AND_ACCESS.md), [governance](GOVERNANCE.md), [private processing](INTEGRATION_ENGINE.md) and [production delivery](FHIR_PRODUCTION_DELIVERY.md).


## Private clinical identity state

The clinical-runtime branch adds an encrypted internal identity/dependency store, a mandatory verified patient prerequisite and a destination privacy policy pinned to each confirmed mapping. This SQLite store is platform state; clinical/source databases remain strictly READ ONLY without an override. Source trust and privacy changes require fresh authenticated human review and retain actor/version evidence. General MCP tools never return patient crosswalks, held records or private job results.

Back up the original operational encryption key with the encrypted store. The browser service will not create a replacement key alongside an existing identity database. A wrong key or integrity failure stops access. Do not reset this state to change a destination identity policy: after identity use, a reviewed migration is required. Pseudonymisation is not anonymisation, and output minimisation remains part of the approved mapping contract. See [HL7 and identity operations](HL7_AND_IDENTITY.md) for qualification and pending operational controls. These changes require release acceptance before being described as deployed.

## Clinical recovery and private originals

Clinical recovery is a separate authenticated human review API, never a general MCP patient tool. It requires an owned private job, current project write permission, approver/administrator rights, a fresh decision, the exact record revision and original source hash. Missing relationship resolution authenticates the configured destination and verifies the same Patient binding. The application retains original inputs unchanged and records identity/relationship corrections as audited processing overlays.

Before destination writes, the worker persists an encrypted complete delivery plan. An uncertain response or interrupted lease requires read-back reconciliation; the worker never blindly repeats the write. Read resource grants are distinct from destination create grants. Private received-source downloads recover only the owned stored original and do not publish it to models, shared monitoring or reusable AI context. These controls do not replace clinical approval, destination authorisation, retention procedures or installation qualification.

## Vendor source profiles and private extraction

Vendor connection credentials and private cursors are encrypted in the owner-scoped credential vault. Fresh authenticated source management/read authorisation is separate from model decisions. Read-plan/runtime pins are immutable; changed configuration, extractor binaries or schema require review. Source drivers execute only closed catalogue queries, compiler-generated parameterised SELECTs, session read controls or approved HTTPS read paths. Clinical/source DML, DDL, permission repair and write-capable procedures have no runtime operation or override. Authentication token POSTs are distinct from source data reads.

The private extractor rejects unverified permissions, invalid TLS, unknown types, incomplete source windows, foreign/unapproved paging and missing driver hashes. It preserves upstream pages encrypted and publishes intake only after full bounded-read completion. Exact cursor text is never converted through a JavaScript number, and cursor progress follows durable intake publication. Native/ODBC dependencies stay out of the file-mapping worker. Metadata disclosure also needs authorisation; neither browser source setup nor MCP discovery permits patient rows to enter model/provider context. See [vendor controls and acceptance](VENDOR_INTEGRATIONS.md). Security scanning and attack/load testing remain deferred.

### Proxy runtime log privacy

The ingress runtime logger deletes the complete request object before encoding errors. This covers custom service-key header names, cookies, identity assertions, addresses and request targets without relying on a fixed list of credentials. Diagnostic events retain the upstream, duration and error category. Access logging is not enabled by this setting. Rotate a service credential if an older unfiltered diagnostic exposed it; identity, approval-signing and encryption keys have separate purposes and must not be replaced as part of that rotation.

## Durable clinical integration storage

Clinical/source databases remain strictly **READ ONLY** for MCP, agents and workers, without an administrator override. Internal inbox/receipt/cursor writes are application storage, not source-database writes. Kafka consumers require topic read/describe and group-offset permissions only; broker commits acknowledge durably saved private intake and never modify source-topic data. Delivery uses separately authorised HTTPS FHIR/openEHR APIs.

Source credentials, exact cursors and Kafka retained originals are encrypted under purpose-derived keys from the preserved operational key. Admitted mapping snapshots and generated clinical outputs are private operational files; volume/backup encryption and retention remain mandatory installation responsibilities. Destination tokens are materialised only in private ephemeral runtime files for the worker and removed at shutdown. Human review responses and group monitoring omit credentials and patient values.

An unknown destination write remains reserved across restart. Do not clear reservations or delete duplicate receipts to force reprocessing. Restore keys, input snapshots, cursors and receipts consistently; broker offsets alone cannot recover the application. Heap/queue/prefetch caps are admission controls, not a security-scan or throughput claim. Security/intrusion/load testing remains deferred. See [integration operations](INTEGRATION_ENGINE.md).
