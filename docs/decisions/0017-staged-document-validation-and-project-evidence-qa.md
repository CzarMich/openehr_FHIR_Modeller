# ADR-0017: Staged document validation and project evidence QA

- Status: Accepted

## Decision

Expose parsing, document structure, semantics, terminology, openEHR conformance and repository policy as separate stages. Retain native safe XML/JSON parsing and bounded OET/OPT/FLAT/STRUCTURED profiles. ADL declaration inspection remains distinct from ADL parsing; AQL parsing is reserved for the mature engine integration. Do not create a replacement ADL/AOM ecosystem from regular expressions.

Formal findings carry stable codes, source locations, evidence and remediation. Failed parse/profile checks remain distinguishable from unavailable validators. Decimal interval checks avoid machine-integer overflow, duplicate JSON keys are rejected, external schema hints are never fetched and diagnostic output is bounded.

Add a shared application service for exact-revision project QA, consuming existing ModelRepository, requirements graph and terminology-inspector contracts. Resolve authoritative validation/review evidence through the graph's tenant-aware audit resolver. Require exact source identity; a linked binding's validation cannot qualify the source model. Recorded provenance, requirement claims and historical human reviews retain their own trust boundaries.

## Consequences

The same deterministic services remain usable by MCP and future REST/CLI adapters without a model provider or external terminology server. Existing tool names and result envelopes are retained; stage results and the project QA tool are additive. Correct the misleading ADL structural boolean and OPT mandatory-description assumption with explicit migration notes.

These services never emit release qualification. Full schemas, AOM/RM semantics, inherited paths, dependency resolution and genuine composition/ADL/AQL checks belong to the qualified engine phase. The human approval gate remains closed for incomplete validation. Scope, profile syntax, deployment and reproducible verification are documented in [Validation and QA](../VALIDATION_AND_QA.md).
