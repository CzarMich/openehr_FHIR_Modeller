# Clinical integration: configuration and operation

openEHR Modeller executes confirmed, deterministic clinical mappings on private data. Use it to capture records from reviewed databases/APIs or Kafka topics, process files, validate outputs, and deliver to authorised FHIR or openEHR HTTP destinations. Assign a mapping to a channel for continuous polling. Record processing does not call a language model.

The application/domain and private workers use C#/.NET 10. The Node browser backend owns sessions, channel scheduling and private intake. Specialised openEHR/FHIR engines validate clinical outputs. This guide describes implemented behaviour; successful hosted image acceptance and promotion are required before a source revision is available in an environment. Synthetic acceptance does not qualify a hospital interface, establish clinical correctness or demonstrate throughput parity with NiFi, Cloverleaf or another integration engine.

## Non-negotiable data boundaries

**Every clinical/source database connection is strictly READ ONLY.** There is no override for administrators, agents, channels or destination databases. Database-enforced least-privilege accounts and closed connector operations are required. Internal operational queues, encrypted credentials, identity records and checkpoints are separate application storage. Delivery uses separately authorised HTTP APIs. Kafka group-offset commits acknowledge private intake; the consumer never produces, edits or deletes source-topic records. See [clinical database policy](CLINICAL_DATA_READ_ONLY.md) and [privacy controls](SECURITY.md).

Patient records, private results, source cursors and credentials never enter general MCP/model context, model repositories, reusable AI memory or training. Do not paste real records into chat. Operational exports contain clinical data and require their own access and retention controls. Encrypted queue originals and credential vaults do not replace volume/backup encryption.

## End-to-end workflow

1. Sign in, open **Integration**, and select/create a project with its exact FHIR release, canonical, package versions and dependencies. Configure access through **Groups & access**; shared monitoring does not grant operation or clinical-data access.
2. Supply the actual FHIR StructureDefinitions and applicable openEHR templates, their exact versions, origin and provenance. Agent-authored models and externally supplied models both require human confirmation for mapping. A name or URL alone is insufficient. Use the **Models** and **Mapping & review** tabs.
3. Open **Mapping & review → Draft with the agent** (also available in **Cross-standard mappings**). Choose the direction, enter ordinary-language constraints and optionally provide an AI-safe sample. **Continue in modelling chat** prepares a request for review; it does not send automatically or spend model tokens. Continue the conversation to refine the proposal. Discover the allowed source metadata. Provide the source dictionary and narrative explaining clinical meaning, identifiers, corrections, units, codes, absent values and time zones. Use synthetic examples. Resolve all ambiguities before confirmation. Vendor-specific table names are never guessed.
4. Reuse an exact-context confirmed mapping when available. Otherwise describe constraints in ordinary language: the agent drafts the mapping proposal, converts the narrative into explicit deterministic rules and retains each original statement alongside its interpretation, assumptions and unresolved questions. When the user supplies a suitable synthetic/de-identified sample, the agent proposes test cases and expected output; the private runtime can validate an authorised clinical sample without exposing it to model context. The human reviews/corrects the proposed rules, models and test results and confirms the mapping. Changed models, rules or narrative require a new version/confirmation. Technical validation, mapping selection, clinical approval and publication remain separate decisions.
5. Configure a private source and, for delivery, a destination. Source-read approval does not authorise destination writes. Enable patient identity/reference and pseudonymisation policies as required.
6. Inspect a private input, run a bounded export, review validation and evidence, then qualify delivery against the actual destination. Assign the exact confirmed mapping to a channel and explicitly **Start** it.
7. Monitor intake, processing, dependencies, failures and receipts. Stop/reconcile interrupted or uncertain work before changing assignments or upgrading an active integration.

The independent mapping directions are **source → FHIR**, **source → openEHR**, **openEHR → FHIR**, and **FHIR → openEHR**. There is no implicit route through an intermediate standard. Primary governance publication decisions are not automatically imported into the independent integration registry.

## Choose a source

