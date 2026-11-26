# Source-driven modelling: audit and implementation contract

## Audit

Baseline: 7578ac0. Reuse CKM federation, NativeModels/TemplateBuilds, exact-version
FHIR project/packages, real SUSHI/validator engine, repository revisions, protected
human review, browser tools and existing IG draft handoff. Existing fhir_mapping
saves proposals and analyses correspondences; it does not transform records.
There is no extraction connector framework or production transformation runner.

## Workflow and boundaries

Select the FHIR release and exact IG dependencies first. Inspect source structure,
record unresolved clinical meanings and review explicit rules. Search existing
models before authoring. Whether reused or newly authored, supply the exact
openEHR template and FHIR profiles used for mapping. Compilation, validation and
human approval are separate. The agent can retrieve model content and readiness;
it cannot approve a model. Changes invalidate the pinned mapping inputs.

The first increment provides bounded synthetic CSV/custom JSON inspection and
explicit deterministic JSON Pointer mapping previews in either declared direction.
Custom JSON remains custom JSON even when it has resourceType. Intermediate
openEHR-shaped JSON is not proof of composition conformance. Actual template
compilation and FHIR validation remain existing explicit engine operations.
No CDR is required and no patient values belong in MCP, model stores or logs.
Operational retrieval, jobs and data handling require a separate private runtime.

## Delivery backlog

- Implemented: source-description schema, bounded CSV/JSON inspection, missingness,
  source locations, unresolved meaning, explicit two-stage synthetic mapping,
  separately defined reverse rules, zero/null/absent handling, terminology lookup,
  numeric conversion, unmapped-field reporting, stable preview IDs and rejected
  records; exact-model context/readiness through existing repository/review state.
- Partial A: real laboratory template/profile authoring uses existing tools;
  automatic source-driven model generation and full composition validation are
  not delivered. Preview validation is NOT_EXECUTED, never conformance evidence.
- Next A: private source connectors, reviewed rule persistence, complete laboratory
  integration fixtures, qualified model validators, operational quarantine/jobs,
  browser source-to-run workspace and live compiler acceptance.
- B: configured folder/XLSX and explicit SQL drivers (not implemented).
- C: FHIR endpoint/export parser and reference handling (not implemented);
  separately authored reverse preview rules are available.
- D/E: HL7 v2, CDA/v3, EPID and extension registration (not implemented).

## MCP usage

`fhir_dataset(action="inspect", projectId, arguments)` accepts format csv/json,
content (synthetic only), sourceId and sourceVersion. No paths, URLs or credentials.
CSV requires unique headers and consistent widths. JSON accepts an array of plain
record objects. Both reject more than 100 records or 256 KiB. Inspection exposes
field types and missingness without value samples. Schema fingerprints exclude
record values. Clinical interpretation stays unresolved until explicitly supplied.

`fhir_mapping(action="context", ...)` takes modelInputs: an array containing at
least one openEHR and one FHIR entry. Each requires standard, projectId, path,
revision, sha256, version and optionally reviewSubject. It returns current content,
actual hashes and approval blockers. Combined model content is limited to 4 MiB. Imported copies do not inherit approval.

`fhir_mapping(action="preview", ...)` takes synthetic:true, records, sourceId,
sourceVersion, mapping and modelInputs. Mapping has schemaVersion:1, version,
direction (source-to-fhir or fhir-to-openehr), sourceSchemaSha256, reversibility,
and stages:[{rules:[...]}]. Forward requires two stages, reverse one. A rule has
source/target JSON Pointers, operation (copy/number/translate), missing
(reject/omit), null (reject/preserve/omit), description, and optional factor,
offset or dictionary. Forward stages explicitly construct the intermediate
representation then final output. Targets must not overlap. No expressions,
network access, defaults or implicit inverse are supported. Inspect the exact
input records first to obtain sourceSchemaSha256. Unknown fields are reported.

Preview is always unapproved and non-operational, with validation NOT_EXECUTED;
readiness includes separate protected review status. Existing proposal save
behaviour remains compatible. No preview records are persisted or audited.
