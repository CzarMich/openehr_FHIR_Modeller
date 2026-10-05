# Queryable requirements traceability

A project can retain a versioned graph connecting requirements, modelling decisions, archetypes, templates, constraints, terminology bindings, validation and reviews. `model_traceability_explain` answers “Why is this element here?” from recorded requirement/decision links. `model_traceability_requirement` answers “Which elements are linked to R-023?” from explicit coverage assertions. These queries use deterministic graph traversal and repository/audit evidence, without an LLM or terminology server.

Clinical satisfaction is never inferred from a link. A full coverage declaration means a modeller recorded that assertion. The response separately reports source/anchor freshness, authentic validation/review events and `semantic_satisfaction: NOT_ASSESSED`. A failed validation event can be authentic evidence of failure; its presence does not qualify a model.

## Storage and workflow

The graph is `requirements/traceability.json` in the selected ModelRepository, with the same filesystem, Git/GitHub/GitLab or SharePoint revision/conflict contract as model files. Saves create a DRAFT revision and require `MODEL_REPOSITORY_WRITE_ENABLED=true` plus the caller's existing write authorization. There are no new mandatory environment variables. Governance event links additionally require configured governance storage; graphs without those links work with governance disabled.

1. Retrieve the actual model artifacts and their `path`, `revision` and `sha256`. Inspect explicit XML locations with `model_terminology_inspect` when applicable; never invent a clinical path or constraint.
2. Record stable requirement IDs, descriptions, provenance and priorities. Record decisions and rationales separately. Unresolved requirements may have no coverage edge; exclusions require a reason.
3. Add model nodes with exact source references, and typed links with their rationales. Constraint nodes require an anchor in that exact source. Bindings remain optional.
4. Call `model_traceability_save(project, graph, expectedRevision)`. New graphs omit `expectedRevision`; replacing one requires its current graph revision. The source model is unchanged.
5. Use `model_traceability_get`, `model_traceability_explain` and `model_traceability_requirement` to inspect the trail and findings. Reads can name a historical graph revision and still report whether its source references remain current.
6. Run governance validation for the exact model revision. Add its authoritative event subject, sequence and hash as a validation node. Human review events can be linked after they exist; an agent cannot create or assert a human decision through graph input.
7. After source changes, reread the graph, resolve findings and save an intentional new revision. Old evidence remains historical; updating graph metadata never updates or approves the model.

Example MCP queries, after the named graph records exist:

```json
{"name":"model_traceability_explain","arguments":{"project":"neonatal-care","node":"C-1"}}
```

```json
{"name":"model_traceability_requirement","arguments":{"project":"neonatal-care","requirement":"R-023"}}
```

The first response includes explicit requirement/decision ancestors and associated binding, validation and review nodes. The second distinguishes direct `satisfied_by` assertions from the wider design/dependency trail. Merely traversing a proposed decision does not assert coverage.

## Graph contract

The top-level JSON object contains exactly `schema: 1`, `nodes: []` and `edges: []`. Each node requires `id`, `type`, `title`, `description` and a nonempty string list `provenance`. IDs are unique, case-sensitive ASCII identifiers starting with a letter; letters, digits, underscores, periods, colons and hyphens are allowed, up to 100 characters. Text is UTF-8; dangerous control characters are rejected. Provenance is a recorded assertion, not a verified author identity or a URL to fetch.

| Node type | Additional fields |
|---|---|
| `requirement` | `priority`: `must`, `should` or `could`; `status`: `ACTIVE` or `EXCLUDED`; `exclusion_reason` required only for exclusions |
| `decision` | `rationale`; `status`: `OPEN`, `PROPOSED`, `RECORDED` or `SUPERSEDED`; these statuses do not grant clinical approval |
| `archetype` | `artifact` pointing under `archetypes/` |
| `template` | `artifact` pointing under `templates/` |
| `template_constraint` | `artifact` under `templates/`, including an anchor |
| `terminology_binding` | `artifact` under `terminology/`; binding existence does not prove clinical suitability |
| `validation_evidence` | `event` referring to an authoritative VALIDATION event |
| `review` | `event` referring to an authenticated human review/decision event |

