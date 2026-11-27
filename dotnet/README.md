# C#/.NET modelling runtime

The solution contains the complete primary MCP application, authenticated human adapters, deterministic modelling/mapping registry and private processing worker. The browser backend remains Node; installed Java/Node engines compile and validate openEHR/FHIR artifacts. Verify the deployed revision before assuming a source capability is available in an environment.

| Project | Responsibility |
|---|---|
| `Modeller.Mcp` | Primary modelling MCP HTTP/stdio, guide/workspace transports, identity and human review APIs |
| `Modeller.Application` | Repositories, imports, standards/remote adapters, terminology, governance, traceability, QA and source-discovery jobs |
| `Modeller.Core` | Exact provided models, versioned rules, human confirmation, deterministic transformation and reuse; no source database driver |
| `Modeller.Database` | Separately bounded source metadata and query-plan adapters |
| `Modeller.Processing` | Private file-source worker, validation, quarantine/export and controlled FHIR delivery |
| `*.Tests`, `tests/` | Synthetic domain, protocol, adapter and packaged-runtime acceptance |

Use the pinned .NET 10 SDK container from the root Makefile. `make install`, `make compile`, `make unit`, `make spec-check` and `make browser` perform local functional work. Application images are built only on hosted CI. NuGet dependencies/checksums are locked; retained notices are under `notices/`. Dedicated security scans/attack testing are deferred by the user and must not be reported as passed.

The primary image enables `MODELLER_APPLICATION_ENABLED=true` and listens on HTTP 9000. Its standard-I/O argument is `--stdio`. The browser's separate modelling registry is enabled explicitly with protected approval keys and request-bound interactive identity. It must not be confused with a general API-key workspace or a clinical approval store.

All direct clinical/source DB access is read-only. SQL Server currently supports qualified metadata discovery; source selection does not enable unfinished connectors or row extraction. Exact provided/agent-authored FHIR profiles and applicable openEHR templates require human confirmation before mapping. Reuse verifies current decisions without provider calls; clinical records stay in private processing, outside model/provider memory.

See [runtime/migration boundaries](../docs/DOTNET_MIGRATION.md), [development](../docs/development.md), [testing](../docs/testing.md), [source status](../docs/SOURCE_CONNECTORS.md) and [reuse](../docs/REUSE_AND_LEARNING.md). Preserve existing storage, issuer identifiers, keys, users and rollback digests during deployment.
