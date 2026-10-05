# Architecture Decision Records

Architecturally significant decisions for the openEHR Modelling Assistant,
recorded in a lightweight [MADR](https://adr.github.io/madr/) style. Each record
is immutable once `Accepted`; to change a decision, add a new ADR that
`Supersedes` it rather than editing history.

Part of the [Specification-Driven Development docs](../README.md). ADRs are
referenced from [requirements.md](../requirements.md),
[architecture.md](../architecture.md), and the
[traceability matrix](../traceability.md).

> **Note on the codebase-memory ADR.** A condensed architecture summary also
> lives in the `codebase-memory` knowledge graph (`manage_adr`) as AI-grounding
> context. These committed records are the human-reviewable source of truth; the
> in-graph copy is a convenience mirror.

| ADR | Title | Status | Requirements |
|-----|-------|--------|--------------|
| [0001](0001-attribute-driven-discovery.md) | Attribute-driven capability discovery with startup cache | Accepted | REQ-N4 |
| [0002](0002-single-ckmclient-http-boundary.md) | Single `CkmClient` external HTTP boundary, mocked in tests | Accepted | REQ-F1, REQ-N2 |
| [0003](0003-prompt-policy-split.md) | Split global policy from task-specific prompt content | Accepted | REQ-F6, REQ-F10, REQ-N7 |
| [0004](0004-docker-only-runtime.md) | Docker-only runtime; no host PHP/Composer | Accepted | REQ-N5 |
| [0005](0005-spec-aligned-content-retrieval.md) | Authoritative, cheapest-first specification retrieval | Accepted | REQ-N1 |
| [0006](0006-machine-checked-traceability.md) | Machine-checked traceability with a `spec-check` drift gate | Accepted | REQ-N8 |
| [0007](0007-website-in-separate-repository.md) | The public website lives in its own repository | Accepted | REQ-N10 |
| [0008](0008-provider-neutral-modelling-platform.md) | Provider-neutral modelling platform | Accepted | REQ-F11–F14, REQ-N11–N12 |
| [0009](0009-native-identity-and-tenant-boundaries.md) | Native identity and tenant boundaries | Accepted | REQ-N11, REQ-F12 |
| [0010](0010-hosted-git-capabilities.md) | Hosted Git capabilities beside generic storage | Accepted | REQ-F12, REQ-N11 |
| [0011](0011-sharepoint-conditional-snapshots.md) | Conditional SharePoint project snapshots | Accepted | REQ-F12, REQ-N11 |

| [0012](0012-terminology-operation-evidence.md) | Preserve terminology operation evidence | Accepted | REQ-F14, REQ-N11 |

| [0013](0013-project-terminology-catalogue.md) | Project terminology catalogue over the model repository | Accepted | REQ-F12, REQ-F14, REQ-N11 |

## Writing a new ADR

1. Copy the structure of an existing record. Number sequentially (`NNNN-kebab-title.md`).
2. Fill **Context / Decision / Consequences**; set status `Proposed`.
3. Cite the `REQ-#`(s) it serves and add a row to this index and to
   [traceability.md](../traceability.md).
4. On merge, set status to `Accepted`.

- [ADR-0014: Revision-bound terminology binding plans](0014-revision-bound-terminology-binding-plans.md)

- [ADR-0015: Persisted governance and interactive human approval](0015-persisted-governance-and-interactive-human-approval.md)

- [0016: Versioned requirements graph and evidence boundaries](0016-versioned-requirements-graph-and-evidence-boundaries.md)

- [0017: Staged document validation and project evidence QA](0017-staged-document-validation-and-project-evidence-qa.md)

- [0018: Source-bound CKM authentication and federated discovery](0018-source-bound-ckm-authentication-and-federated-discovery.md)

- [0019: Advertised MCP profile and wire acceptance](0019-advertised-mcp-profile-and-wire-acceptance.md)

- [0021: PostgreSQL governance and immutable model cache](0021-postgres-governance-and-immutable-model-cache.md)

- [ADR-0020 — Native openEHR validation and compilation](0020-native-openehr-engine.md)

- [ADR-0022 — Legacy template compilation compatibility profile](0022-legacy-template-compatibility.md)

- [ADR-0023 — Immutable originals and protected import receipts](0023-immutable-originals-and-import-receipts.md)

- [ADR-0024 — Private CDR client and model-aware AQL workspace](0024-cdr-client-and-aql-workspace.md)
