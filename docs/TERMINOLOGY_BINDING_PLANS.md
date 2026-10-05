# Terminology binding plans

Binding plans help a modeller identify explicit coded constraints, preserve existing references, and compare known codes with project ValueSets. They work without an external terminology server. They are **draft review evidence**, not native model edits, clinical approval, OPT compilation or complete openEHR conformance.

## Workflow

1. Store an OET or OPT in the model repository and read its revision.
2. Use `model_terminology_inspect` to inspect that revision. The report includes the source SHA-256, element-position locations, declared paths and archetype placement context.
3. Maintain versioned [project terminology records](TERMINOLOGY_CATALOGUE.md). An external reference records a dependency but supplies no local membership evidence.
4. Call `terminology_binding_plan`. If the source uses a terminology name rather than a canonical system, provide explicit aliases only after establishing their meaning. An alias can also declare the CodeSystem edition. No edition is inferred from a single catalogue match.
5. Review findings, candidate memberships and code validation separately. Matching codes does not establish clinical suitability. A proposed ValueSet must not widen the original allowed codes or remove exclusions and existing constraints.
6. Save with `terminology_binding_plan_save`, the observed `modelRevision`, and an `expectedRevision` when replacing an existing plan. The service recomputes the report; it does not accept client-supplied approval or validation results.
7. Read with `terminology_binding_plan_get`. It compares saved analysis with the current model and **whole catalogue**, so adding another matching ValueSet edition also invalidates the analysis. Regenerate stale evidence before review.

Example:

```json
{
  "name": "terminology_binding_plan_save",
  "arguments": {
    "project": "neonatal-care",
    "path": "templates/admission.oet",
    "modelRevision": "<observed-source-revision>",
    "aliases": [
      {
        "terminology_id": "organisation-feeding",
        "system": "https://example.org/local/feeding",
        "version": "7",
        "archetype": "openEHR-EHR-OBSERVATION.feeding.v1"
      }
    ]
  }
}
```

An alias is a declared modelling decision, not terminology discovery. A `local` alias requires an archetype scope. A scoped alias takes precedence over a general alias with the same terminology identifier; it never applies to another archetype. An existing canonical system cannot be remapped to a different system. Free-text choices and unresolvable identifiers remain findings; the service never invents codes from labels.

## Supported inspection and boundaries

| Source | Inspection | Boundary |
|---|---|---|
| OET `openEHR/v1/Template` | Explicit text constraints, included/excluded values, literal `terminology::code`, named terminology queries, placement context | `termQueryId.queryName` is preserved as an opaque named query, even if it looks like a URL. It is not reinterpreted as a FHIR canonical. |
| OPT XML `http://schemas.openehr.org/v1` or `/v2` | Explicit `C_CODE_PHRASE`, `C_CODE_REFERENCE`, `terminology_id`, `code_list`, `referenceSetUri`; hashes of term/constraint-binding XML blocks | Namespace recognition is not XSD validation. Reference editions remain unknown. Binding-block hashes describe parsed serialization, while the source hash records the exact original bytes. |
| AOM 2 `C_TERMINOLOGY_CODE` expressions | Explicit unresolved-expression finding | Requires qualified engine interpretation. |
| ADL and inherited archetype constraints | `NOT_EXECUTED` | Requires qualified ADL/AOM engine and resolved dependencies. |

Positional locators such as `/1/2/1` identify element children in the **exact recorded source revision**. They are not openEHR semantic paths and must not be reused against another revision. Existing `terminology_binding_validate` now rejects ambiguous relative `node` paths; an optional `binding.target_location` selects one explicit placement. This is a deliberate compatibility correction for previously ambiguous results.

Candidate matching uses exact system/code membership in local ValueSets. Explicitly selected CodeSystem editions must also match a member's edition. Unknown editions remain unconfirmed. Inactive and abstract ValueSet members are excluded from membership candidates. Local CodeSystem validation is recorded independently; a negative result remains an error even if a draft ValueSet lists that code. Clinical review is always required. Strength is left unset because clinical binding policy cannot be inferred from code overlap.

Existing native references always take precedence over suggestions. No automatic replacement, canonical rewrite, source edit or model approval occurs. External binding remains optional, including for legitimate archetype-local coded choices.

## Evidence and storage

The same application service works with filesystem, Git, and SharePoint repositories. Plans are stored at `terminology/binding-plans/<sha256-of-model-path>.json`, with conditional writes, DRAFT status and repository revision history. Evidence includes source path/revision/hash, exact catalogue paths/revisions/hashes, catalogue fingerprint, declared aliases, inspection, candidates, validation outcomes and QA findings.

Saving checks the observed model revision, then writes a separate plan artefact. This is not an atomic transaction across the model and catalogue. A concurrent edit cannot rewrite recorded source evidence; reading the plan recomputes freshness. `CURRENT` means the saved deterministic analysis matches the current inputs. `STALE_OR_MODIFIED` means it differs. `NOT_EXECUTED` means current inputs could not be evaluated. None means clinically approved. Repository content is not a signed attestation.

## Configuration, security and limits

No additional environment variables are required. Repository settings, tenant isolation, write enablement and OIDC draft-write permissions apply. Browser chat presents the source revision, plan revision and aliases for explicit confirmation before saving. Read-only planning performs no network requests; canonical identifiers are never fetched.

Secure XML parsing rejects DTDs, entities, malformed and oversized input. Inspection is bounded to 100 combined slots/binding blocks/expression findings, 100 codes per slot, 200 included/excluded literals per slot and 2,000 total inspected codings/literals. Planning accepts at most 100 catalogue records, 10 MiB of catalogue source, 50,000 concepts and 100 aliases. Serialized plans are limited to 2 MiB. Exceeding a limit fails explicitly; reports never silently truncate coverage. Invalid catalogue records are findings and set `catalogue_complete:false`.

## Verification

`TerminologyBindingPlanTest` covers all three repository contracts, exact-source preservation, revision conflicts, history, new-edition and source staleness, named queries, OPT references, namespace confusion, entities, bounded inspection, local-code ambiguity, scoped aliases and write access. The independent HTTP MCP smoke client exercises inspection, planning, saving, stale-write rejection and stale-evidence detection. Browser tests verify confirmation includes both source and plan revisions. These checks do not prove native binding round trips through an OPT compiler; that acceptance gate belongs to the engine integration.
