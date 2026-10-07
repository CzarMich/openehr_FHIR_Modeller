# Project terminology catalogue

The catalogue stores versioned CodeSystem, ValueSet and ConceptMap records beside clinical models. It works with filesystem, Git, GitHub/GitLab and SharePoint repositories through the same repository interface. Local records support deterministic lookup, membership, expansion and mapping proposals without any terminology server or language model. Explicit external references use the optional configured terminology provider.

Every save is a DRAFT with an expected repository revision. Terminology checks never approve clinical content. The catalogue schema is an internal platform format, not a FHIR resource or native openEHR binding serialization. Existing explicit `ValueSet`/binding tools remain available for their original record format.

## Record identity and storage

A record is identified by `(kind, canonical, version)`. Kinds are `code_system`, `value_set` and `concept_map`. Canonicals are absolute HTTP(S) identifiers or URNs; they are never fetched as network addresses. Every record needs a nonempty edition, name and declared `provenance.source`. Optional provenance fields are `licence`, `author`, `retrieved_at` and `source_revision`. Provenance is a modeller assertion, not verified authorship or approval.

Records live at `terminology/catalogue/<kind>/<identity-sha256>.json`. The hash covers the kind, canonical and edition, preventing canonical text from becoming a filesystem path. Reads verify that the stored identity matches its path, including files edited by an external Git client. An omitted version is accepted only when the catalogue contains exactly one matching edition. No operation silently chooses the newest edition. Historical reads require both the edition and repository revision.

The catalogue does not migrate existing `terminology/valuesets/` or binding files automatically. Save a deliberate catalogue record to adopt the new schema. The original artifact remains available, and existing projects and repository layouts do not change. Editing a DRAFT edition uses the previous revision; creating another edition uses a new identity and no previous revision. Use `model_artifact_history` with the returned path to inspect its revision history.

## Local code systems

```json
{
  "kind": "code_system",
  "canonical": "https://example.org/local/feeding",
  "version": "cs-7",
  "name": "Local feeding options",
  "language": "en",
  "source": "local",
  "provenance": {"source": "Organisation-authored draft", "licence": "Organisation policy"},
  "case_sensitive": true,
  "content": "complete",
  "concepts": [
    {"code": "feeding", "display": "Feeding category", "abstract": true},
    {"code": "mixed", "display": "Mixed feeding", "parents": ["feeding"],
     "designation": [{"language": "de", "value": "Gemischte Ernährung"}]}
  ]
}
```

These are invented **local example identifiers**, never claimed as external clinical codes. Concepts support `code`, `display`, optional `definition`, boolean `inactive`/`abstract`, language designations and explicit parent codes. A designation has `language`, `value` and an optional `use` coding (`system`, `code`, optional `version`/`display`). Duplicate codes respect the declared case rule; Unicode case folding is used only when `case_sensitive:false`. The default is case-sensitive. Explicit parent graphs reject missing parents, repeated edges and cycles.

`content` is `complete` or `fragment`. Known inactive and abstract concepts cannot validate as selectable codes. An unknown code in a complete local snapshot returns false. An unknown code in a fragment returns `NOT_EXECUTED` with null validity; the fragment cannot establish absence from the complete code system. Completeness is the record author's declaration, not verification of an external release.

## Local value sets

```json
{
  "kind": "value_set",
  "canonical": "https://example.org/sets/admission-feeding",
  "version": "vs-3",
  "name": "Admission feeding options",
  "provenance": {"source": "Organisation-authored draft"},
  "concepts": [
    {"system": "https://example.org/local/feeding", "version": "cs-7", "code": "mixed", "display": "Mixed feeding"}
  ],
  "dependencies": [
    {"kind": "code_system", "canonical": "https://example.org/local/feeding", "version": "cs-7"}
  ]
}
```

Value sets enumerate explicit codings and may contain several systems or editions. The value-set edition (`vs-3`) and member code-system edition (`cs-7`) are independent. Member fields are `system`, optional `version`, `code`, `display`, optional inactive/abstract flags and designations. Duplicate identity is `(system, version, code)`. A value set cannot redefine code-system case or completeness rules.

Membership checks cover these explicit codings, not complete semantic validation against each external code system. A requested system edition with no recorded edition remains unverified; several editions of the same coding require an explicit choice. Missing editions are never filled from the value-set edition. Declared dependencies preserve canonical/version identity; dependency resolution and release qualification are separate checks.

