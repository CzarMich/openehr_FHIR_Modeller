# ADR-0016: Versioned requirements graph and evidence boundaries

- Status: Accepted

## Decision

Store a bounded typed graph at `requirements/traceability.json` through the existing ModelRepository contract. Requirements and modelling decisions carry explicit provenance/rationale; model nodes pin source path, revision and hash. Validation/review nodes reference the separate authoritative governance ledger by subject, sequence and event hash. The graph remains writable draft content and cannot manufacture clinical approval or passing validation.

Keep graph validation/traversal in the domain, reference resolution and persistence in shared application services, and document-anchor inspection behind a domain interface. MCP is a thin adapter. XML positional locations and nonempty JSON pointers resolve deterministically; inherited openEHR paths remain explicitly unexecuted until the qualified engine is integrated. JSON pointers follow RFC 6901 with native JSON parsing, bounded duplicate-key detection and no URI-fragment evaluation.

Separate declared full/partial coverage from reference freshness, executed validation and clinical satisfaction. Answer “why” using explicit incoming requirement/decision trails and “which elements” using explicit coverage edges. Persist historical revisions and recompute current-source findings on reads. Do not infer clinical evidence from the presence of a link, an uploaded report or a repository metadata field.

## Consequences

The same logical graph and history work on filesystem, Git and SharePoint. No graph database, embedding service, terminology server or LLM provider is required. Limits, type checks, cycle detection, adjacency-list traversal and pinned project-local references bound work and prevent arbitrary external execution. Repository/ledger reads and graph saves are separate operations; they are not a distributed transaction. Qualified build evidence must later pin the graph revision alongside model and dependency inputs.

The legacy declaration coverage tool remains compatible. Adoption is explicit because automatically importing arbitrary requirement files would invent schema and clinical meaning. The graph stores asserted relationships; native dependency compatibility and semantic satisfaction belong to qualified validation and human review.
