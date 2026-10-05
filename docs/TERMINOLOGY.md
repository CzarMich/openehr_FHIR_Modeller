# Terminology, value sets and bindings

The platform distinguishes a code system, a versioned value set, a template node and an explicit binding. A code system URL is a canonical identifier; it is not necessarily a network address to fetch. All network calls go to the configured terminology provider. The local provider and FHIR adapter implement the same domain interface.

## Optional FHIR terminology server

Leave `TERMINOLOGY_FHIR_BASE_URL`, `TERMINOLOGY_API_KEY` and `TERMINOLOGY_BEARER_TOKEN` empty to run without an external server. Models need no terminology binding. Local value sets and bundled openEHR terminology remain available; requested remote operations return `NOT_EXECUTED` with `valid: null`.

To enable an external server, set `TERMINOLOGY_FHIR_BASE_URL=https://terminology.example.org/fhir/` and its supported authentication. Use either `TERMINOLOGY_API_KEY` with `TERMINOLOGY_API_KEY_HEADER`, or `TERMINOLOGY_BEARER_TOKEN`. Keep credentials outside Git, logs, prompts and provenance. A canonical code-system URL is an identifier, not necessarily the API base.

The terminology server verifies API keys; an identity provider normally does not need a client setting for a key validated by that server. Its gateway must forward the configured key header to the backend without an interactive login redirect. Header presence alone never grants access. Preserve browser-session authentication for interactive API documentation and separate it from machine credentials. Sharing DNS, a subnet or a deployment is not an identity.

CodeSystem validation uses standard FHIR `url` for GET/POST. Keep `TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER=url` by default; select `system` only for a verified legacy provider. This setting does not change lookup or ValueSet parameters. Dataset and version visibility depend on the authenticated principal.

