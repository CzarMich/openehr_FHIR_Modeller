# FHIR external sources and release capabilities

The browser **User guide → FHIR profiles and external sources** covers the same workflow. Both MCP clients and the browser can retrieve external definitions. The modeller authors drafts; the connected IG platform owns governed review, publication and distribution.

## Reuse an external implementation guide

1. Create/select a FHIR project with an exact release, your canonical namespace and exact package dependencies. FHIR release and IG/package version are distinct.
2. Use **External IGs and definition sources → Inspect URL**, or `fhir_source(action="inspect", projectId=…, arguments=…)`, with a public HTTPS IG page, `package-list.json`, `package.tgz` or definition JSON URL.
3. Publication histories return explicit versions; select a published version compatible with the project. Moving versions such as `current` and `latest` are excluded. Website pages discover machine-readable package links and metadata; scripts are never executed or copied.
4. Review canonical identity, package dependencies, licence/copyright, original source URL, SHA-256 and retrieval time. A supplied URL is evidence of provenance, not clinical approval or permission to redistribute.
5. Confirm `fhir_source(action="import")` with the inspected `expectedSha256` and current `projectRevision`. Individual definitions also require a new `path` (for example `imported/StructureDefinition-parent.json`). Sources are refetched; changed bytes require inspection again.
6. Packages are cached immutably with their original archive and added to project dependencies with exact ID/version/URL/hash. Browse/reuse their definitions with `fhir_package` and discover/generate profiles against those dependencies. Individual resources preserve original bytes and provenance and enter local reuse discovery. Imported originals cannot be overwritten; author derived drafts separately.

Example MCP arguments (JSON strings in tool calls):

```json
{"url":"https://publisher.example/ig/package-list.json"}
```

After choosing an exact publication, inspect again with `version`. Import that inspection using its returned hash and the revision returned by `fhir_project(action="get")`:

```json
{"url":"https://publisher.example/ig/package-list.json","version":"1.2.0","expectedSha256":"<inspection SHA-256>","projectRevision":"<current project revision>"}
```

Public sources require HTTPS without credentials, query strings or custom ports. Every request and redirect checks public DNS destinations, redirect limits and download size. Packages retain archive path/link and expansion-size protections. Individual definition JSON is limited to 2 MiB. Authenticated/internal sources use named connections instead of URL credentials. Deployments can optionally restrict public origins with the engine's `FHIR_SOURCE_ORIGINS` comma-separated HTTPS origins.

## Connected definition sources

An administrator configures `FHIR_CONNECTIONS_FILE` and allowed hosts, with credentials in protected files. Runtime and terminology connections support `fhir_connection(action="search")` with `id`, `resourceType` and optional canonical `url`, `name`, `version`; searches return metadata for at most 50 definitions. Refine the query when `hasMore` is true. External pagination links are never followed. `read` uses `resourceType` and `resourceId` and returns the original JSON and provenance.

To review/import a connected definition, use `fhir_source` with `connectionId`, `resourceType` and `resourceId`; import also requires `expectedSha256`, `projectRevision` and a new `path`. It rereads the configured connection and checks the reviewed hash. Allowed definition types are StructureDefinition, ValueSet, CodeSystem, ConceptMap, ImplementationGuide, SearchParameter, OperationDefinition, CapabilityStatement, StructureMap and NamingSystem. Patient resource queries are refused before any request, and responses with an unexpected type are rejected. Credentials never enter tool arguments or returned results.

## Profiles, terminology and ownership

Prefer an exact dependency on the publisher's IG and derive a constrained profile with your own canonical identity. Preserve parent constraints, canonical references, package versions and upstream notices. Copying an original for inspection can be useful; copying a whole IG and renaming its published identities obscures ownership and maintenance. Reuse is constrained by licence and compatible FHIR release.

Importing a ValueSet preserves its definition; it does not expand it or validate code membership. Expansion depends on a terminology server, code-system versions and operation parameters. Keep expansion results and terminology evidence separate from original definitions. Review binding strength and versioned canonical references before constraining a profile.

## Extensible FHIR releases

`fhir_project(action="capabilities")` and the browser's **Show installed release capabilities** report installed processors. R4 (4.0.1), R4B (4.3.0), R5 (5.0.0) have the current authoring toolchain. Additional exact releases, including prerelease suffixes, support definition inspection, source imports and package browsing. Compilation, profile generation, validation and FHIRPath stop with `FHIR_RELEASE_TOOLCHAIN_UNSUPPORTED` until a compatible processor is installed and verified. No final R6 release is assumed and no automatic cross-release conversion occurs. Changing a project release after authoring requires a new project.

The connected IG's installed Firely SDK is R4: its standalone result proves R4 syntax parsing, not full profile conformance. Its own release capabilities are independent of the modeller's HL7 validator. Newer IG releases retain JSON originals and metadata and report unavailable validation explicitly. Preserve modeller validation evidence for review rather than routing newer definitions into an R4 parser.

Run reuse discovery → derive/author → compile FSH → validate exact generated artefacts and synthetic examples → review/save Git sources → submit reviewed drafts to the configured IG. Compilation, conformance, clinical approval and publication are separate results.

## Browser addresses

| Environment | IG | Modeller |
| --- | --- | --- |
| Dev | https://dev-fhir-ig.sandbox.hygeoniq.com/ | https://dev-openehr-fhir-modeller.sandbox.hygeoniq.com/chat/ |
| Production | https://fhir-ig.sandbox.hygeoniq.com/ | https://openehr-fhir-modeller.sandbox.hygeoniq.com/chat/ |

Dev clients need LAN/VPN access, the Dev hostname mapping and the development CA. Production uses public DNS/TLS. See [Dev delivery](FHIR_DEV_DELIVERY.md) and [production promotion](FHIR_PRODUCTION_DELIVERY.md).

Authoritative sources: [HL7 FHIR packages](https://hl7.org/fhir/R5/packages.html), [profiling](https://hl7.org/fhir/R4/profiling.html), [ImplementationGuide](https://hl7.org/fhir/R4/implementationguide.html), [ValueSet](https://hl7.org/fhir/R4/valueset.html). Source and processor capabilities are verified independently of publication status.
