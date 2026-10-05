# ADR 0022: Legacy template compilation through an explicit compatibility adapter

Status: accepted for the bounded legacy compatibility profile; complete OET/AOM semantics remain implementation work.

The native engine already compiles ADL 2 templates to OPT 2 ADL. OET templates and ADL 1.4 archetypes need a distinct compilation path that produces OPT 1.4 XML. They are not interchangeable formats.

## Evaluation

The maintained Archie ADL 1.4 parser supplies the language grammar and AOM tree. Its subsequent ADL 2 conversion changes node identifiers and may infer terminology URLs. Domain constraint conversion also changes the representation of quantities and ordinals. Compilation must retain the original parse tree and typed ontology alongside the AOM; inferred URLs must never become source bindings.

The published openEHR Java libraries 1.0.71 OET flattener was evaluated in an isolated Java 21 harness. It can assemble legacy templates, but its XML serializer loses term text through a dictionary lookup defect; older transitive dependencies include an affected Commons Lang 2 release. Fixing the serializer alone does not establish constraint preservation or complete OPT production. The product therefore does not add that legacy runtime.

The compatibility adapter uses Archie 3.20.0 for parsing and the current openEHR SDK OPT 1.4 schema types for independent XML acceptance. It implements the OET application boundary explicitly, behind the existing provider-neutral engine port. It must reject unsupported constructs rather than silently discard them. RM checks, schema validation, terminology verification and clinical review remain separate results.

## Required safeguards

- Exact supplied archetype identifiers and SHA-256 hashes; no network dependency substitution.
- Original ADL 1.4 `at` codes, typed terminology bindings, languages and constraints retained. Original artefact bytes remain immutable repository inputs.
- Secure bounded XML parsing, closed input profiles and no external entity, schema or network resolution.
- Slot and path ambiguity, widening constraints, missing dependencies and unresolved references fail compilation.
- Explicit compatibility profile and recorded RM assumption when legacy source omits an RM release.
- Deterministic OPT bytes, native output schema acceptance and a dependency/build manifest.
- Unsupported or unqualified constructs remain visible limitations. Passing these checks does not confer clinical approval or universal Designer compatibility.

References: [Archie ADL 1.4 parser](https://github.com/openEHR/archie/tree/7b28a2cb44674ae9055a194f9b0c6ed254e4cbdf/aom/src/main/java/com/nedap/archie/adl14), [openEHR SDK OPT 1.4](https://github.com/ehrbase/openEHR_SDK/tree/e57511c6aca27ed501d31d663762c37c3491e74e/opt-1.4), [ADL 1.4](https://specifications.openehr.org/releases/AM/development/ADL1.4.html), [legacy OET parser source](https://github.com/openEHR/java-libs/tree/master/oet-parser).

The SDK XML reader uses XMLBeans 5.3.0. Its transitive Log4j API is pinned to patched 2.25.5 rather than the older XMLBeans default; the actual runtime SBOM is audited in CI. Original temporal assumptions are read from syntax because the generic parser may derive singleton defaults.

Supported `use_node` expansion pairs Archie-calculated original paths with source constraint syntax; target identifiers/occurrences are inherited unless the reference explicitly overrides them. Cycles, ambiguous/missing targets and incompatible types fail. OET placement into an omitted/open RM attribute uses bundled RM type, optionality and collection metadata and records the narrowing. An explicit slot cannot be bypassed through this path. Existing source examples are exercised through actual MCP with separate XML revalidation in the container gate.
