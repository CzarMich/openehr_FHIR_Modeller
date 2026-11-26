# First workflow: laboratory source to FHIR

Use this walkthrough to learn the implemented inspection and mapping-preview
workflow. It uses invented records only. It does not configure a patient-data
integration or send data to a clinical system.

## Before you start

Open the [production workspace](https://openehr-fhir-modeller.sandbox.hygeoniq.com/chat/)
and sign in, or connect an authorised MCP client to the deployment's `/mcp`
endpoint. Choose a project you may read/write. Ask the agent to discover tools;
it should find `fhir_project`, `fhir_dataset`, `fhir_mapping`, `fhir_artifact`
and the native openEHR authoring/compilation tools.

If FHIR tools are unavailable, ask the operator to check the configured private
FHIR engine. Enabling a language-model provider does not install that engine.
See [setup](../FHIR_DEV.md) and [browser use](../FHIR_WORKSPACE.md).

## 1. Choose the output constraints

Create a FHIR project in the workspace. Choose a release and exact package versions
before drafting mappings. For this exercise choose R4 (`4.0.1`) and the actual
laboratory IG/package supplied by your team. Do not substitute a generic profile
when a required IG profile is more restrictive.

Explain these facts to the agent: what a row represents; patient/encounter links;
result code/system; units/system; observation status; timestamps and time zones;
missing/unknown results; repeated observations; inclusion rules. Unspecified facts
must appear as unresolved questions, rather than guesses from field names.

## 2. Inspect a synthetic file

Save or paste this CSV as a synthetic fixture:

```csv
result_id,patient_id,result,unit
synthetic-result-1,synthetic-patient-1,0,mg/dL
synthetic-result-2,synthetic-patient-2,7.2,mg/dL
synthetic-result-3,synthetic-patient-3,,mg/dL
```

A connected agent can call the following tool. Replace only `projectId` with your
existing project identifier. `arguments` is a JSON string, as required by the tool.

```json
{
  "name": "fhir_dataset",
  "arguments": {
    "action": "inspect",
    "projectId": "YOUR_PROJECT_ID",
    "arguments": "{\"synthetic\":true,\"format\":\"csv\",\"sourceId\":\"synthetic-laboratory\",\"sourceVersion\":\"1\",\"content\":\"result_id,patient_id,result,unit\\nsynthetic-result-1,synthetic-patient-1,0,mg/dL\\nsynthetic-result-2,synthetic-patient-2,7.2,mg/dL\\nsynthetic-result-3,synthetic-patient-3,,mg/dL\\n\"}"
  }
}
```

Expect three records, field paths, a `schemaSha256`, source locations and unresolved
clinical interpretation. CSV values remain strings: an empty CSV cell is an empty
string, not an absent member or JSON null. The agent must propose an explicit
policy for the third result and a numeric conversion for the first two. The zero
must remain a valid value. Inspection does not return representative record values.

## 3. Supply or create the actual models

For **existing external models**, import/provide the template and applicable FHIR
StructureDefinitions, including original source, exact version, canonical/identifier
and dependencies. Do not supply credentials. The agent must retrieve and inspect
the content from the authorised project repository.

For **agent-modelled models**, search for reusable artefacts first. Draft and
compile the openEHR template; draft/compile the FHIR profiles. Review and confirm
both selections before using them for operational mapping. Technical compilation
and human confirmation are separate from clinical approval/publication.

Use `model_artifact_get` to retrieve openEHR repository content and
`fhir_artifact(action="get")` for the FHIR definition. Build `modelInputs` from the
returned project, path, revision, SHA-256 and explicit version. A binding looks like:

```json
{
  "standard": "FHIR",
  "projectId": "YOUR_PROJECT_ID",
  "path": "fhir/profiles/laboratory-result.json",
  "revision": "EXACT_RETURNED_REVISION",
  "sha256": "EXACT_RETURNED_SHA256",
  "version": "EXACT_PROFILE_VERSION"
}
```

Provide at least one binding for each standard to
`fhir_mapping(action="context", projectId, arguments)`. The context returns model
content, current-pin checks and confirmation blockers. A name, URL or approval flag
on its own does not provide the model. Do not fabricate revisions/hashes.

Prepare `fhir_mapping(action="prepare-confirmation")` with the exact bindings and
an `origin` on every entry: `agent-modelled` or `externally-provided`. In the browser,
open **Cross-standard mappings → Confirm models for mapping**, paste the returned
subject, inspect both model contents/pins, enter a comment and confirm. Include that
`confirmationSubject` in later context/preview requests. A human selection is not
clinical approval/publication; a changed model invalidates the selection.

## 4. Review the explicit mapping

Ask the agent for a versioned proposal containing:

- The original requirement and its interpretation, assumptions and unresolved points.
- Source and target paths for the source → openEHR stage and openEHR → FHIR stage.
- Explicit numeric, unit and terminology transformations; missing/null behaviour.
- Patient/encounter linkage, record identity, time handling and repeated observations.
- Unmapped fields, information loss and reversibility within a declared scope.

The current deterministic preview supports named JSON Pointer members and
`copy`, `number` and explicit dictionary `translate` operations. Forward mappings
have two stages; reverse mappings have independently authored rules. Joins,
grouping, arbitrary expressions and automatic inverse generation are not provided
by this preview. Report unsupported requirements instead of silently dropping them.
See the [exact mapping contract](../SOURCE_MODELLING.md#mcp-usage).

## 5. Preview and validate

Call `fhir_mapping(action="preview")` with `synthetic:true`, the inspected records,
source identifiers, current `modelInputs`, its `confirmationSubject` and the reviewed mapping containing its
`sourceSchemaSha256`. Inspect transformed/rejected counts, field provenance and
unmapped content. Rerun the same inputs to check stable preview identifiers. Change
a model revision and verify that stale inputs are rejected.

A preview reports `emitted:0` and validation `NOT_EXECUTED`. It does not write to a
CDR, FHIR destination or model repository. Run the installed compiler and FHIR
validator separately. Do not describe an intermediate object as a validated
openEHR composition unless the exact-template composition validator has run.

Define a reverse mapping separately and compare the declared semantic invariants:
zero versus missing, units and codes, identifiers, time precision and relationships.
A stable preview ID is not proof of destination idempotency.

## 6. Operational processing and FHIR delivery

The required production processing path is:

**Configured source → approved rules/exact models → validated records → private
export or authorised FHIR destination → reconciliation.**

Keep raw records and quarantined failures in the private processing runtime, outside
model Git repositories, general MCP responses and AI conversations. Before delivery,
select an operator-configured destination, review permitted resource types and write
mode, and define stable identities/retry behaviour. Validate against the selected
release/profiles; handle transaction/entry failures and retain an audit of delivery
counts without logging clinical values or credentials.

This operational path, including FHIR destination push, is not implemented by the
current synthetic-preview tools. Do not use `fhir_ig submit` for patient resources:
that operation hands model drafts to the governance platform. Track current delivery
status in the [README](../../README.md#available-today-and-remaining-work) and
[implementation contract](../SOURCE_MODELLING.md).

## When something fails

| Finding | Action |
|---|---|
| FHIR tools unavailable | Operator checks engine configuration/readiness and access |
| Clinical meaning unresolved | Supply a dictionary, declared requirements or a human decision |
| Required model missing | Provide the actual template/profile and dependencies |
| Stale model/source | Retrieve current content, inspect again and review updated rules |
| Numeric/terminology rejection | Correct the explicit rule or quarantine the affected record |
| Validator not executed | Run the actual installed validator; keep status `NOT_EXECUTED` until then |
| Approval blocker | Use the human review process; never set an approval flag in tool arguments |
| Need to send resources | Use the qualified operational delivery path when available; previews do not deliver |