| Source | How it is read | Durable progress |
|---|---|---|
| Private upload/folder | An unchanged file is admitted after two polls; private admitted snapshots are immutable | Owner/channel plus exact content SHA-256; same bytes under another filename are not admitted again on that channel |
| Reviewed database read plan | Bounded SELECT operations through separately reviewed native/ODBC adapters | Declared strictly increasing committed numeric cursor, saved after durable private capture |
| Reviewed clinical/vendor API | Exact approved HTTPS paths and bounded response contracts | Connector-specific reviewed cursor where supported; otherwise explicit bounded snapshots |
| Kafka topic | Exact topic, verified TLS, optional SASL/mTLS, `read_committed`, bounded capture | Cluster ID + topic UUID + partition + exact offset; broker commit only after durable private publication/checkpoint |

Use **Vendor connections** for SQL Server, Oracle, PostgreSQL, MySQL, MariaDB, SAP HANA, Epic Clarity/FHIR and approved SAP BW/clinical APIs. Drivers and installation limits are in [Vendor integrations](VENDOR_INTEGRATIONS.md). HANA requires the operator's licensed ODBC client. A connector listing does not establish installation readiness.

Incremental database channels automatically capture only a reviewed append-only cursor plan. The selected key must be unique and increasing, with committed rows becoming visible in that order. Backdated updates, mutable rows, transaction commit reordering and deletions require another explicitly designed interface; this is not database CDC. Bounded snapshot plans consume already admitted private files and do not repeatedly query the same clinical window automatically. Metadata discovery is separate from clinical reads.

### Kafka setup

In **Vendor connections → Kafka topic intake**, enter the exact brokers/topic, identity domain, payload contract, credential and trusted CA/client certificate if needed. Review the connection; confirmation performs metadata discovery and pins the real cluster/topic identities. A generated private consumer-group identity prevents taking over another application's group. Profiles start at the earliest retained offset. Use **Capture next bounded batch** or select the resulting source on a channel.

Each capture accepts 1–100 messages, at most 16 MiB total, 8 MiB/value, 4 KiB/key and 64 headers totalling at most 16 KiB. Native prefetch is bounded separately. Credentials travel to the private C# consumer over stdin, never process arguments or model context. Verification of TLS certificates/hostnames cannot be disabled. Supply a consumer-only broker ACL; group coordination/offset permissions are needed in addition to topic read/describe. The shipped consumer contains no producer.

The default lossless JSON envelope contains `transport` metadata (event identity, exact offset string, partition, key, repeated headers, tombstone and timestamp) plus `payload`. Valid JSON is parsed; UTF-8 text, binary Base64 and tombstones remain explicit. Original value bytes and metadata are retained privately. Avro/Protobuf/schema-registry decoding is not implemented. Raw formats require each Kafka value to be a complete supported input; choose the envelope for tombstones or binary values. Transport metadata does not establish patient identity or clinical semantics.

Kafka fetches can repeat before durable acknowledgment. A repeated transport event reuses its retained receipt; identical payloads at different offsets remain distinct transport events. Offsets are kept as decimal strings without JavaScript number rounding. A crash before acknowledgment does not advance broker offsets. A crash after durable publication resumes from the private cursor and deduplicates any recovered capture. Broker-commit failure is reported separately; it does not discard locally accepted records.

Retention gaps, truncation, topic recreation and a broker checkpoint ahead of local evidence fail closed. Do not reset offsets to bypass them. Preserve the pending capture and reconcile/restore with an operator. One active platform intake owns each profile; this is not a distributed Kafka consumer group with automatic rebalancing. Order exists within each partition. Cross-partition intake order is the platform's observed acceptance sequence, not a global source ordering guarantee.

## Channel order, concurrency and memory

In **Run & channels**, select the exact mapping/source/mode/destination, polling interval (5–3600 seconds), failure policy and execution controls. Review and confirm. New channels start stopped.

| Mode | Behaviour | Dependency consequence |
|---|---|---|
| Strict FIFO | One input, and its source records, is processed in intake order until completed or explicitly dispositioned | A missing Patient/Encounter at the head blocks later work. Register/resolve the dependency outside that blocked sequence or choose dependency-aware processing |
| Dependency-aware sequential | One active job; eligible later inputs can pass held dependency work, which is periodically revisited | A later authoritative patient registration can release earlier held records |
| Bounded concurrency | Up to the selected 1–2 active jobs on that channel | Completion order can differ; clinical identity and destination write fences still apply |