An `artifact` contains `path`, `revision`, `sha256` and optionally `anchor: {"kind": "…", "value": "…"}`. References stay in the selected project. An `event` contains `subject`, `sequence` and `hash`, taken from `governance_get`. Audit evidence is resolved only in the authenticated tenant and matching project. Model JSON cannot fabricate the referenced event.

| Anchor kind | Resolution boundary |
|---|---|
| `xml_location` | Positional element address such as `/1/1/1`, bound to the recorded XML revision; never executed as XPath |
| `json_pointer` | Nonempty [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON string pointer, with exact object keys, array indices and `~0`/`~1` escaping; duplicate-key documents, missing members and URI fragments rejected |
| `openehr_path` | Recorded native path; resolution explicitly NOT_EXECUTED until the qualified openEHR engine is available |

Omit the anchor to reference a whole artifact. XML/JSON location resolution proves a location exists in those source bytes; it does not establish inherited archetype semantics, model compatibility or clinical meaning. Source parsing, overall conformance, terminology validation and requirements satisfaction remain distinct checks.

Each edge requires `from`, `to`, `relation` and `rationale`. Duplicate edges, unknown nodes, incompatible types and cycles are rejected. `satisfied_by` additionally requires `coverage: full|partial`; exclusions cannot have coverage edges.

| Relation | Direction |
|---|---|
| `motivates` | requirement → decision |
| `justifies` | decision → model/binding node |
| `satisfied_by` | requirement → model/binding node |
| `used_by` | archetype → template |
| `constrains` | template → template constraint |
| `bound_by` | archetype/template/constraint → terminology binding |
| `validated_by` | model/binding node → validation evidence |
| `reviewed_by` | model/binding/validation node → review |
| `supersedes` | decision → earlier decision |

Validation/review links must identify the same source revision/hash as their model node. A review linked to validation evidence must name that validation digest. Relationships such as `used_by` and `bound_by` are explicit modelling assertions; native dependency/binding semantics are not inferred from graph presence.

## Findings and trust

Responses retain the graph revision, typed nodes/edges, per-node evidence, requirement coverage and machine-readable findings with severity, code, location, message, evidence and remediation. Coverage uses `DECLARED_FULL`, `DECLARED_PARTIAL`, `UNRESOLVED` or `EXCLUDED`. `element_references_current_and_resolved` describes the linked element references only; other validation/review findings remain separate.

Source evidence can be CURRENT, STALE, INVALID, UNAVAILABLE or NOT_EXECUTED. Inline requirements/decisions remain DECLARED. Ledger evidence is VERIFIED only when its type, tenant/project, sequence and hash resolve; the returned validation status and eligibility still need inspection. No graph response grants clinical approval.

Saves reject missing or mismatched references, invalid anchors and evidence belonging to another source. They may retain deliberately pinned historical references or native paths awaiting the qualified engine, with findings explicit. Direct Git/file edits are revalidated on reads. Corrupt or ambiguous graph JSON fails closed. Source/ledger reads and the graph save are not a distributed transaction; evidence records what was observed, and later reads recompute freshness.

Limits: 500 nodes, 2,000 edges, 1 MiB compact graph input, 100 retained source/event reference entries and 16 MiB of source/audit data per evaluation. Artifact content follows the existing 2 MiB repository limit. JSON uses native depth limits plus a bounded token scan and duplicate-key rejection. Traversal uses adjacency lists and bounded iterative queues; no input is executed as code, XPath, SQL or a network URL.

## Migration and repeatable verification

The legacy `model_requirements_coverage` operation remains available for supplied declaration arrays. It does not automatically import old requirement files or promote their assertions into verified graph evidence. Create the explicit graph and pin retrieved source revisions when adopting the new queries. The requirements graph is separate from this software repository's `docs/traceability.yaml`, which maps implementation requirements to code/tests.

Run the PHP traceability tests, specification/static checks and independent `scripts/mcp-smoke.py --writes --governance` against disposable storage. Repository contract tests exercise filesystem, Git and isolated SharePoint. Tests cover history, stale writes/source edits, missing and cross-tenant evidence, mismatched validation sources, forged event hashes, cycles, ambiguous JSON, unexecuted native paths and unchanged model content. The optional governance flag links actual pipeline events through the real MCP service; it never approves a clinical model.
