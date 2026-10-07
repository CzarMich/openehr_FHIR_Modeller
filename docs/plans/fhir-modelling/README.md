# FHIR modelling development delivery

The user requirements in the three source files are retained verbatim; pasted XML fragments may be incomplete. The explicit existing-IG-server boundary takes precedence: this repository is an authoring, modelling, validation, governance client. It must not host a second public profile catalogue, IG distribution service or standalone IG management product.

- Modeller source: `CzarMich/openehr_FHIR_Modeller`.
- Existing IG server source: `CzarMich/hyq_fhir`, local `HYQ-FHIR-Governance-Platform`.
- FHIR engineering artifacts: `CzarMich/fhir_ig`.
- Deployment scope: isolated Dev only. Production promotion requires subsequent user testing and direction.
- Preserve inherited openEHR behaviour, source history and MIT/third-party notices.

## Workstreams

1. FHIR provider/tooling: exact-version package discovery, reuse, typed FSH generation, real compilation/validation, FHIRPath, semantic comparisons.
2. Modeller: independent FHIR project/configuration/artifact persistence, MCP, browser workspace, terminology/runtime/IG adapters, mappings and provenance.
3. Existing IG platform: authenticated exact-commit GitHub ingestion, draft/review boundaries, build fixes and Dev deployment.
4. Integration: artifact repository, end-to-end accepted/rejected fixtures, openEHR regression, Dev-only CI and sanitized evidence.

## Verification record

In progress. Implementation and executed evidence must be recorded separately; absence of a tool or external dependency never constitutes validation success. No production rollout is authorized.
