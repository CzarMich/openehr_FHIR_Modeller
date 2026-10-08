# FHIR modelling development delivery

The user requirements in the three source files are retained verbatim; pasted XML fragments may be incomplete. The explicit existing-IG-server boundary takes precedence: this repository is an authoring, modelling, validation, governance client. It must not host a second public profile catalogue, IG distribution service or standalone IG management product.

- Modeller source: `CzarMich/openehr_FHIR_Modeller`.
- Existing IG server source: `CzarMich/hyq_fhir`, local `HYQ-FHIR-Governance-Platform`.
- FHIR engineering artifacts: `CzarMich/fhir_ig`.
- Deployment scope: verify Dev first, then use the separately authorized [production promotion](../../FHIR_PRODUCTION_DELIVERY.md) of the same immutable images. Dev and production keep separate data and credentials.
- Preserve inherited openEHR behaviour, source history and MIT/third-party notices.

## Workstreams

1. FHIR provider/tooling: exact-version package discovery, reuse, typed FSH generation, real compilation/validation, FHIRPath, semantic comparisons.
2. Modeller: independent FHIR project/configuration/artifact persistence, MCP, browser workspace, terminology/runtime/IG adapters, mappings and provenance.
3. Existing IG platform: authenticated exact-commit GitHub ingestion, draft/review boundaries, build fixes and Dev deployment.
4. Integration: artifact repository, end-to-end accepted/rejected fixtures, openEHR regression, GitHub Dev delivery, separate production promotion and sanitized evidence.

## Verification record

The modeller delivery is merged through `611ce35b52f88aa091d39d96bdb572ac610c18e9`,
including upstream bounded task context and token budgets. All GitHub checks passed;
the inherited production deployment was skipped for this fork. Isolated Dev is at
`http://localhost:18350`.

[Executed Dev evidence](../../evidence/fhir-dev-20261007.json) records the PHP/chat/
browser/engine checks, twelve real browser acceptance steps, actual valid/invalid
HL7 validation, and the authenticated Git-to-IG handoff. Artefact commit
`117aabbe578e615a8fafa54afb463ba0ceed1490` imported a StructureDefinition as a draft;
an exact retry returned the same receipt. GitHub artefact CI independently recompiles
FSH and verifies generated output and positive/negative fixtures.

This evidence covers synthetic R4 development work. Remote terminology was not run,
clinical approval was not granted, and publication was not requested. XML originals
are preserved, while semantic processing currently uses JSON/FSH. The existing IG
platform owns its source/storage settings, review and distribution; its implementation
and deployment evidence remain in `CzarMich/hyq_fhir`. This recorded Dev evidence
predates the separate production promotion workflow and does not establish a
successful production rollout.
