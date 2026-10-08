# Reuse external FHIR definitions

**Scope:** MCP and browser retrieval of external implementation guides, profiles and terminology definitions.
**Keywords:** FHIR, StructureDefinition, profile, IG, ValueSet, package, source, release, provenance

---

1. Read `fhir_project(action="get")` and `fhir_project(action="capabilities")`. Use an exact release and independent canonical namespace. Additional exact releases support inspection/import; unsupported authoring and validation must remain incomplete.
2. Inspect a public HTTPS IG page, package-list.json, package.tgz or definition JSON using `fhir_source(action="inspect", arguments={url, version?})`. Select an exact published version from publication metadata; never choose moving latest/current or infer that R6 is final.
3. Inspect identity, parent constraints, package dependencies, licence, source hash and retrieval time. Prefer an exact IG dependency and deriving a constrained profile to cloning another publisher's canonical identity.
4. After human review, import using the inspected `expectedSha256` and current `projectRevision`; individual definitions require a new `path`. Refetched bytes must match. Originals are immutable and their provenance does not imply clinical approval.
5. Connected definitions use `fhir_connection(action="search", arguments={id, resourceType, url?, name?, version?})`, then `fhir_source(action="inspect", arguments={connectionId, resourceType, resourceId})`. Refine queries when the bounded first page has more results. Credentials stay in administrator configuration; operational patient data is excluded.
6. Browse imported package definitions, run reuse discovery, and preserve exact parent and terminology references when drafting. Compile and validate against the selected release before submission to the existing IG platform. The IG's R4 parser is separate from the modeller's validator and cannot validate newer releases.

A ValueSet definition is not an expansion. Expansion and code membership need terminology-server evidence with versions and parameters. Preserve licences/copyright and keep originals, authored FSH, generated JSON and validation evidence separate.

References: [FHIR packages](https://hl7.org/fhir/R5/packages.html), [profiling](https://hl7.org/fhir/R4/profiling.html), [ValueSets](https://hl7.org/fhir/R4/valueset.html). Full workflow: `docs/FHIR_EXTERNAL_SOURCES.md` and the browser User guide.
