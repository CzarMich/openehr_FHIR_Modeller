# ADR-0001 — Capability declaration and discovery

- **Status:** Accepted for the current runtime; earlier mechanics are superseded.
- **Historical record:** [original decision](https://github.com/CzarMich/openehr_FHIR_Modeller/blob/59c99e3/docs/decisions/0001-attribute-driven-discovery.md)

## Decision

Runtime mechanics superseded by the C# application contract registry. Captured tool/resource/prompt descriptors are loaded by the official C# SDK handlers; the implementation does not rely on runtime reflection over the former application tree. Preserve public metadata, original resource bytes and bounded startup behaviour. Verify the current image with application/transport contracts.

## Consequences

Keep runtime details and current evidence in [architecture](../ARCHITECTURE.md), [testing](../testing.md) and [runtime boundaries](../DOTNET_MIGRATION.md). Preserve contributor history, third-party rights and stable requirement identifiers. Do not qualify an unexecuted stage or present deferred security scans as passed.
