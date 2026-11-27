# ADR-0004 — Reproducible container toolchains

- **Status:** Accepted for the current runtime; earlier mechanics are superseded.
- **Historical record:** [original decision](https://github.com/CzarMich/openehr_FHIR_Modeller/blob/59c99e3/docs/decisions/0004-docker-only-runtime.md)

## Decision

Use the pinned SDK container for C# compilation and synthetic tests. Build application images only on hosted CI, never shared Dev or production. Retain specialised engine/browser toolchains and immutable deployment digests. Prebuilt images and persistent data survive source-runtime changes.

## Consequences

Keep runtime details and current evidence in [architecture](../ARCHITECTURE.md), [testing](../testing.md) and [runtime boundaries](../DOTNET_MIGRATION.md). Preserve contributor history, third-party rights and stable requirement identifiers. Do not qualify an unexecuted stage or present deferred security scans as passed.
