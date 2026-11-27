# ADR-0028 — C# application and contract preservation

- **Status:** Accepted for the current runtime; earlier mechanics are superseded.
- **Historical record:** [original decision](https://github.com/CzarMich/openehr_FHIR_Modeller/blob/59c99e3/docs/decisions/0028-incremental-dotnet-migration.md)

## Decision

The primary application is C#/.NET 10, with a separate protected modelling registry/private worker and retained Java/Node standards engines. Preserve public contracts, imported bytes, model revisions, audit hash chains, stable human identity issuers, protected decisions and storage. Build/test packaged images on hosted CI, verify Dev, then promote exact digests. Source code availability is not proof of a completed production upgrade.

## Consequences

Keep runtime details and current evidence in [architecture](../ARCHITECTURE.md), [testing](../testing.md) and [runtime boundaries](../DOTNET_MIGRATION.md). Preserve contributor history, third-party rights and stable requirement identifiers. Do not qualify an unexecuted stage or present deferred security scans as passed.
