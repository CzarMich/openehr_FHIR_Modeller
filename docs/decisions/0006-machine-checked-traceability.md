# ADR-0006 — Machine-checked requirement traceability

- **Status:** Accepted for the current runtime; earlier mechanics are superseded.
- **Historical record:** [original decision](https://github.com/CzarMich/openehr_FHIR_Modeller/blob/59c99e3/docs/decisions/0006-machine-checked-traceability.md)

## Decision

The dependency-free Python gate validates current requirement identifiers, implementation/test/ADR paths and the derived human matrix. The source index uses JSON-compatible YAML syntax. Run `python3 scripts/spec-check.py`; use `--render` after changing the source index. Historical class/test paths are not current verification evidence.

## Consequences

Keep runtime details and current evidence in [architecture](../ARCHITECTURE.md), [testing](../testing.md) and [runtime boundaries](../DOTNET_MIGRATION.md). Preserve contributor history, third-party rights and stable requirement identifiers. Do not qualify an unexecuted stage or present deferred security scans as passed.
