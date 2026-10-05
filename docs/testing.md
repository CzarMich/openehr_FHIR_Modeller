# Testing

Run offline unit, schema and regression checks with `make ci`. Run `npm --prefix chat test`, `npm --prefix chat run check:format` and `npm --prefix chat run test:browser` for the browser service, including personal provider isolation. Tests mock external HTTP. Coverage spans preserved upstream tools/prompts/resources, configuration, auth rejection, named CKMs, secure XML, draft provenance, storage traversal/concurrency/history, governance refusal, traceability and local/FHIR terminology. `make conformance` runs isolated production HTTP/stdio product probes and pinned applicable official MCP scenarios, with no expected failures in the gate. The historical whole demonstration-suite result remains diagnostic evidence; see [the protocol profile](MCP_PROTOCOL.md).

Personal workspace tests exercise real PDF/spreadsheet/text extraction, exact original downloads, cross-user denial, source deduplication, encrypted tokens, network-address refusal, revision-conditional Git writes and snapshot revocation. Browser scenarios add private connections, select a destination, upload evidence and view/revoke sharing links. Git/CKM contracts use mocked responses; live account acceptance requires separately provisioned personal credentials.

Run the independent protocol client against a running container:

```bash
python3 scripts/mcp-smoke.py --url http://127.0.0.1:8343/mcp --evidence /tmp/http-smoke.json
python3 scripts/mcp-smoke.py --url http://127.0.0.1:8343/mcp --live-ckm --live-terminology --evidence /tmp/live-smoke.json
```

The second command requires configured external services and network access. `AUTH_API_KEY`/`AUTH_API_KEY_HEADER` in the client environment authenticate the MCP connection. Terminology credentials belong in the server environment. `--writes` creates a uniquely named project and checks revision conflicts; use a disposable verification volume. `--catalogue` exports public tool schemas. A missing dependency or assertion failure exits nonzero; live failures are not reported as offline unit-test failures or quietly passed.

Live terminology defaults exercise an available SNOMED example and an implicit value set. Override `SMOKE_TERMINOLOGY_SYSTEM`, `SMOKE_TERMINOLOGY_CODE` and `SMOKE_VALUESET` for installed content. A canonical URI alone does not imply a dataset exists. Preserve response status, scope, timestamp and version confirmation; do not commit keys, expanded restricted terminology or clinical data.

Before delivery also build production and development images, check liveness/readiness, exercise API-key rejection/acceptance, allowed hosts/origins, request limits, stdio initialization, restart persistence, and startup without CDR/terminology settings. Run `composer audit` in the development container. Store sanitized execution metadata under `docs/evidence/`; keep repeatable procedures here.

## Governance and independent review

`scripts/test-governance-container.sh` builds an isolated core fixture, drives MCP preparation and signed human HTTP review from an independent Python client, rejects approval on incomplete validation, checks replay/stale/role/tenant failures, and verifies ledger persistence after restart. `scripts/test-sharepoint-container.sh` and `scripts/mcp-smoke.py --governance --writes` cover governance over repository adapters using disposable models. Unit tests additionally exercise concurrent audit writers, tampering, qualified-validator fixture decisions and OpenAPI response contracts. Browser tests cover review confirmation, cancel and mobile layout. They never constitute clinical approval of a real model.

Traceability checks run through `ProjectTraceabilityTest`, `TraceabilityGraphTest`, output-schema contracts and the write-enabled independent MCP probe. The governance-enabled probe additionally links actual pipeline ledger events and rejects forged event hashes. These checks use synthetic modelling content and do not establish clinical satisfaction. Direct file/Git edits, historical graph reads, stale references, tenant boundaries and bounded work are covered.

Run `StagedValidationTest` and `ProjectQualityTest` for parser/profile boundaries, occurrence overflow, ambiguous JSON, bounded findings, repository contracts, exact-source validation and tenant isolation. Independent container smoke checks exercise FLAT/STRUCTURED stages and stored project QA through MCP. See [Validation and QA](VALIDATION_AND_QA.md).

CKM federation tests use mocked HTTP and isolated HTTPS profiles for Basic, session, bearer and API-key methods. CI runs `scripts/test-ckm-container.sh` to verify actual source isolation, redirects, failures and secret rotation. The separately opted-in `scripts/ckm-public-smoke.php --allow-public-network` records public reference acceptance and never reads deployment credentials.

Original preservation is covered by `OriginalRepositoryTest`, `ArtifactTypeInspectorTest` and `ModelImportsTest`; SQLite/PostgreSQL stream filtering prevents provenance records from appearing as reviews. `scripts/test-storage-container.sh` also runs actual MCP import acceptance. `scripts/import-fixture-smoke.py` is read-only unless `--writes` explicitly selects isolated synthetic fixture creation. Browser tests verify exact binary downloads. [Details](MODEL_IMPORTS.md).

## Form compatibility and CDR privacy

The [patient-data boundary](PATIENT_DATA_BOUNDARY.md) maps each enforced boundary to repeatable tests. The native engine build runs an independent SDK Web Template parser against generated OPTs, including a regression for missing description/language metadata. Browser tests verify clear-selection state and direct-to-editor AI drafts with synthetic private-value canaries. Repository-cache tests verify encryption, ownership, revision/credential invalidation, upstream revocation, expiry and bounded storage. No real clinical queries are needed for this acceptance.
