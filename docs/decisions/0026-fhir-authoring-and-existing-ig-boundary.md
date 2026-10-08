# ADR-0026: FHIR authoring and the existing IG boundary

Status: Accepted

## Context

The user requires parallel improvement of an existing IG platform and a distinct
FHIR authoring extension to the openEHR assistant. Git must retain engineering
history. The existing IG platform is already the publication/distribution authority.

## Decision

Preserve the original openEHR history and capabilities in a new repository. Add
an independent FHIR provider, release-pinned project configuration, private package
cache, immutable imported content, and separate mapping artefacts. Use actual
SUSHI and HL7 validator executables. Report unavailable checks and terminology
coverage explicitly; no mock response may stand in for validation success.

Use an internal authenticated service for FHIR computation and the inherited
repository/authorization boundaries for projects. Clinical approval cannot be
granted by MCP. Browser confirmations authorize exact mutations, not clinical
approval. Connection credentials stay in private deployment secret files. The
workspace follows MCP principal identity, including shared service scope where
configured; do not describe this as private per-user storage.

Inspect and reuse the existing IG API. Upload locally validated resources as drafts,
or request an exact commit import through its Git link. No parallel publisher or
public profile catalogue is introduced. The IG platform owns its independent
permissions, review and publication gates. Imports must record commit/file hashes
and conflicts without deleting or overwriting released artefacts.

## Consequences

The engines and IG server remain independently deployable. A package or source
server outage produces actionable failures; it cannot silently select a different
version. Synthetic example generation leaves undecided clinical values as gaps.
Cross-standard mappings remain proposals with explicit source/target paths and
versions. Runtime patient reads require a separate browser-only client boundary.

The initial delivery was Dev only. Subsequent user authorization permits
[production promotion](../FHIR_PRODUCTION_DELIVERY.md) after Dev verification,
reusing the same immutable images through GitHub. Feature branches, separate
credentials and isolated volumes keep the original platform, Dev and production
deployments independent.
