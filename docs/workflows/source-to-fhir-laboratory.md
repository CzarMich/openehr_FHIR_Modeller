# Source data to FHIR

This walkthrough uses the integration workspace for an independent **source → FHIR** mapping. It does not create an intermediate openEHR composition. The other independent routes are source → openEHR, openEHR → FHIR and FHIR → openEHR. See [integration operations](../INTEGRATION_ENGINE.md) and [HL7 and patient identity](../HL7_AND_IDENTITY.md) for the implementation/release status and limits.

Use synthetic examples while designing rules. Real records belong only in private file intake or a qualified clinical-source connector, never in chat, a model repository, MCP examples or reusable AI memory. Every clinical/source database connection remains strictly **READ ONLY**, without an override. FHIR destination delivery is a separately authorised HTTP operation.

## 1. Choose the purpose and target profiles

Create a project with the actual FHIR release and package dependencies. Describe the intended resource, source meaning, units, identifiers, terminology, missing-value behaviour and intended information loss. Retrieve the actual target StructureDefinitions and their dependencies from the applicable implementation guide. Keep their canonical identities, exact versions and provenance.

For source-to-FHIR, supply the FHIR models needed by the outputs. An unrelated openEHR template is not required. Both externally obtained and agent-authored profiles must be provided as usable content and confirmed by a user for this mapping. Technical validation and mapping confirmation do not establish clinical approval.

## 2. Define the source contract

Supply a **Source contract** model in the Models tab. It describes field selectors and interface semantics, not patient examples. For example, this contract describes a deliberately synthetic registration CSV:

```json
{
  "schemaVersion": 1,
  "format": "csv",
  "versions": [],
  "messageTypes": [],
  "fields": [
    {"name": "patientId", "kind": "json-pointer", "path": "/patientId", "classification": "patient-identifier"},
    {"name": "name", "kind": "json-pointer", "path": "/name", "classification": "direct-identifier"}
  ],
  "patient": {
    "identifierField": "patientId",
    "anchorField": "patientId",
    "system": "urn:example:synthetic-patient-id",
    "authoritativeRegistration": true
  },
  "relations": []
}
```

Use the actual assigning authority and stable source patient anchor for a real interface. Declaring an authoritative source in this contract does not grant trust by itself. An authorised person must separately review the exact source connection before it can establish patients.

An Observation or Encounter source normally refers to a patient already established by a trusted registration interface. Declare the required relationships and exact assigning authorities. Do not turn arbitrary observations into authoritative patient registrations to bypass a hold.

## 3. Inspect structure privately

Choose **Private source**, select the format and enter the stable patient identity domain shared by related interfaces. Upload the file privately, or choose an authorised registered folder. Inspection returns paths/types without sample patient values. It does not determine clinical meaning.

For the synthetic contract above, a test file could contain:

```csv
patientId,name
synthetic-1,Synthetic One
synthetic-2,Synthetic Two
```

Use the confirmed contract's projected field names in the mapping. The schema hash must match those projected records. If selectors rename or restructure fields, the raw file inspection hash alone is insufficient; inspect the declared projection and resolve differences before confirmation. Do not invent a hash or assume that similar column names have the same meaning.

## 4. Prepare explicit rules and identity settings

Ask the modelling client to retrieve `modelling_mapping(action=help)` before drafting a version 2 integration mapping. Select `source-direct-to-fhir`. Define one transformation stage, original user requirements, rule interpretations/assumptions, missing/null policies and explicit synthetic expected outputs. Include the actual projected source schema/hash. Resolve all questions before confirmation.

In **Mapping & review → Patient identity, references and pseudonymisation**, enter the matching identity domain and stable destination identifier. Load the current destination settings. If changing the pseudonymisation toggle or namespace, review and save the change. Configure each required Patient/Encounter relationship, its output path, reference mode and destination-existence requirement. The verified patient prerequisite is always enabled.

Select exactly one supplied source contract alongside the applicable FHIR profiles. **Apply settings to mapping draft** binds the source contract key and current clinical policy revision. Give any changed rules or identity settings a new mapping version. Prepare the selection, inspect the exact models/rules/examples, acknowledge the review and record a human confirmation comment. An agent cannot perform this confirmation.

Logical references identify a resource by assigning authority and identifier. They do not establish that a destination resource exists or that the server will resolve it. Literal and resolve-to-literal modes require exact authenticated destination evidence. Profile validation still runs after references are rendered.

## 5. Review source trust and run

If the selected source is an authoritative registration interface, open **Private source → Authoritative patient registration**, enter a review reason and inspect the exact source configuration. Confirm the trust operation in **Run & channels**. This action does not disclose records to an AI provider and does not authorise a source database write.

Choose **Validate and export**, or a separately authorised FHIR destination, then review and confirm the run. The worker rechecks current mapping confirmation, source/model pins, identity policy and destination scope. It executes deterministic rules and the actual FHIR validator. No per-record LLM call is made.

Unknown patients or required missing destination entities remain held. An Encounter can wait for its Patient, and an Observation for its Encounter. The encrypted queue retains original bytes. Channels continue with later files and revisit held work, so a later verified parent can release its dependent record. A hold is distinct from a rejected record or an uncertain write.

## 6. Inspect outcomes and operate a channel

Use **Jobs & monitoring** for counts, hold/error codes, private reports and validated exports. Confirm the output against the actual supplied profiles and clinical acceptance criteria. A synthetic test or successful export is not hospital qualification.

Assign the confirmed mapping to a channel in **Run & channels**, review the source/destination, polling interval and failure policy, and explicitly start it. The assignment retains its mapping version. Share view/monitor access through **Groups & access**; this does not grant private-record access, operation or clinical approval.

An uncertain write requires reconciliation before retry. Do not delete queue state, replace encryption keys or fabricate a Patient to clear a hold. Changing an already used destination pseudonym policy requires a controlled identity migration. Consult the [operational limits](../HL7_AND_IDENTITY.md) before enabling a real clinical interface.