For a terminology server supporting Keycloak service-account tokens, configure a confidential client, service accounts, minimum API roles and matching issuer/audience/tenant claims. See [Keycloak service accounts](https://www.keycloak.org/docs/latest/server_admin/index.html#_service_accounts). The assistant accepts a provisioned bearer token; token acquisition/refresh is not currently automatic. Native inbound MCP OIDC is a separate capability.

## Operations

| Tool | Operation and scope |
|---|---|
| `terminology_capabilities` | Reads `/metadata`; advertisement does not establish that an operation or dataset works. |
| `terminology_lookup` | `CodeSystem/$lookup`, optional code-system edition and display language; repeated designations and nested properties retained. |
| `terminology_validate_code` | `CodeSystem/$validate-code` or `ValueSet/$validate-code`, optional display/language; value-set and code-system editions kept separate. |
| `terminology_expand` | `ValueSet/$expand`, count 0–500, offset 0–1,000,000, optional language/filter, designations requested. Count zero requests size only. |
| `terminology_translate` | `ConceptMap/$translate` using an explicit canonical and optional edition/source/target restrictions. All candidates require human review. |
| `terminology_resource_search` | Bounded first-page discovery of CodeSystem, ValueSet or ConceptMap resources on the configured server. |
| `terminology_resource_get` | Exact canonical and optional edition, requiring one matching resource and evidence that the search result is complete. |

[FHIR R4 terminology operations](https://hl7.org/fhir/R4/terminology-service.html) define the adapter contract. Resource search is optional server functionality: a server may support `$lookup` without a searchable CodeSystem endpoint. Unimplemented server operations return `NOT_EXECUTED`; the assistant does not infer an available resource from a capability advertisement.

An absent provider, redirect, authentication failure, timeout, invalid response or missing deterministic result returns `NOT_EXECUTED`, `valid:null`, and a redacted error code. `VALIDATED` means the requested operation ran; code membership still requires `valid:true`. A negative result remains negative. Translation instead reports `mapping_found`, `matches` and `candidates`; `valid` remains null, `requires_review` is true and `applied` is false. Equivalent mappings also require review. No tool silently invents, substitutes or applies clinical codes.

The legacy `version` argument identifies the ValueSet when `valueSet` is set, otherwise the CodeSystem. Use `codeSystemVersion` to pin the contributing system independently. For translation, `version` identifies the ConceptMap and `codeSystemVersion` identifies the source system. `versions` contains separate requested/returned/confirmed evidence. A generic returned `version` from value-set validation is not evidence of the ValueSet edition. Missing confirmation is a warning; conflicting returned editions fail. Never infer a release edition from a generic system URI.

For example, a value-set validation call can provide:

```json
{"system":"https://example.org/CodeSystem/feeding","code":"mixed","valueSet":"https://example.org/ValueSet/admission-feeding","version":"vs-3","codeSystemVersion":"cs-7","display":"Mixed feeding","language":"en"}
```

These are explicit local example identifiers, not external clinical codes. For lookup and validation, legacy singleton values remain under `result`; repeated `designation`, `property` and `match` values remain lists. `parameters` preserves the typed FHIR tree, including nested parts. Duplicate singleton result/display/version fields are rejected instead of overwritten.

Expansion `page` evidence distinguishes returned code count, total, requested/returned offsets, hierarchy and completeness. A partial page, nonzero offset, unknown total, hierarchical response or unclosed expansion cannot certify the whole value set. `filtered:true` and `scope:filtered_expansion` mean any completeness claim concerns the filter only. The adapter does not automatically traverse large expansions. Search likewise does not follow returned next-page links; `complete:false` remains explicit. Exact resource resolution rejects ambiguous editions, omitted totals and ignored canonical/version filters. Canonical identifiers are never fetched as URLs.

Local snapshots use their explicit `code_system_version` for code-system checks, separately from `version`. A pinned system edition with no local edition metadata is `NOT_EXECUTED`; a value-set version is never substituted. Optional `designation` entries contain `language` and `value`. Local filtering is deterministic, case-sensitive substring matching on code or the selected display. Local lookup scope is the supplied value set, not proof of complete code-system coverage.

## Repeatable verification

Run PHP unit/negative/security contracts with `composer test` inside the development container. `scripts/test-terminology-container.sh` builds the production image and exercises actual MCP calls against an isolated, authenticated HTTPS FHIR fixture. The fixture checks independent editions, repeated multilingual designations, negative membership, expansion paging, resource resolution and review-only translation. CI retains the resulting protocol evidence. This is adapter contract verification, not a claim of full FHIR server conformance.

For read-only live acceptance, run `php scripts/terminology-smoke.php` inside the development container with the normal terminology configuration and `SMOKE_TERMINOLOGY_SYSTEM`/`SMOKE_TERMINOLOGY_CODE`. Optional `SMOKE_TERMINOLOGY_VERSION` pins the system edition. Set `SMOKE_VALUE_SET` and optional `SMOKE_VALUE_SET_VERSION` to test expansion and validate an actual returned member; the lookup code need not be a member of that set. Set `SMOKE_CONCEPT_MAP` and optional `SMOKE_CONCEPT_MAP_VERSION` to exercise an available map. No terminology content is written. The report contains outcomes, counts and version confirmation, without credentials or redistributed expansion content. Core checks are mandatory; unavailable discovery is reported separately. Run within a container with a trusted CA and privately supplied environment, never pass credentials as tool arguments.

## Migration

Tool names and existing positional arguments remain compatible. Optional arguments add edition, language and page control. Expansion count/offset bounds are enforced rather than silently clamped; count zero is supported. Repeated parameter values are now lists, and malformed duplicate singleton results fail closed. Local code-system checks previously compared against the value-set edition; provide `code_system_version` when pinning a local system edition. Existing unpinned local membership checks remain valid.

## Managed project catalogue

Use the [project terminology catalogue](TERMINOLOGY_CATALOGUE.md) for versioned local CodeSystem, multi-system ValueSet and ConceptMap records, or explicit external references, with repository history and conditional draft writes. Catalogue operations work offline for local content. The following original value-set/binding records remain supported for compatibility.

## Explicit records

A local value set can be stored at `terminology/valuesets/feeding.json`:

```json
{"id":"feeding","system":"https://example.org/terminology/local/feeding","version":"1","source":"local","concepts":[{"code":"mixed","display":"Mixed feeding"}]}
```

Local codes remain local. They are not SNOMED or LOINC identifiers. An external reference instead uses `source:"external"`, a canonical URL, explicit `version`, and optional `code_system_version`. Store references rather than redistributing restricted expansions.

A binding record can be stored at `terminology/bindings/feeding.json`:

```json
{"id":"feeding-binding","artifact":"templates/admission.oet","node":"/data[at0001]","strength":"REQUIRED","system":"https://example.org/terminology/local/feeding","value_set":"feeding","value_set_version":"1","codes":["mixed"],"requirements":["REQ-NEO-1"]}
```

The node in this example is a placeholder and must be replaced with an actual model path. REQUIRED, EXTENSIBLE, PREFERRED and EXAMPLE are platform review policies; they are not claimed as native openEHR syntax. `terminology_binding_validate` checks explicit XML path presence, value-set references and selected codes against the local or external provider. It cannot resolve inherited archetype nodes, verify contextual path uniqueness, apply native constraints or prove OET/OPT preservation. Overall validity stays PARTIAL/null. Save its timestamp, content hash, source endpoint and version results as evidence.

`terminology_diff` compares additions, removals, changed displays/properties, inactive codes and replacement suggestions. It never replaces codes automatically. When every concept in both versions supplies an explicit bounded `parents` list, the result also compares those declared hierarchy edges; otherwise hierarchy is `NOT_COMPARABLE`. This does not resolve a global terminology hierarchy or infer missing edges. `model_diff` reports structured XML semantic-dimension changes including serialized binding changes, but cannot infer external dependency changes; run both comparisons.

`terminology_manifest` emits only bindings explicitly linked to the requested artifact, including requirement IDs. It declares dependencies; it does not certify a release. Repository revisions allow review of records and reports together. Native binding application, cross-project impact indexing, terminology approval/publication remain extension work; Git PR/MR draft review is available separately. The client may propose candidates, but must use deterministic checks before treating a code as verified.

## Model binding plans

[Binding plans](TERMINOLOGY_BINDING_PLANS.md) inspect explicit OET/OPT constraints, preserve existing references, compare local catalogue memberships and persist revision-bound DRAFT evidence. They work offline. Native ADL/inherited binding application and compiler round trips remain qualified-engine work; a candidate or CURRENT report never confers clinical approval. Ambiguous relative targets in `terminology_binding_validate` now require an exact `binding.target_location`.

The optional ADL 2 engine preserves component terminologies in generated OPT 2. Mechanical terminology-constraint checks are distinct from external terminology membership validation; compilation does not require a terminology server. See [compiler profiles](OPT_COMPILATION.md).

The legacy OET compiler keeps original ADL 1.4 typed system/version/code bindings and multilingual component ontologies in OPT 1.4 XML. It does not use URLs inferred by ADL 2 conversion or silently invent external versions. This preservation does not apply or clinically validate new bindings. [Legacy profile](LEGACY_OPT_COMPILATION.md).
