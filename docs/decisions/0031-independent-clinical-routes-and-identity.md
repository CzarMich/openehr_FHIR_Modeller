# ADR-0031: Independent clinical routes and protected patient identity

- Status: Proposed
- Requirements: REQ-F33, REQ-F40, REQ-F41, REQ-F42, REQ-F43, REQ-F44
- Supersedes: the combined forward-route interpretation in ADR-0030

## Context

The required operations are independent mappings from source data to openEHR or FHIR, from openEHR to FHIR, and from FHIR to openEHR. An earlier implementation incorrectly interpreted source-to-FHIR as a two-stage path through an intermediate composition. Reinterpreting an already confirmed definition would change its clinical meaning without a user decision.

Clinical events may arrive out of order. A source patient identifier, an established source patient and an existing destination Patient are distinct facts. Logical FHIR references do not establish destination existence. Optional pseudonymisation must preserve the same scoped patient identity over time without disclosing the crosswalk.

## Decision

Use four independent, single-stage directions: `source-direct-to-fhir`, `source-to-openehr`, `openehr-to-fhir`, and `fhir-to-openehr`. Require the exact applicable input/output profiles and templates. Reject the retired `source-to-fhir` combined direction with an explicit review-required error. Keep historical definitions and decisions intact. Conversion creates a new mapping version requiring human confirmation.

Require a supplied source contract and a confirmed patient/reference/privacy policy for private clinical execution. Source contracts declare exact selectors, patient assigning authority, registration semantics, relationships and applicable source XML profiles. An authoritative marker in a source contract does not grant source trust: an operator-protected source or a separate authenticated human review must explicitly authorise the exact source configuration.

Store original held inputs and identity/dependency state in an encrypted private platform store. Preserve the encryption key; a missing or wrong key must fail closed. Require a verified patient identity in every privacy mode. Satisfy destination dependencies only from authenticated exact-identity responses bound to that patient. Lease execution and retain uncertain outcomes for reconciliation. Channels may accept later inputs while earlier records wait.

Bind destination privacy settings and their revision to the confirmed mapping. Pseudonymisation uses a persistent random scoped crosswalk, excludes declared direct identifiers from mapping input and checks final output. It does not establish anonymisation. Changing an identity policy after destination identity use requires a controlled migration; it must never create a second patient silently.

## Consequences

Old combined mappings remain inspectable but cannot execute unchanged. Private jobs without a source contract and patient policy require a new reviewed definition. Source and output validation remain independent of human confirmation and clinical approval. Source databases remain strictly read-only; internal operational storage and separately authorised destination APIs are distinct boundaries.

The transport/profile qualification matrix must identify tested versions and limits. Synthetic tests and file parsing do not establish acceptance for every HL7 interface, implementation guide or hospital installation. Security scanning and attack/load testing remain deferred by the user's current instruction.
