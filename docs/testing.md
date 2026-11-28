# Testing and acceptance

Tests establish the behaviour and scope of the exact revision being checked. A source catalogue, schema-only test or saved historical report is not hospital acceptance or clinical approval.

## Functional checks

| Boundary | Entry point | Scope |
|---|---|---|
| Application build | `make compile` | Locked C# dependencies, compiler warnings as errors |
| Requirement drift | `python3 scripts/spec-check.py`; `python3 scripts/spec-check-test.py` | Current IDs, paths, ADRs and derived matrix |
| Application domain | `dotnet/Modeller.Application.Tests` through the pinned SDK | Repository revisions/concurrency, exact imports, governance, traceability, saved build evidence, staged document profiles, XML differences and terminology/binding-plan freshness |
| Primary MCP | `dotnet/tests/application-contracts.py` | Published tool/resource/prompt metadata, actual resource bytes and synthetic operations over HTTP; `--product-smoke` also runs the independent draft/catalogue/binding/traceability workflow |
| Human/authentication adapters | `dotnet/tests/application-auth-contracts.py` and `dotnet/tests/workspace-contracts.py` | Verified identity, project rights, request-bound human proof, fresh writes, exact confirmation and read-only reuse |
| Mapping/private worker | `dotnet/Modeller.Processing.Tests` | Exact arithmetic, source structure, executable examples, confirmation/revocation, reuse invalidation, export and delivery state |
| Internal audit cutover | `dotnet/tests/storage-contracts.py` | Consistent SQLite backup, exact PostgreSQL event/hash/nonce import, idempotence, conflict rollback and restart persistence |
| Source metadata/plans | `dotnet/Modeller.Database.Tests` | Vendor-neutral catalogues, fingerprints, bounded/parameterised structural plans; no hospital records |
| Terminology HTTPS | `dotnet/tests/terminology-contracts.py` | Actual MCP against disposable authenticated HTTPS fixture: code membership, versions, expansion, translation proposals and exact resource search |
| CDR HTTPS | `dotnet/tests/cdr-contracts.py` | Real C# connection, catalogue array and XML retrieval, credential redaction/encryption; optional installed native-engine query checks, with metadata-only history |
| CKM HTTPS | `dotnet/tests/ckm-contracts.py` | Actual MCP source-specific credentials, federated provenance/window totals, explicit failures and mounted credential rotation |
| SharePoint HTTPS | `dotnet/tests/sharepoint-contracts.py` | OAuth, schema-backed immutable snapshots, historical/binary bytes, revision conflicts and new-adapter readback against a synthetic Graph contract |
| Remote FHIR/IG HTTPS | `dotnet/tests/fhir-remote-contracts.py` | Actual IG login/health/project contracts, bounded definition summaries, original profile bytes, returned resource types and explicitly synthetic validation |
| Browser backend | `npm --prefix chat test` | Sessions, repositories, groups/teams, privacy boundaries and integration orchestration |
| Browser UI | `npm --prefix chat run test:browser` | User workflows, exact reviews, sharing, reuse and viewport behaviour using synthetic fixtures |
| Standards engines | `fhir` acceptance and `engine` test/fixture scripts on hosted CI | Actual compilation/validation with retained scope and exact source/dependency evidence |

Local C# checks use the pinned SDK container in the Makefile. The Python contract runners accept an already compiled service or a hosted-built image. SDK compilation is allowed on Dev; application-image builds belong on hosted CI. Fixtures create temporary synthetic keys/certificates and do not require a personal security key.

Browser workbench acceptance covers functional menus, pane resizing/visibility, theme persistence, dark/light contrast, compact Accounts controls and page/pane overflow at desktop and mobile widths. Public asset HTTP checks cover content-versioned immutable caching, changed-release invalidation, ETag revalidation and uncached private responses.

## Release gates

[PR validation](../.github/workflows/pr-validation.yml) invokes [.NET runtime validation](../.github/workflows/dotnet-migration.yml), checks deployment boundaries, runs browser tests and builds standards/primary images on hosted runners. Add affected adapter acceptance when changing external provider semantics. Qualification against a real CKM, repository, EHR, database or terminology server requires the permitted installation and its actual credentials/data contract; do not substitute mock results for that evidence.

Keep protocol contracts and original model bytes separate from generated output. Verify persistence and stable identities before/after upgrade. Confirm Dev image digests and health, then promote exactly those images to `hygeoniq-prod`. Recheck deployed functionality through the public edge. Do not report production upgraded merely because a branch compiled.

## Deferred security work

The user has deferred vulnerability scanning and attack/load testing. The optional source write-denial fixture and dependency scan jobs are gated by `MODELLER_RUN_SECURITY_VALIDATION`; leave that setting disabled until the user resumes the work. Ordinary functional authentication, permissions, immutable evidence and read-only enforcement still run. Never attack or write-test a real clinical database or production endpoint.

Historical evidence in Git is tied to its recorded revision. Current test counts, assertions and deployment state must come from a current run. Passing tests do not constitute clinical certification or a guarantee that all vulnerabilities have been found.

Vendor adapters add `Modeller.Vendor.Tests`, `chat/test/vendor-sources.test.mjs` and `dotnet/tests/vendor-database-functional.py`. The latter runs disposable official PostgreSQL/MySQL/MariaDB images with synthetic records, actual TLS and private reads; it performs no source-write denial probes. Driver-specific and hospital acceptance remain separate.
