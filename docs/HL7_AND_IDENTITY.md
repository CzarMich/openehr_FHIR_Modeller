# HL7, patient identity and out-of-order records

## Delivery status

This guide describes the clinical-runtime feature branch. The released platform must not be described as supporting these operations until its exact images have passed hosted CI, actual Dev acceptance and production promotion. The branch includes HL7 readers, source projection/profile validation, a private identity/dependency store, worker admission, destination evidence checks, reviewed recovery controls and channel resumption. End-to-end acceptance and operational controls are being completed.

## Four independent mapping routes

| Mapping | Models required |
|---|---|
| Source data → FHIR | Supplied source contract and exact target FHIR StructureDefinitions |
| Source data → openEHR | Supplied source contract and exact target compiled openEHR template |
| openEHR → FHIR | Supplied source contract, exact input openEHR template and target FHIR StructureDefinitions |
| FHIR → openEHR | Supplied source contract, exact input FHIR StructureDefinitions and target openEHR template |

Each route has its own mapping rules, examples, version and human confirmation. Source-to-FHIR does not pass through openEHR. `source-direct-to-fhir` is the execution identifier for that direct route. The former combined `source-to-fhir` value is retired. Preserve its historical decision and create a new independent mapping version for review; the runtime never silently converts it.

Both supplied external and agent-authored profiles/templates must be provided as actual content and confirmed by a user for this mapping. A model name, URL or successful technical check is insufficient. Original user instructions, assumptions, proposed interpretations and corrections remain versioned. Unresolved meanings block confirmation. Clinical approval is separate.

## Source formats and validation scope

| Format | Reader and validation boundary |
|---|---|
| HL7 v2 ER7 | Typed nHapi models for 2.1, 2.2, 2.3, 2.3.1, 2.4, 2.5, 2.5.1, 2.6, 2.7, 2.7.1, 2.8 and 2.8.1. Preserve wire fields, repetitions, empty values, explicit nulls and typed groups/components. Enforce the confirmed version/message-type scope. |
| HL7 v2 XML | Secure XML preflight and typed v2 parsing. Require a supplied XML validation profile. ER7 also provides canonical v2 XML for profile checks and XPath projection. |
| HL7 v3 interaction XML | Preserve the declared interaction and ordered XML content. Require a supplied exact XSD package and declared semantic assertions; generic XML parsing alone is insufficient. |
| CDA XML | Preserve ordered narrative nodes and document structure. Require the supplied document profile. XSD and explicit boolean XPath assertions are available; full Schematron/XSLT 2 implementation-guide validation is not implemented. |

Private file upload and registered-folder intake are the implemented transport path in this branch. MLLP-framed file bytes and concatenated ER7 messages can be read. **A network MLLP listener, automatic ACK exchange, SOAP transport and universal v3 interaction handling are not implemented.** FHS/BHS batch-envelope handling and later v2 model releases require additional explicit support. Do not advertise file decoding as network interface qualification.

V2 decoding accepts declared UTF-8, ASCII and the implemented ISO-8859 variants with strict decoding. Unsupported character-set switching is rejected. XML prohibits DTDs and external resolution. Supplied XSD imports resolve only inside the pinned in-memory package. Source validation never fetches schemas from an incoming document's URLs. Scalar XPath fields reject nested/mixed elements rather than flattening clinical narrative silently. Original bytes remain available for controlled review.

Source contracts contain selectors and interface semantics, never real patient examples, credentials or arbitrary SQL. Supply them through **Models → Source contract** and select the exact version with the target models. Private inspection returns paths/types and message metadata, without patient sample values. Bounded inspection may report incomplete field coverage; it does not infer clinical meaning.

## Mandatory patient prerequisite and durable holds

Every private clinical run requires an exact source contract and clinical policy. The policy names the stable identity domain shared by related interfaces and the destination. Do not use a channel identifier as the patient identity domain. Identical numbers under different assigning authorities remain different identities; leading zeros and case are preserved.

Only an explicitly trusted registration source can establish a patient. An Observation containing a patient number does not create a patient automatically. Users review the exact source configuration separately from the mapping. Registration authority in the source contract and source trust must both be present.

An Encounter waits for its required destination Patient. An Observation waits for its required Encounter, and destination evidence must bind that Encounter directly to the same patient. No demographic guessing, invented placeholder patient or cross-patient relationship is permitted. Authenticated exact-identifier searches reject ambiguity. A logical reference may be rendered without a destination address, but a configured destination prerequisite still has to be satisfied.

Admission atomically saves encrypted original bytes and queue state before reporting a hold. Queued jobs resume from those originals even if the source file moves. Queue state, scope, source hash, mapping subject/hash and privacy revision remain pinned across restart. Channels continue admitting later files and retry held jobs fairly. A restart requires explicit channel resume. Unknown IDs, absent relationship identifiers and conflicts remain held for review. When a later trusted registration supplies the patient identifier and the same exact, approved stable patient anchor, the runtime can release the matching held input without an AI call. No anchor match means no automatic correlation. A changed identifier on an existing anchor is an identity conflict; it never generates a second pseudonym automatically.

Execution uses a bounded lease. A crash or uncertain destination write requires reconciliation rather than blind retry. A processing failure before writing requires review. Expiry retains the input; it does not delete clinical records. The active queue limit applies separately to each intake, so a full child intake does not consume another intake’s admission capacity. Final queue states do not permanently occupy active capacity. Storage quotas and checkpoint limits stop new admission explicitly. They do not authorise dropping an acknowledged item. Retention, expiry resolution, patient merges and key rotation require controlled operational procedures; the corresponding UI workflows remain incomplete.

