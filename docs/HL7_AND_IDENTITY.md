# HL7, dependency handling and patient identity

## Current implementation status

Native HL7 v2, HL7 v3 and CDA intake is under development. It is not enabled in the deployed runtime. The existing generic XML reader is not an HL7 validator. Do not route clinical HL7 traffic into that reader as a substitute for a qualified connector.

The feature branch adds deterministic route definitions and tests for source-to-openEHR and canonical-openEHR-to-FHIR alongside the existing direct-FHIR and openEHR-mediated paths. A separate private operational assembly contains a tested encrypted patient registry and durable dependency queue. These are domain components, not an enabled clinical workflow. The HL7 parsers/transports, source profiles, verified destination lookup, protected HTTP adapters, UI controls and end-to-end qualification are still being connected. The status table must be updated from real release evidence before claiming support.

## Intended routes

| Route | Required exact models |
|---|---|
| HL7 to openEHR | Reviewed source interface profile and applicable compiled openEHR template |
| HL7 directly to FHIR | Reviewed source interface profile and target FHIR StructureDefinitions with exact release/dependencies |
| HL7 through openEHR to FHIR | Reviewed source profile, applicable openEHR template and FHIR StructureDefinitions |
| openEHR to FHIR | Actual source composition template and target FHIR StructureDefinitions |

Agent-authored and externally supplied target models both require human confirmation for the executable mapping. User narrative, interpretations, assumptions and synthetic examples remain versioned. A parser result is not clinical approval. Deterministic processing does not call an AI model for each message.

## Out-of-order arrival

A verified patient identity is a mandatory prerequisite. An Encounter can arrive before its Patient; an Observation can arrive before its Encounter. Hold the input privately until the declared dependencies are satisfied. A known identifier and an existing destination resource are separate facts.

The dependency scope includes the owner/organisation boundary, project, trusted source system and destination. Identifiers retain their assigning authority and exact value, including leading zeros. Do not correlate unrelated systems by a bare number, demographic similarity or AI inference.

Successful destination receipts or authenticated read results can establish resource availability. Queue acceptance is not successful clinical delivery. Required dependencies come from the confirmed mapping and interface contract; do not invent clinical requirements from generic XML shape. Restart must preserve the original input, source hash, model/rule pins, privacy-policy revision and processing state.

A duplicate message with identical original content reuses its existing queue item. A reused message-control identifier with different content is a conflict. Expired inputs remain available privately for operator review. A crashed processing lease or uncertain write requires reconciliation, not an automatic repeat. Quarantine, waiting, expiry, identity conflict and delivery failure are distinct conditions.

## Logical and literal FHIR references

Choose the reference policy per relationship in the reviewed mapping:

| Choice | Behaviour |
|---|---|
| Logical | Emit `Reference.identifier` with its system and value when the target profile and destination permit it |
| Literal | Emit a verified resource address, such as `Patient/123` |
| Resolve to literal | Resolve the scoped business identifier to one destination resource, then emit its address; zero or multiple matches hold the input |

A logical reference does not guarantee automatic resolution by a server. It never bypasses the mandatory verified-patient prerequisite. Whether the destination Patient must already exist is a separate declared destination/profile dependency. Never create a placeholder Patient or assume an Encounter belongs to a patient from arrival order alone.

See the [FHIR R4 reference specification](https://hl7.org/fhir/R4/references.html); use the exact release selected by the project for conformance work.

## Pseudonymisation option

The intended UI exposes **Pseudonymise patient identifiers** in destination settings. The selected policy and identifier namespace are bound to the channel's reviewed configuration. The option is not yet connected to the deployed UI.

The patient prerequisite stays mandatory with the toggle on or off. Once an authoritative patient event has been verified, the private registry can allocate and reuse one stable opaque pseudonym in its configured scope. Repeated records and platform restarts must not regenerate it. Changing the privacy option or its namespace requires a new reviewed policy revision; active or uncertain processing prevents a silent policy change.

For a pseudonymised openEHR destination, use the pseudonym as the approved subject identity. The real-identity crosswalk stays in the restricted platform registry. OpenEHR uses an EHR subject identity rather than a FHIR Patient resource. See the [openEHR EHR information model](https://specifications.openehr.org/releases/RM/latest/ehr.html).

Pseudonymising one identifier does not remove identifiers elsewhere in a clinical document. The output policy must control direct identifiers in structured fields, narrative and attachments before delivery. Pseudonymised records remain linkable through the protected crosswalk and must not be treated as anonymous data.

## Privacy and operational boundaries

Clinical/source databases remain strictly read-only with no override. The internal operational registry is application state and is separate from all source database profiles. Destination API writes are separately authorised. Patient content, crosswalks, private queue inputs and identity-resolution results must not enter general MCP, chat, reusable AI context or model-provider training.

The new domain store uses authenticated encryption for record payloads and keyed identifier indexes. Its encryption key is installation state, must survive upgrades and must remain outside Git/images. Opening an existing registry with an incorrect key fails closed; it must not create a second pseudonym registry. Key rotation and restore need an explicit migration procedure before production use. Group monitoring grants must reveal operational counts rather than clinical identifiers or payloads.

The current queue has bounded admission and holds original normalised input; final retention, archival, acknowledgement and reconciliation controls still need runtime/UI acceptance. No synthetic test establishes qualification against a hospital interface.

## Qualification and documentation

Publish a matrix of exact HL7 versions, message families, transport modes, interface profiles and CDA/v3 implementation guides. The selected nHapi dependency provides generated v2 models through 2.8.1; later versions require an explicit supported validation route before they can be advertised. Source-specific Z segments and local rules need the actual supplied interface contract.

V3/CDA XML needs the applicable schemas and semantic/template rules; XML parsing and XSD alone do not establish every implementation-guide constraint. Preserve source-model licences and exact package hashes. See the [HL7 CDA specification](https://hl7.org/cda/stds/core/overview.html) and [official CDA schema source](https://github.com/HL7/CDA-core-2.0).

Acceptance must cover Patient/Encounter/Observation arrival permutations, absent and conflicting identities, duplicate control IDs, restarts, lease expiry, pseudonym stability and isolation, policy changes, reference modes, real validation and controlled delivery. Source database write probes, vulnerability scans and attack/load testing remain deferred as requested.
