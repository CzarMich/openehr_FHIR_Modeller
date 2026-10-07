# ADR-0012: Preserve terminology operation evidence

Status: Accepted. Requirements: REQ-F14, REQ-N11.

## Context

FHIR terminology operations return different version identities. A ValueSet edition is independent of each contributing CodeSystem edition. Lookup designations and translation matches repeat and may contain nested parts. Flattening them into a scalar map loses evidence; selecting the last mapping can imply a clinical decision the platform did not make.

## Decision

Keep the domain provider independent of FHIR resource classes. Extend its existing optional arguments without changing positional meanings. Preserve the complete returned Parameters tree, retain repeated values, reject duplicate singleton results and keep separate version evidence for value sets, code systems and concept maps. Missing returned versions remain unconfirmed; mismatches fail closed.

Implement FHIR R4 ConceptMap translation as a read-only candidate operation. Preserve all relations, separate positive candidates from unmatched/disjoint results and require human review for every candidate. Do not rewrite a code or binding. Discover and resolve CodeSystem, ValueSet and ConceptMap resources only through the configured server. Canonical URLs and returned pagination links never become arbitrary outbound requests. Exact resolution requires a unique, complete search result; an omitted total does not establish uniqueness.

Expose bounded expansion pages with explicit completeness, hierarchy, filtering and offset evidence. A filtered complete expansion is complete only for that filter. Hierarchical and unclosed responses do not certify complete membership. Code validation and edition confirmation remain separate conclusions.

## Consequences

Existing lookup/validation scalar result keys remain available. Repeated designations/properties/matches are lists, and the full typed parameter tree is authoritative. Native model binding application, a managed local terminology catalogue and terminology lifecycle governance remain separate work. Remote terminology is optional; local snapshots and unbound modelling still work offline.

The adapter follows [FHIR R4 lookup](https://hl7.org/fhir/R4/codesystem-operation-lookup.html), [ValueSet validation](https://hl7.org/fhir/R4/valueset-operation-validate-code.html), [expansion](https://hl7.org/fhir/R4/valueset-operation-expand.html) and [ConceptMap translation](https://hl7.org/fhir/R4/conceptmap-operation-translate.html). Unit contracts and an authenticated HTTPS fixture exercise successful, negative, malformed and incomplete results through the production MCP container. Live acceptance records server capabilities independently of fixture coverage.
