# Legacy OET to OPT 1.4 compilation

The optional engine compiles an explicit compatibility profile of **OET XML plus exact ADL 1.4 archetypes into OPT 1.4 XML**. Use `template_compile` for computation or `template_compile_project` to save an exact-revision DRAFT build. The same tools continue to compile ADL 2 into OPT 2 ADL. The input format determines the pipeline; neither pipeline accepts Designer `.t.json` as a template.

This is a bounded compiler profile, not complete OET/AOM support or a claim that every Designer export will compile. Unsupported constructs fail with a named `ENGINE_*` error. Full AOM semantics, external terminology verification and clinical review remain separate, explicitly unexecuted checks. No terminology server, CDR or language-model provider is needed.

## Inputs and output

Supply an OET document in namespace `openEHR/v1/Template`, with `id`, `name` and `definition`, and all directly placed archetypes in the tool's `dependencies` list. Each dependency identifier must exactly match its ADL 1.4 header. The service computes and verifies SHA-256 hashes; missing, duplicate, mismatched and unused dependencies fail. Source lookup does not select an arbitrary CKM edition or access the network.

The compatibility profile uses the bundled **openEHR RM 1.0.2** model. A conflicting explicit RM declaration fails. The result records `rm_release_basis=explicit_legacy_compatibility_profile`; this is an adapter choice, not an assertion that an undeclared source contained an RM version.

Output has `format=opt14_xml`, namespace `http://schemas.openehr.org/v1`, a content hash, dependency evidence, actual model paths, exact typed terminology bindings, compilation actions and qualification limits. `template_validate` performs the same compilation checks without returning an output artefact. `opt_validate` detects XML and runs the separate `OPT14_XML_RM_STRUCTURE` profile. Use `model_inspect(format="opt14")` for XML inspection.

## Supported compatibility profile

| Area | Behaviour |
|---|---|
| Archetype syntax | Maintained Archie ADL 1.4 grammar; complete input required, no parser recovery or duplicate ODIN fields |
| Structure | Nested COMPOSITION, SECTION, ENTRY and CLUSTER/ITEM placements through explicit existing archetype slots; original RM types, node identifiers, existence, cardinality and occurrences |
| Slot matching | RM type conformance and supported identifier/concept include/exclude assertions; no ADL 2 recommendation semantics applied to ADL 1.4 |
| Internal references | Exact original paths calculated by Archie; expand original constraints, retain target node identifiers and occurrences unless explicitly overridden, reject cycles/missing or incompatible targets |
| Open RM attributes | Place compatible archetypes into unconstrained attributes using bundled RM type, multiplicity and collection metadata; record each narrowing and never bypass explicit slot constraints |
| Paths | Exact attribute and node/archetype predicates; ambiguous, absent and unsupported paths fail |
| OET rules | Narrow occurrences/existence; explicit names on unconstrained names; text/code list restrictions, datatype alternative selection, quantity unit/magnitude narrowing and annotations |
| Existing names | A requested OET name narrows an existing finite, closed `DV_TEXT.value` string list only when the name is already allowed; the list and its valid assumed value are narrowed together; regex/open/range and empty intersections fail |
| Native value constraints | Strings, booleans, numeric intervals/lists, representable temporal constraints, original quantity domains and local ordinal terms/assumed values |
| Terminology | Original typed system/version/code bindings, component scopes and multilingual ontology definitions; no inferred canonical URLs |
| Unfilled slots | Required slots fail; optional slots become explicit zero-occurrence exclusions recorded in `compilation_actions` |
| Output checking | Independent SDK OPT 1.4 XML schema and Web Template generation for compiled OETs; bounded RM structure, local term references and supported value-domain checks |
| Repeatability | Sorted dependency/ontology serialization and no timestamps inside the generated model; identical inputs reproduce identical output bytes |

The writer uses the original parse tree and typed ontology where the parser's generic AOM conversion would change legacy representations. In particular it preserves missing quantity bounds as missing, literal strings that resemble patterns as literals, original `at` codes, versioned code identities and ordinal assumptions. Full multilingual ontologies remain in the OPT; each embedded archetype exposes terms in the template's original language. Missing terms in that language fail rather than generating translations.

## Current exclusions

