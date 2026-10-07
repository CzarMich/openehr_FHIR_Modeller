# ADR-0013: Project terminology catalogue over the model repository

Status: Accepted. Requirements: REQ-F12, REQ-F14, REQ-N11.

## Context

External terminology operations do not provide a managed project inventory or offline modelling. Local code systems, value sets and mapping drafts need explicit editions, provenance, history and conflict handling without assuming a particular server, repository provider or LLM. A partial code-system snapshot must not be used to prove an unknown code invalid.

## Decision

Use an internal, closed record schema for CodeSystem, multi-system ValueSet and ConceptMap records. Require canonical/edition identity and declared provenance. Derive repository paths from a hash of that identity, retain ordinary DRAFT artifact revisions and perform writes through the existing access policy and repository compare-and-swap contract. Catalogue reads verify identity even after an external Git edit.

Keep local terminology operations pure and deterministic. Respect code-system case rules, explicit parent graphs, fragment coverage and independent code-system/value-set editions. Search names/descriptions without embeddings. Preserve all mapping candidates and unresolved conditions for human review. Never apply a mapping automatically or accept approval fields as catalogue metadata.

Treat external references as references, without asserted local content or completeness. Route them only to configured terminology and mapping provider interfaces, pinning their recorded edition. An unavailable server cannot become successful local validation. Preserve legacy explicit value-set/binding formats; migration is an intentional draft save, not an automatic content rewrite.

## Consequences

Filesystem, Git/hosted Git and SharePoint share catalogue semantics and contract tests. Search returns bounded summaries; selected records and historical revisions are explicit reads. Corrupt records remain QA findings. The catalogue has explicit size/scan limits; it is not a claim of qualified large-scale indexing, terminology publication or native ADL/OET constraint application. Repository revisions and hashes provide evidence for subsequent binding and release workflows.

Unicode case folding requires the declared PHP `mbstring` extension. No new runtime service or client SDK is required. Browser saves retain exact-record confirmation and remain separate from clinical approval.
