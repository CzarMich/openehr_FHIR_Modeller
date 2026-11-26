# C# modelling and integration workspace

The optional integration workspace executes confirmed, deterministic mappings on private files. Use it to generate validated FHIR exports, push FHIR to an authorised HTTP destination, or poll a folder continuously with a mapping assigned to a channel. It does not require an LLM for each record. It is not a claim of feature or throughput parity with a mature integration-engine product.

New application/domain services and workers are C#/.NET 10. The browser/session adapter remains Node, and the existing Java/openEHR and Node/Java FHIR compiler services remain specialised engines. The original `/mcp` remains a PHP compatibility endpoint during migration. See [the exact migration boundary](DOTNET_MIGRATION.md).

## Start with a modelling project

1. Sign in to the browser and open **Integration workspace** (`/chat/integration/`). A modeller/reviewer/approver or administrator role and project write scope are required to confirm mappings. Shared API-key access is an organisation service principal, not per-user tenant isolation.
2. Create a project with its exact FHIR release, canonical, package identity/version, publisher and exact dependencies. R4 (4.0.1), R4B (4.3.0) and R5 (5.0.0) are supported by the retained FHIR engine. Project configuration is immutable; create a new project when changing that boundary.
3. Provide the **actual content** of each FHIR StructureDefinition and openEHR template, its exact version, provenance and whether it was externally provided or agent modelled. Names and URLs alone do not supply the constraints needed for mapping. Models are immutable by project/standard/identifier/version.
4. Ask an MCP agent to draft a mapping from your source schema and narrative instructions, using the C# tools below. Resolve ambiguous meanings, identifiers, units, codes, absent values, time zones and intended information loss. Use synthetic examples only in modelling requests.
5. Select the models and prepare the mapping. Inspect their exact bytes/hashes, original instructions, interpretations, assumptions, rules and examples. Tick the acknowledgement and record a human confirmation comment. A direct source-to-FHIR mapping requires its FHIR SDs; a route through openEHR or a reverse mapping also requires the exact openEHR template. Agent-modelled and externally provided inputs both require this exact-selection confirmation.
6. A changed model, narrative or rule requires a new mapping version and confirmation. Agents cannot confirm/revoke. Technical validation, mapping selection, clinical approval and publication remain separate. Neither a synthetic example nor human mapping selection establishes clinical correctness.

Existing PHP projects/approval identifiers are not automatically imported into the independent C# registry. Re-provide the models and confirm a new C# mapping before assigning a channel.

## Process a private file

Upload a source through **Inspect a private source**, or choose an operator-registered source folder. Uploads go to owner-scoped private operational storage, not conversation attachments, model Git or the model registry. Inspection returns counts, field paths/types, missing/null counts and a schema hash, without example values. A synthetic marker is a usage contract, not a PHI detector.

Choose the file, a confirmed mapping version and either **Validate and export** or an authorised FHIR destination. Review the exact run before confirming. The worker checks the file hash, source schema, current model/rule confirmation and destination scope; runs deterministic rules; validates outputs using the installed validators; and retains checkpoints and private evidence.

Jobs report records read/transformed/rejected, exported outputs, emitted resources, delivery failures and uncertain results. A rejected record goes to private quarantine. Completed runs offer NDJSON export and a separate private quarantine download. Reports carry counts/codes and hashes; downloaded exports/quarantine contain operational data and need clinical-data access controls.

Resume retains per-record/output checkpoints. A cancelled or interrupted job requires an explicit resume. Review uncertain delivery before resuming/reconciling; conditional-create reconciliation does not overwrite resources. Sources are never edited or deleted. Keep source bytes available until the job is complete.

## Assign a mapping to a channel

Choose the confirmed mapping, source, mode and destination. Enter a channel name, polling interval (5–3600 seconds) and failure policy, review the assignment and confirm it. A channel starts stopped; explicitly press **Start**.

A channel pins the mapping subject and hash. It polls files that are unchanged over two polls, processes one batch at a time, and retains consumed content hashes. The installation runs at most two workers at once. A data failure either pauses the channel or quarantines and continues, according to its policy. Infrastructure/validation unavailability pauses processing with its error code; operators can correct the problem and restart. A process restart leaves channels interrupted and requires explicit start. No automatic new-version adoption occurs.