Specialised ADL 1.4 inheritance, legacy domain extensions other than supported quantities/local ordinal syntax, top-level ADL invariant execution, arbitrary slot expressions, OET embedded templates/conditional rules, advanced named/hybrid paths, repeated ambiguous archetype instances, description metadata beyond lifecycle and purpose/use/misuse, view metadata and broader vendor extensions remain qualification/implementation work. Temporal/numeric unions without a faithful OPT 1.4 representation fail. Existing-name patterns, open/ranged or unsupported shapes, assumed values outside the allowed literal list, regex-assumption, unconstrained-value and quantity-assumption refinements also fail explicitly. Calendar-relative duration comparisons without an anchor are not qualified and fail explicitly. The error is not permission to discard that construct or claim full validation.

OET source identity and lifecycle metadata are retained as compilation actions; only a UUID source identifier is emitted as the OPT `uid`. New draft OETs use UUIDs. Generated OPTs include a description, the original language and a purpose, with explicit generator attribution rather than an invented human author. These are required by the pinned SDK's Web Template consumer even though the OPT schema permits an absent description. The compiler now runs that independent consumer and reports `web_template_generation=PASS`; failures return `ENGINE_WEB_TEMPLATE_GENERATION_FAILED`. `template_compile` also returns a hash-verified `web_template` JSON output. Other original source metadata remains in the exact repository input revision. The compatibility adapter does not claim that generated OPT XML contains every authoring-only field from the source.

`template_compile_project` stores native XML separately from its source and marks it `compiled_opt14`, DRAFT. Build metadata preserves source/dependency paths, revisions and hashes, adapter/Archie/SDK identity, actions and validation limits. Human governance and its qualification gate remain independent. A successful build never approves, publishes or uploads a template to a CDR.

## Deployment and verification

Use the existing [engine sidecar and environment variables](OPT_COMPILATION.md#deployment); no additional listener, credential or service is needed. The same input/output, worker memory and execution-time limits apply. XML parsing rejects DTDs and external entities and does not resolve external schemas. The OPT schema is supplied by the pinned SDK runtime.

Run `make engine-check` for the real container/MCP compiler and saved-build path. Synthetic fixtures under `engine/src/test/resources/legacy` exercise nested sources, original languages/bindings, explicit naming/annotations, constrained values, schema/RM revalidation and byte-identical rebuilding. Negative cases include incompatible slots, missing/duplicate dependencies, type/path errors, widening, unfilled required slots and XML attacks. Unit tests run as part of the engine image build. The same container check also runs `scripts/engine-example-smoke.py` against the existing repository examples: Encounter, Blood Pressure, Problem/Diagnosis, Procedure, Medication Order and Anatomical Location. It composes Encounter with Blood Pressure, expands its reused nodes, revalidates the XML and verifies deterministic output. A required unfilled ADMIN_ENTRY slot remains a negative dependency case. Original source licensing and attribution remain in the existing files; no patient data is used. The dependency audit checks the actual runtime SBOM.

See [ADR 0022](decisions/0022-legacy-template-compatibility.md), [Designer compatibility](ARCHETYPE_DESIGNER_COMPATIBILITY.md) and [external modelling integration](MODELLING_TOOL_INTEGRATION.md). Hosted Designer import/export and semantic round trips require their own evidence; passing the compiler tests does not establish them.

Personal repository saves include versioned OPT and Web Template outputs at stable filenames under `templates/opt/` and `data/json/web-templates/`, linked from the package manifest. Git preserves previous revisions; old hash-suffixed outputs remain available. See [artefact versions](ARTEFACT_VERSIONING.md). In the AQL workspace, inspecting an OET enables **Download compiled template** and **Download Web Template**, so users can obtain these files without visiting GitHub. These are modelling artefacts, not patient data or a rendered clinical form.

The consumer regression is reproduced in `LegacyTemplateCompilerTest.compiledTemplateCanGenerateWebTemplateForForms`. The original output had no description and caused `OPTParser.parse()` to throw on `getDescription().getDetailsArray()`. See the pinned [SDK consumer](https://github.com/ehrbase/openEHR_SDK/blob/v2.35.0/web-template/src/main/java/org/ehrbase/openehr/sdk/webtemplate/parser/OPTParser.java) and [resource schema](https://github.com/ehrbase/openEHR_SDK/blob/v2.35.0/opt-1.4/src/main/xsd/Resource.xsd). Successful Web Template generation verifies this consumer, not hosted Designer import or clinical completeness.