Expansion supports count 0–500 and bounded offset, with exact total and explicit completeness for the local snapshot. A filtered result is complete only for that filter. Local filtering uses case-sensitive substring matching of code or selected display. A requested display language must be available before a supplied display can validate. Available designations are preserved; a lookup may show the default display while reporting that its language is unconfirmed.

## Concept maps

```json
{
  "kind": "concept_map",
  "canonical": "https://example.org/maps/feeding",
  "version": "map-2",
  "name": "Feeding mapping draft",
  "provenance": {"source": "Explicit modelling decision"},
  "mappings": [
    {
      "source": {"system": "https://example.org/local/feeding", "version": "cs-7", "code": "mixed"},
      "target": {"system": "https://example.org/local/other-feeding", "version": "1", "code": "combination"},
      "relationship": "equivalent",
      "comment": "Requires clinical review before use"
    }
  ]
}
```

Relationships are `equivalent`, `related`, `broader`, `narrower`, `inexact`, `unmatched` and `disjoint`. Each mapping has an explicit source coding; only `unmatched` can omit its target. Optional `conditions` are a list of `{property,value}` pairs and remain unverified review conditions. A mapping may have a comment. No operation derives a target code from its display.

Translation returns all matching records and separates positive candidates from unmatched/disjoint records. A requested source edition excludes explicitly different editions; a mapping with no source edition remains unconfirmed. Every candidate requires human review, including equivalent mappings and candidates with no conditions. `applied:false` and null overall validity remain explicit. This does not execute clinical mappings or modify a model binding.

## External references

Use `source:"external"` with the canonical and explicit version, name and provenance. Omit local content and code-system semantics:

```json
{"kind":"value_set","canonical":"https://terminology.example/ValueSet/admission","version":"3","name":"External admission set","source":"external","provenance":{"source":"Configured terminology server"}}
```

External records cannot assert local concepts, mappings or code-system completeness. Operations pin the recorded edition when calling the configured provider. If the provider is unavailable or unconfigured, the result is `NOT_EXECUTED`; there is no successful local fallback. Store references when a terminology licence does not permit redistributing content. See [external protocol configuration and result interpretation](TERMINOLOGY.md).

## Tools and browser workflow

1. Open a project and use `terminology_catalogue_search` to inspect its records. Search is deterministic over exact canonical identifiers and case-folded names/descriptions; it does not require embeddings or an LLM.
2. Use `terminology_catalogue_get` to read the complete record and current revision.
3. Save an explicit draft with `terminology_catalogue_save`, supplying `expectedRevision` when replacing it. The browser presents the exact record and revision for confirmation. This is a storage confirmation, not clinical approval.
4. Use `terminology_catalogue_lookup`, `terminology_catalogue_validate`, `terminology_catalogue_expand` or `terminology_catalogue_translate` for deterministic operations. Results include the catalogue artifact path, revision, hash and edition as evidence.
5. Preserve review findings alongside the model. Native ADL/OET binding application and inherited-path resolution remain engine work; this catalogue does not rewrite clinical models.

All mutations pass the same deployment write flag and native OIDC draft-write authorization as model changes. Tenant repository selection occurs before catalogue construction. Records containing approval/status fields outside the documented schema are rejected. Malformed external edits remain machine-readable QA findings, with their path, revision and remediation; they cannot silently establish an empty or valid catalogue.

## Limits and verification

A record is limited to 1 MiB serialized JSON, 5,000 concepts or mappings, 100 designations/conditions per item and 500 declared dependencies. Parent lists are limited to 50. Project catalogue scans are limited to 1,000 records and return at most 100 summary entries per page. Search never returns concept bodies; retrieve a selected record explicitly. Limits fail explicitly and do not discard content. Large-scale indexing and performance qualification remain separate work.

The PHP `mbstring` extension supplies deterministic Unicode case folding and is declared in Composer. It is present in the supplied PHP images. No new service or credential is needed for local catalogues. The browser MCP response limit is 16 MiB so the protocol can include both structured and text representations of bounded records; oversized streams are cancelled.

`TerminologyCatalogueTest` exercises filesystem, Git and stateful SharePoint contracts, revision history/conflicts, fragments, editions, language rules, conditional mappings, corruption, unsafe inputs and write authorization. `scripts/mcp-smoke.py --writes` also exercises catalogue operations through actual MCP in disposable test projects; run it only against an authorized test repository. CI executes this workflow in Git and SharePoint container configurations, plus browser confirmation and output-schema checks. External server acceptance is separate from these offline catalogue tests.