Stop a channel before changing its assignment. The API requires the expected channel revision for reassignment. New assignments retain history. Existing acknowledged input hashes are retained across reassignment; use a new channel when intentional reprocessing is required.

## Source formats and mapping rules

| Input | Implemented boundary |
|---|---|
| CSV | UTF-8, header row, quoted fields, explicit strings; leading zeros and empty strings preserved |
| Custom JSON | Array of objects; duplicate object keys rejected; absent, null, number and string remain distinct |
| Generic XML | Direct children of a root become records; DTD/external entities and mixed content rejected; namespaces preserved in names |
| XLSX | One data sheet at `xl/worksheets/sheet1.xml`, shared/inline strings and values; no formulas or macros; no implicit date or clinical-code inference |
| FHIR JSON | Single resource, object array or collection Bundle entries containing only `resource` (fullUrl/request/response/search/paging context is rejected rather than discarded); actual release/profile validation is required for reverse mapping; no automatic reference remapping |
| SQL, queues, HL7 v2, CDA, specialised datasets | Unsupported; generic XML/JSON parsing does not implement those standards |

Limits: 16 MiB/source, 10,000 records, 256 field paths, depth/ZIP limits, up to 100 mapped outputs per source group, 2 MiB/output and 8 MiB/stage. Jobs stop at a 256 MiB private storage bound checked between groups; private owner storage admission is bounded at 512 MiB. These are admission/backpressure controls, not an automated retention service. Operators must archive/delete completed private data under their retention policy.

The closed version-2 JSON rule language supports explicit JSON Pointer copies, exact decimal affine conversions, declared code dictionaries, UTC conversion from explicit offsets, deterministic identifiers, relative references, constants, predicates, grouping and array explosion. It rejects overlapping targets, unsupported operations, ambiguous date-times, undeclared codes and decimal precision loss. It does not execute arbitrary code/SQL. Each rule records its description, interpretation, assumptions and missing/null policy.

Mapping JSON must include `schemaVersion:2`, `name`, exact semantic `version`, `direction`, `description`, `sourceSchemaSha256`, `reversibility`, `requirements`, `unresolvedQuestions`, `examples` and `stages`. Directions are `source-to-fhir` (two stages), `source-direct-to-fhir` (one) and `fhir-to-openehr` (one). Requirements retain `id`, `originalText` and `basis` (`user-instruction`, `declared-fact` or `inferred-proposal`). Examples require `synthetic:true`, an `input` object and either expected output array or a declared `RECORD_*` error. Any unresolved question or failed example blocks confirmation.

An optional declared `sourceSchema` pins paths/types while allowing missing/null values to be handled by explicit rules. Without it, the observed schema hash must match exactly. A `retained-context` mapping preserves original grouped records privately alongside provenance; a `lossy` mapping reports unmapped paths. `lossless-within-scope` is restricted to exact copies/constants and fails when source fields remain unmapped; it is not an automatic reverse-mapping guarantee. Reverse mappings and meaningful round-trip assertions must be authored separately.

## Validation and destination delivery

openEHR processing currently requires one **compiled OPT 1.4** and canonical RM JSON. An OET source must be compiled first. The installed openEHR SDK/Archie engines check RM invariants and template constraints; external terminology checks are separately reported. OPT 2.0 runtime compositions are not advertised.

Every FHIR output must have a selected actual SD for its resource type. The HL7 validator receives the exact supplied profiles and pinned project packages. Engine absence is a blocking operational error, not a successful validation. The operator's `requireTerminology` defaults to true; disabling it explicitly permits structurally validated output without claiming terminology/clinical approval.

Destination delivery is separately enabled and operator registered. It uses HTTPS, an exact-release CapabilityStatement advertising conditional create, allowed resource types, one stable business identifier, `If-None-Exist`, bounded retries and comparison with the actual destination representation. Results distinguish created, already present, conflicting existing content, non-unique identifiers, rejected and uncertain. Resources are not silently updated or overwritten. References must resolve to existing resources on that destination or contained resources. Transactions, updates and automatically creating linked new resources are unsupported.