## Reviewing held records and interrupted delivery

Use **Jobs & monitoring → Review held identities and uncertain delivery** with an owned private job and its record number. These actions require a fresh authenticated human reviewer with project write access and the approver or administrator role. Monitoring access alone does not grant this permission. Each proposed change is previewed, then explicitly confirmed against the current record revision, source hash, mapping and reviewer comment.

- **Resolve Patient:** select an already verified patient identifier with its assigning authority. This does not create a patient from a free-text assertion or change an identifier already attached to the record.
- **Resolve relationship:** supply the missing relationship role and business identifier. The runtime uses the confirmed mapping to determine the resource type and destination, reads the actual destination, and requires an unambiguous direct binding to the same verified Patient. A wrong-patient Encounter is rejected.
- **Check delivery:** read the configured destination and compare every resource in the encrypted saved delivery plan. This action performs no destination writes.
- **Confirm delivery:** finish only when the entire saved plan is present and matches the expected content and patient prerequisites.
- **Retry missing:** after an explicit human decision, retain verified receipts and allow only absent conditional creates to resume. An asynchronous or lost response remains uncertain until authenticated read-back establishes what committed.

The complete validated delivery plan is saved before the first write. Reviewer decisions and authenticated evidence are recorded separately from immutable source bytes. A changed mapping, policy or source invalidates an outstanding decision. A conflict remains held; the application does not treat a reviewer’s assertion as destination evidence. Recovery does not provide arbitrary resource updates or patient merges.

The **Received source** download retrieves the retained original from the private encrypted store, including after the intake file has moved. The file belongs to the job owner and remains outside general MCP and model context. Downloads are private clinical material and require the same care as the original source.

## openEHR patient context and export association

An openEHR composition does not itself provide a universal Patient identifier field. Supply the patient context explicitly in the approved source contract. The source may be a canonical composition or an envelope with a `composition` object plus separately supplied patient context. Projection selectors can address that context; native input validation receives the canonical composition only. Do not infer the patient from the composer, author or clinician name.

For example, an envelope can contain `patient.id`, `patient.key` and `composition`. Define the exact assigning authority and JSON Pointers in the source contract. A stable patient key is meaningful only when the source interface explicitly guarantees its identity semantics. These aliases are installation-specific, not openEHR Reference Model attributes.

Private exports include a separate patient association index alongside the validated resources. It records each output hash, the approved outbound patient identity, destination and policy revision. When pseudonymisation is enabled, the association uses the pseudonym identity. This index supports downstream association; it is not evidence that a composition was committed to an openEHR CDR. Direct openEHR CDR submission is not implemented by this worker.

## Reference and pseudonymisation controls

Use **Mapping & review → Patient identity, references and pseudonymisation**. Load the destination's current identity settings. The patient prerequisite is always enabled. Review and save the pseudonymisation toggle and identifier system, then apply that exact policy revision to a new mapping draft and obtain human confirmation. Reference rows select the source relation, target resource type, output path, mode and destination-existence requirement.

- **Logical:** emit `Reference.identifier` with its assigning authority. This does not instruct a FHIR server to resolve it automatically.
- **Literal:** verify the mapping's explicit local reference against destination evidence.
- **Resolve to literal:** use the exact authenticated destination match; an absent or ambiguous match stays held.

The exact destination profiles still validate the resulting resource. A syntactically valid reference is insufficient evidence of identity or clinical correctness.

Pseudonyms are stable, random and scoped to the authorised project, identity domain and destination. Every record checks the registry. Patient registrations, held records and originals are owner-private. Destination privacy settings are shared within the authorised project and destination; independently verified operators can reuse the same opaque pseudonym for the same identity domain without gaining access to one another’s registrations or source records. The private crosswalk survives restart and is never supplied to general MCP tools or model providers. Declared direct identifiers and narrative are excluded from pseudonymised mapping input; output checks reject retained source identifiers. FHIR Patient identifiers and patient references use the configured pseudonym identity. This is **pseudonymisation, not anonymisation**: source classification, data minimisation and the reviewed output contract remain essential.

Policy changes are fenced while processing is active or uncertain. After destination identity use, changing the mode or namespace requires migration; silently generating a new identity is forbidden. Never delete the registry or replace its key to bypass this condition. Back up the encrypted store and original key together. A missing key beside an existing store, a wrong key or integrity failure stops processing.

## Privacy and source databases

**All clinical/source database connections are READ ONLY, without an override.** The private SQLite identity/queue store is internal application state, not a clinical source database. Authorised FHIR destination writes use a separate HTTP credential. No source connector may perform DML, DDL, migrations, permission changes or write-capable procedures.

Patient records, private validation findings, crosswalks and held originals stay outside model Git, general MCP responses, reusable AI context and provider training. Team view/monitor access exposes operational summaries, not private records or permission to operate channels.

## Acceptance

Domain, worker and browser tests use synthetic data. Actual FHIR/openEHR engines validate their respective supplied models and output fixtures. This evidence is distinct from clinical approval and acceptance against a hospital's interface, database, Epic installation or CDR. See [testing](testing.md), [security](SECURITY.md), [read-only policy](CLINICAL_DATA_READ_ONLY.md) and [ADR-0031](decisions/0031-independent-clinical-routes-and-identity.md).