The installation admits at most two private compute workers at once, including inspectors/extractors. Each channel selects a **128, 192 or 256 MiB managed .NET heap limit**, a pending-input cap of **1–5000**, and **0–10 transient retries**. Managed heap is not total process RAM: native libraries, validators, Node and OS buffers need additional memory. Monitoring reports active worker count and Linux worker RSS when available. Container limits remain the final installation memory boundary; operators must size those separately.

Queue limits apply backpressure before reading more source data. Private owner storage admission is 512 MiB, the intake SQLite/WAL cap is 256 MiB, source inputs are 16 MiB and jobs have a 256 MiB working-data bound checked between groups. These are safety/admission limits, not a throughput benchmark or automatic retention service. A disk-full or inaccessible queue pauses intake rather than forgetting receipts.

The durable inbox uses SQLite WAL with synchronous commits; each admitted input is snapshotted and synced before its queue receipt is added. Acknowledged identities are not evicted after a fixed count. Retain the inbox and private working storage together. Filename signatures avoid reopening unchanged files; a renamed file can be hashed again to establish its identity, but confirmed mappings and completed deliveries are not repeated. The platform cannot prevent the source transport itself from retransmitting data.

Stop before reassignment. Revision checks prevent stale edits. Existing intake receipts remain across assignment changes; create a new channel only for intentional, reviewed reprocessing. Restarted channels remain interrupted until explicitly started. There is no automatic adoption of a newer mapping or silent approval reuse.

## Duplicate prevention has two layers

**Transport/input memory** says which file content or Kafka position has already been durably accepted. **Clinical identity** says which patient, encounter and business record that input describes. Neither replaces the other. A corrected observation must carry the same stable business identity and a newer declared source version; a new filename or arrival timestamp is not a new clinical identity.

Per-record/output checkpoints and encrypted dependency queues preserve original bytes, identities, model/mapping hashes and successful delivery receipts. Mapping-result checkpoints bind the exact input, rules, patient resolution, dependencies, privacy policy and source contract. Recovery can reuse that deterministic result while rechecking current access, models, approval and validation. No language-model call or cached human approval is needed to process each record.

### FHIR delivery

Configure **Run & channels → Destination connection settings** with the exact HTTPS FHIR base, resource/read scopes and bearer credential. Human review is required. Credential rotation retains the destination identity and policy; change routing/scope through a new reviewed profile. Disable a profile to revoke use.

FHIR delivery requires an exact-release CapabilityStatement advertising conditional create, allowed resource types, one stable business identifier, `If-None-Exist` and comparison with the actual returned destination resource. Results distinguish created, already present, conflicting content, non-unique identifiers, rejected and uncertain. This path does not silently update existing FHIR resources. References must resolve to existing destination resources or contained resources. Multiple outputs are not transactional; a later failure leaves earlier recorded successes intact.

### openEHR delivery: lookup, create and version-conditional update

Choose **openEHR** in the destination settings. Declare exact deployed template IDs, the source business-identifier issuer/type, a separate source-version identifier type, version ordering and a stable URI naming the physical CDR across all its profiles. Confirm update permission separately.

Outputs must be canonical RM JSON COMPOSITIONs validated against the supplied compiled OPT 1.4. The mapping supplies exactly one matching business identifier and one source version in `feeder_audit.originating_system_item_ids`. Versions are nonnegative integers (up to 100 digits) or explicit ISO-8601 timestamps with UTC/offset and up to seven fractional digits. A missing or ambiguous identifier/version fails closed.