**Every direct clinical/source database connection must be READ ONLY.** No SQL driver is enabled in this version. No insert/update/delete/DDL/migration/write procedure is allowed, including through a destination's database. FHIR writes use the separately authorised HTTP API. Negative DB-write tests may run only on isolated synthetic fixtures, never on a real clinical database. See [the golden rule](CLINICAL_DATA_READ_ONLY.md).

## Operator configuration

Set `CHAT_INTEGRATION_ENABLED=true` with verified review enabled, a configured review signing key/key identifier and browser identity issuers. New tools and private human requests run through the C# service, using the existing protected signing-key configuration. Set `CHAT_INTEGRATION_APPROVAL_KEYS` to a JSON key-id/secret map containing the active review key and previous approval keys when rotating; losing approval-signing keys prevents verification of existing decisions. Do not copy keys into model prompts or Git.

The chat image contains self-contained C# server and worker binaries. Defaults:

```text
CHAT_INTEGRATION_SERVER=/app/integration/server/Modeller.Mcp
CHAT_INTEGRATION_WORKER=/app/integration/worker/Modeller.Processing
CHAT_INTEGRATION_FHIR_URL=http://fhir:8094
CHAT_INTEGRATION_FHIR_KEY_FILE=/run/secrets/fhir-engine-key
CHAT_INTEGRATION_NATIVE_URL=http://app:8090
CHAT_INTEGRATION_NATIVE_KEY_FILE=/run/secrets/engine-key
CHAT_INTEGRATION_ALLOW_DELIVERY=false
```

The C# HTTP service listens only on loopback port 8351 inside the chat workload. The authenticated public adapter is `/chat/integration/mcp`; it requires the configured API key and exact allowed origin/host. Ordinary agent tools cannot invoke private jobs or human decisions. The browser adds a separate short-lived, request-bound human assertion. No external connection to port 8351 is needed. Private engines require secret keys and network restrictions; never publish their ports publicly.

For registered folders/destinations set `CHAT_INTEGRATION_CONNECTIONS_FILE` to a protected, operator-managed JSON file:

```json
{
  "requireTerminology": true,
  "sources": [{"id":"laboratory","root":"/sources/laboratory","format":"csv","projects":["lab"],"owners":["<SHA256 of verified browser identity>"]}],
  "destinations": [{"id":"exchange","baseUrl":"https://fhir.example.org/fhir/","tokenFile":"/run/secrets/exchange-token","projects":["lab"],"owners":["<same owner hash>"],"resourceTypes":["Observation"]}]
}
```

Mount source folders read-only and destination credentials as read-only secret files. The connections response exposes the current `ownerScope` for operator registration but never roots or tokens. A registered endpoint is a trusted egress grant: review its URL/DNS/network policy. No arbitrary destination URL comes from a record or agent rule. Enable `CHAT_INTEGRATION_ALLOW_DELIVERY=true` only after registering/testing the destination.

Operational data lives below `CHAT_DATA_DIR/processing`; model/rule data below `CHAT_DATA_DIR/integration-models`. Model approvals and jobs survive restarts on the existing chat volume. File permissions are not application encryption. Operators own encrypted volumes/backups, retention, access and recovery. Internal engine HTTP is authenticated but not necessarily encrypted. Never assume legal/compliance certification from these controls.

## Agent tools and verification

`modelling_project` creates/lists/reads projects; `modelling_model` provides/lists/reads actual models; `modelling_mapping` returns an executable format example with `action="help"` and prepares/lists/reads and synthetically previews mappings; `source_inspect` inspects synthetic structure; `modelling_engine` invokes fixed FHIR/openEHR operations. Each uses `action`, optional `projectId`, and JSON-encoded `arguments`. Human decisions and operational record processing are deliberately separate authenticated browser operations.

`dotnet/Modeller.Processing.Tests` checks the core's parser/rule, versioning, audit and human-proof boundaries. `dotnet/tests/workspace-contracts.py` exercises the real HTTP review API independently and can run a synthetic file job against the installed FHIR validator with `--installed-fhir`. `dotnet/tests/run-contracts.py` preserves all 67 guide contracts over HTTP/stdio. Native composition tests run against the actual installed SDK. CI also runs the browser/backend, existing compatibility and delivery-boundary checks. These tests do not confer clinical approval.
