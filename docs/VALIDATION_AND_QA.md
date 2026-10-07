# Validation and project QA

`model_validate` checks a supplied document. `model_qa` adds a complete inventory of executed and unavailable document checks. `model_project_qa` reads an exact repository revision and connects those checks to recorded provenance, requirements and authoritative validation/review events. These operations are deterministic, read-only and available without a terminology server, CDR or LLM provider.

All three return bounded machine-readable findings. A document profile result is never a full openEHR conformance or clinical suitability result. Approval continues to require the separate human governance flow and qualified validation.

## Separate stages

Validation responses include `parse_valid`, `structurally_valid` and a `stages` array. Each stage has a name, status and reason or scope. The names are `parse`, `structure`, `semantics`, `terminology`, `openehr_conformance` and `repository_policy`. Status is PASS, FAIL, NOT_EXECUTED or NOT_APPLICABLE. The local document profiles set `qualified: false` even when their own checks pass.

| Format | Executed checks | Remaining boundary |
|---|---|---|
| XML | Safe well-formedness; no DTDs, entities or external schema retrieval | No model type or schema is implied |
| OET | XML, supported namespace/root, required identity/definition elements, typed COMPOSITION root, placement xsi:type/archetype RM-class agreement, parent-to-placement element kind, archetype identifier syntax, nonnegative occurrence bounds and absolute rule path prefix | Full schema, exact archetype paths, inherited constraints, slots and dependency compatibility require the engine |
| OPT | XML, v1/v2 namespace profiles, identity/language/concept/definition presence, interval bounds/flags and RM type-name syntax | RM membership, AOM semantics, complete schema and deployability require the engine |
| ADL | Leading declaration and supported archetype identifier, including UTF-8 BOM and leading comments | Grammar parsing is NOT_EXECUTED; a valid-looking header is not a valid archetype |
| AQL | Input safety/size only | These document QA operations do not execute syntax/path checks or queries; use native `aql_validate` and the separate [AQL/CDR workspace](CDR_WORKSPACE.md) |
| FLAT | Unambiguous JSON, object shape, bounded field/index/suffix notation, scalar values and explicit raw-object type | Web Template path existence, RM values, cardinality, terminology and composition conformance need an OPT/engine |
| STRUCTURED | Unambiguous JSON, composition/ctx objects, data arrays, separate attribute suffixes and explicit raw-object type | The same model-aware requirements as FLAT; context fields support scalar defaults and nested objects/occurrence arrays |

The JSON profiles follow the [development Simplified Formats specification](https://specifications.openehr.org/releases/ITS-REST/development/simplified_formats.html). They accept the documented raw object form. A string containing raw JSON is retained as a provider compatibility input with `LEGACY_STRINGIFIED_RAW`; malformed or duplicate-key raw JSON is rejected. The raw `_type` check establishes an explicit type name, not RM conformance. No raw content executes as code.

The XML profiles are deliberately bounded document checks informed by [openEHR ITS-XML](https://specifications.openehr.org/releases/ITS-XML/development) and its [schema source](https://github.com/openEHR/ITS-XML). No uploaded `schemaLocation`, DTD, XPath or URL is executed. OET `*` remains a legacy profile representation of an unbounded maximum; passing that check is not an XSD result. Decimal bounds are compared without machine-integer overflow. Missing template descriptions are QA warnings. OPT description is optional in the referenced schema; the earlier profile's mandatory-description assumption is removed.

The legacy `valid` field is `false` on a detected defect, `true` only for the requested generic XML well-formedness operation, and `null` for otherwise incomplete model checks. `release_eligible` stays false. `structurally_valid` is null when no structural profile executed, including ADL/AQL; generic XML retains its legacy well-formedness boolean. Always inspect each stage rather than treating PARTIAL as success.

## Project evidence checks

```json
{"name":"model_project_qa","arguments":{"project":"neonatal-care","path":"templates/admission.oet"}}
```

An optional `revision` selects retained source history. `format` normally comes from the extension; use an explicit `flat` or `structured` value for JSON composition files. The service returns the actual source path, revision and hash. It detects a differing current revision, archived project, source/hash mismatch and missing recorded provenance. Provenance remains an assertion recorded in model metadata, not proof of an authenticated author.

The service resolves the versioned requirements graph and selects trails connected to that exact source revision. It identifies missing active requirements, unresolved/stale graph evidence and missing validation events. Event identity is checked against the authoritative ledger in the caller's tenant. An event for another artifact, terminology binding or tenant does not satisfy the model's validation-evidence check. The response distinguishes an authentic incomplete validation from qualified validation. Historical human review presence never implies a current approval. Saved native compilation evidence is associated only when its source path/revision/hash exactly match this QA source; output bytes and every pinned dependency revision/hash are rechecked. Such a build proves only that its recorded bounded compiler profile ran on those inputs, not complete AOM, terminology, release or clinical qualification.

Explicit OET/OPT coded-element inspection contributes terminology findings. Terminology is optional; no external server call occurs. Native or inherited binding validity is not inferred from an empty explicit inspection. Qualified RM membership, native path resolution, duplicate native-node checks, dependency compatibility/version/deprecation and external dependency resolution remain named NOT_EXECUTED checks until the qualified engine/dependency phase.

QA returns FAIL if it detects an error, otherwise INCOMPLETE while required qualification is unavailable. It never writes model files, records a governance decision or fabricates validation history. Repository/graph/ledger reads describe observed revisions; they are not a distributed transaction. A later build must pin all inputs before qualification.

## Findings, limits and deployment

Each finding contains `severity`, `code`, `location`, `message`, `evidence` and `remediation`. XML locations are source-specific positional addresses; JSON locations use escaped pointer tokens. Reported locations longer than the response bound are truncated with the complete location's hash. Diagnostic output retains up to 500 findings plus an omitted-count finding; omitted errors still cause failure. Document input is limited to 2 MiB, XML to 20,000 elements and native parser depth, JSON to depth 64 and 100,000 scanned structural/string tokens. Duplicate JSON member names, including escaped aliases, fail closed. The requirements resolver's source/event and byte limits also apply to project QA.

No new environment variables or external service are required. The existing repository/tenant configuration chooses the project source. Governance links additionally require the protected governance ledger. Missing or inaccessible evidence is reported explicitly. Repository access and supported formats still fail through the standard MCP error envelope. Ordinary document checks work with repository writes disabled.

## Migration and verification

Existing tool names and envelope fields remain. Responses add stage results and formal findings; FLAT and STRUCTURED are new input formats. ADL's old `structurally_valid` inference becomes null because header inspection never ran its structural grammar. OPT now checks concept presence and nonempty identity values; optional description is a warning. Clients should migrate to named stages and keep `valid: null` distinct from true.

Run `StagedValidationTest`, `ProjectQualityTest`, the existing model/governance suites, PHPStan/spec checks and `scripts/mcp-smoke.py --writes --governance` against disposable storage. Tests cover filesystem, Git and isolated SharePoint contracts, exact source/audit links, tenant isolation, stale revisions, malicious or ambiguous input, integer overflow and bounded diagnostics. The container probe exercises the same public MCP operations as clients. Execution metadata belongs in the [verification evidence](evidence/validation-qa-verification.json).

Native ADL 2/AOM/RM validation, AQL syntax parsing and OPT 2 output checks, plus a bounded OET-to-OPT 1.4 schema/RM structure profile, are available through separate engine tools. The existing `model_validate` document profiles retain their bounded scope. Compiler findings and repository evidence do not silently replace the governance validation provider. See [OPT compilation](OPT_COMPILATION.md).
