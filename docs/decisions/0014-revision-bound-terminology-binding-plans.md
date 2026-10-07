# ADR-0014: Revision-bound terminology binding plans

- Status: Accepted

## Context

Coded constraints, archetype-local terminology identifiers and relative paths cannot safely be interpreted as universal FHIR bindings. OET named terminology queries are not canonical ValueSet declarations. Repeated archetype placements may expose the same relative path. Full inherited ADL/AOM semantics require the qualified openEHR engine.

The native XML profile was inspected through the [ITS-XML development component](https://specifications.openehr.org/releases/ITS-XML/development), including [OET CompositionTemplate](https://specifications.openehr.org/releases/ITS-XML/development/components/OET/latest/CompositionTemplate.xsd), [AM 1.4 OpenEHR profile](https://specifications.openehr.org/releases/ITS-XML/development/components/AM/Release-1.4/OpenehrProfile.xsd), and [AOM 2 development](https://specifications.openehr.org/releases/AM/development/AOM2.html). The `latest` path segment is an XML component directory within the development stream. These profiles informed inspection; they were not incorporated as a conformance validator.

## Decision

Use a domain inspector interface, an XML adapter, a pure deterministic planner and a repository application service. MCP and browser chat call the service. Preserve original source bytes and existing native references. Identify XML elements by revision-bound positions plus declared path/archetype context. Reject ambiguous targets in the existing binding checker.

Offer local ValueSet candidates only from explicit matching system/code membership. Do not infer editions, choose clinical suitability, widen constraints or replace codes. Named identifiers require explicit canonical aliases; archetype-local aliases require archetype scope. Validate against an explicitly pinned local CodeSystem edition where available. Report every unexecuted step and unresolved choice. External terminology remains optional.

Persist server-generated plans through the existing repository contract with conditional DRAFT writes, source identity, catalogue manifest and findings. Compare saved analysis with current inputs when reading, including new catalogue resources. This is revision-bound evidence, not a multi-artefact atomic transaction, signed attestation or human approval.

## Consequences

Models can prepare auditable terminology decisions offline across filesystem, Git and SharePoint. Bounds prevent uncontrolled catalogue/constraint scans. Native application, inherited semantics and compilation remain explicit qualified-engine work. No second ADL parser is introduced into PHP. Existing clients with ambiguous relative binding targets must now provide the recorded `target_location` or resolve the ambiguity.