1. Resolve the patient's **existing EHR** by the exact verified/pseudonymised subject ID and namespace; read back its EHR status and check that identity. Missing EHRs are held. This path does not create patients/EHRs automatically.
2. Run a fixed, parameterised AQL against that EHR and source business identifier. No match proceeds to qualified creation; one match is fetched; multiple matches block delivery.
3. Equivalent content is **already present**, without creating another version. A lower source version is **superseded**, without overwriting newer data. Same source version with different content is a conflict.
4. A newer source version may use **PUT only when authorised**, with the exact strong version ETag in `If-Match`. HTTP 412 is a conflict requiring reconciliation, not an automatic overwrite/retry.
5. Creation uses POST with a deterministic client-assigned composition UUID derived from the stable CDR namespace, patient authority/ID and source business identity. It is permitted only after the operator qualifies that the actual CDR preserves this UUID and enforces uniqueness. Direct lookup by that UUID also protects against AQL indexing delay.
6. Validate the final outbound body, persist the write-intent fence, send once, verify actual readback and durably record the receipt before releasing the fence.

AQL lookup alone is not an atomic uniqueness guarantee. Internal SQLite reservations serialize platform writers to the same target, including different profiles sharing the stable CDR namespace. Unknown writes remain fenced across restarts. External writers must honour the same business identity/namespace and CDR uniqueness contract. Installation qualification is mandatory; a checkbox is an operator attestation, not an automated certification. The platform does not claim universal exactly-once delivery.

## Dependencies, retries and recovery

A verified Patient/patient ID is mandatory. Configure authoritative patient registration, reviewed logical/literal reference policy and optional destination pseudonymisation before delivery. Missing Patient/Encounter references are held privately. Source identity and pseudonym keys must survive restart/backup. See [HL7 and identity operations](HL7_AND_IDENTITY.md).

Known transient compute failures use bounded exponential retry, capped at five minutes. Held dependency work is revisited at the polling interval. Rejected records pause or enter private quarantine according to the reviewed policy; strict FIFO stops at the first unresolved/rejected record. Stop/cancel remains explicit.

An HTTP timeout, ambiguous server response, process death during a write or failed readback can mean the destination committed. Mark that result **uncertain**, retain its output/intent and pause. Use the authenticated human **Jobs & monitoring** recovery flow to query the actual destination, inspect the evidence and confirm reconciliation. Retry missing output only after that explicit decision. Never remove queue rows, change source IDs or clear reservations to force a blind POST.

Back up operational storage and original encryption/approval keys together. Restore cursor/receipt/source snapshots consistently; do not restore only the broker offsets. Before upgrade, stop channels, let active work settle and reconcile uncertain writes. Existing account, issuer, key, volume and approval identities must be preserved.

## Monitoring and acceptance

**Jobs & monitoring** shows read/transformed/rejected/held counts, exports, created/updated/already-present/superseded outcomes, failures and uncertainty. Channel monitoring includes mode, configured concurrency/heap, active workers/RSS, queue counts, oldest pending intake and backpressure. Group view/monitor grants expose an allowlisted operational summary without filenames, job IDs, patient values or credentials; they do not grant channel control.

Functional acceptance uses synthetic data: restart/dedup beyond the former marker limit, FIFO holding, bounded concurrency, encrypted capture/credentials, Kafka TLS/SASL acknowledgment and crash replay, HTTP openEHR identity/AQL/If-Match/readback and persistent destination fences. Exact CI evidence accompanies a release. Real source/CDR behaviour, terminology availability/licensing, retention, backup recovery, agreed service levels and clinical mapping acceptance remain installation-specific. Security/intrusion/load testing is currently deferred and must not be represented as completed.

## Deployment controls

Installed browser deployments enable integration and delivery separately. Defaults package the C# server, processing worker, extractor and Kafka consumer under `/app/integration/`. Protected review signing keys, approval-verification keyrings and identity issuers remain installation secrets. Operators configure routine source/destination/channel settings through the authenticated UI; initial installation keys, resource limits, drivers and backup policy remain deployment responsibilities. See [runtime boundaries](DOTNET_MIGRATION.md), [vendor setup](VENDOR_INTEGRATIONS.md) and [production promotion](FHIR_PRODUCTION_DELIVERY.md).

Protocol references: [Apache Kafka consumer configuration](https://kafka.apache.org/41/configuration/consumer-configs/), [Confluent .NET consumer](https://docs.confluent.io/kafka-clients/dotnet/current/overview.html), and [openEHR REST EHR API](https://specifications.openehr.org/releases/ITS-REST/development/ehr.html).
