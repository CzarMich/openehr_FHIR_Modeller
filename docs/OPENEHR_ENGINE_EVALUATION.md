# openEHR engine evaluation

This evaluation precedes engine integration. It distinguishes native language processing from the existing PHP document profiles. Source presence and a successful parse alone do not qualify a clinical model or authorize release.

## Candidate responsibilities

| Component | Observed responsibility | Integration decision |
|---|---|---|
| Archie, Apache-2.0 | ADL 2 parser/AOM, BMM/RM metadata, archetype validation, flattening, ADL 2 operational templates, native path inspection | Preferred native ADL 2 engine behind a language-neutral API |
| openEHR SDK AQL module, Apache-2.0 | ANTLR parser and typed AQL query/path representation, independent of a running CDR | Evaluate the released AQL module; parsing and execution remain separate |
| openEHR SDK template/validation modules, Apache-2.0 | Existing OPT XML types, template inspection, reference-model/composition support | Evaluate for legacy OPT acceptance and subsequent composition support |
| openEHR Java libraries OET parser/flattener | Existing OET schema/parser and constraints applied to ADL 1.4 archetypes | Evaluate as a legacy compatibility engine; its flattened archetype is not itself a complete OPT XML artefact |
| CaboLabs openEHR SDK, Apache-2.0 | ADL-to-OPT conversion and OPT serialization/inspection | Reference candidate; verify embedded archetype boundaries and terminology preservation before use |
| ADL Workbench | Mature native ADL tooling | Alternative/reference implementation; not a reason to rebuild ADL/AOM inside PHP |

Archie's own documentation explicitly distinguishes ADL 2 operational templates from the ADL 1.4 OET/OPT workflow. An ADL 2 template compiled by Archie cannot be relabelled as a legacy OET compilation. ADL 1.4 conversion is documented as experimental; conversion findings and changed identifiers must remain explicit.

The Java libraries' published OET release uses older XML dependencies and mixed source licence notices. Any integration must preserve applicable notices, replace or isolate unsafe dependency paths and demonstrate actual constraint/terminology preservation. Do not include old deserialization APIs merely because a flattener exists. A library method named `flatten` does not prove that a resulting file is an OPT or conforms to a current RM profile.

## Boundary and safety criteria

The PHP domain calls an explicit validation/compilation port. A separate JVM service owns engine classes and version-specific adapters. Requests contain model documents and resolved dependencies, not executable code, filesystem paths or caller-selected network destinations. Source resolution, repository authorization, immutable evidence and human approval remain platform responsibilities.

Acceptance must cover real positive/negative models, source hashes, dependency identity/version conflicts, parser errors, engine findings, output validation, terminology preservation, bounded work and reproducibility. XML handling must disable external entities and remote schemas. Missing dependencies, unsupported constructs and engine failures stay distinct from valid output. The service must impose finite input/output, concurrency, memory and execution-time limits.

The engine API should expose archetype/template/OPT validation, compilation and inspection plus separate AQL parsing. Every response identifies its engine/profile/version and source digest. Engine validation establishes only its declared mechanical conformance scope; it does not establish clinical suitability or human approval. Validation evidence is persisted against exact source revisions.

## Initial source observations

Archie `3.20.0`, openEHR SDK AQL `2.35.0` and Java libraries OET parser `1.0.71` are published Maven Central releases observed during evaluation. These are candidates, not an assertion that all have been integrated or qualified. Integration evidence must record actual selected dependency versions and compatibility checks, rather than relying on mutable branch names.

## Authoritative references

- [Archie source and usage](https://github.com/openEHR/archie), including its operational-template and ADL 1.4 conversion notes.
- [openEHR SDK](https://github.com/ehrbase/openEHR_SDK), including the AQL parser and template/validation modules.
- [openEHR Java libraries](https://github.com/openEHR/java-libs), especially the OET parser/flattener and source licence notices.
- [CaboLabs openEHR SDK](https://github.com/CaboLabs/openEHR-SDK).
- [ADL 2 development specification](https://specifications.openehr.org/releases/AM/development/ADL2.html).
- [AOM 2 development specification](https://specifications.openehr.org/releases/AM/development/AOM2.html).
- [OPT 2 development specification](https://specifications.openehr.org/releases/AM/development/OPT2.html).
- [AQL development specification](https://specifications.openehr.org/releases/QUERY/development/AQL.html).
