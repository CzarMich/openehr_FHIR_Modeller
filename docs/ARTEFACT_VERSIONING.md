# Artefact versions

Versioning is on by default. Save an updated template, archetype or other working artefact at the **same repository path**. Changed bytes create a new revision; the selected branch's current file contains the latest saved content. Git retains the earlier content. An unchanged save does not create an extra revision; changes to accompanying metadata or compilation evidence can still create a revision.

For example, successive AKI builds update:

| Artefact | Current path |
|---|---|
| Template source | `AKI/templates/oet/AKI_clinical_documentation.oet` |
| Archetype | `AKI/archetypes/openEHR-EHR-COMPOSITION.encounter.v1.adl` |
| Compiled template | `AKI/templates/opt/AKI_clinical_documentation.opt` |
| Form schema | `AKI/data/json/web-templates/AKI_clinical_documentation.webtemplate.json` |
| Package evidence | `AKI/data/json/template-packages/AKI_clinical_documentation.oet.json` |

There is no timestamp or content-hash suffix on newly generated current files. Outputs previously saved with hash-suffixed names remain available; the next package save creates or updates the stable output paths without deleting older files. Purpose subfolders are retained, so equally named templates in different subfolders have different output paths.

## Designer edits and CKM upgrades

For new template builds in a selected personal repository, the current project's `archetypes/` files take precedence over CKM copies with the same identifiers. The workspace reads one current branch snapshot and passes the exact bytes to the generator. Revision-keyed caching does not reuse an older file after a commit. Ambiguous duplicate copies fail explicitly.

A designer edit that changes a hash is a file revision, not an instruction to invent a new identifier or versioned filename. The source is still compiled and validated; repository precedence does not establish clinical correctness. Before saving a recovered or edited template, the workspace reloads its current repository archetypes and compiles with those bytes. Incompatible edits stop the save. Changes during preparation or confirmation require a fresh review.

Ask to **regenerate the existing template** to replace its current OET at the same path, with refreshed OPT, form schema and dependency manifest. The assistant reads the existing source first and should retain the requested constraints. Git preserves earlier revisions. Historical package inspection continues to use its recorded exact dependencies rather than silently substituting current sources.

An actual **new CKM version or revision** is a separate upgrade decision for both archetypes and templates. The assistant checks upstream version/revision evidence and compatibility before proposing an upgrade; a different hash alone is insufficient. A new archetype identifier (for example, `.v2`) can coexist with `.v1`. For an explicitly requested CKM revision retaining the same identifier, the browser's `template_build_oet` accepts `ckmUpgrades` with those identifiers; the package retains that intent, previews changed files and rejects intervening designer edits. Downloaded CKM templates must likewise be compared with local edits before replacement. Upgrades are not automatically applied in the background.

MCP clients can supply current source bytes through `template_build_oet(archetypes=[{identifier, content}])`. Supplied identifiers must match their ADL declarations; missing identifiers fall back to CKM. Personal repository credentials and source selection remain inside the browser service.

## Finding a version

In **Saved artefacts**, **Open file** follows the branch's current file. **Saved version** and **Copy version link** identify the saved commit. **Version history** opens that file's Git history. A saved SHA-256 fingerprint identifies its exact bytes; it is not a semantic version number or an approval.

The assistant can use `personal_repository_history` for up to 20 recent revisions, then `personal_repository_get` with `ref` to read a particular commit and its SHA-256. Without `ref`, reads use the current branch. Personal connection ownership and upstream access are checked before cached reads. Enterprise model repositories expose `model_artifact_history` and `model_artifact_get(revision=...)`; Git and filesystem providers retain their previous revisions.

## Exact template dependencies

A template, its current archetypes, compiled outputs and dependency manifest are saved together in one commit after native compilation. The change preview shows created, updated and unchanged files, including previous and new hashes. Existing concurrency checks reject stale revisions and intervening branch changes; writes never force-update the branch.

Package schema `openehr-template-package/2` records each archetype's stable path, SHA-256 and immutable Git blob identifiers for SHA-1 and SHA-256 object formats. The selected repository's object format determines the blob identifier used. Model loading verifies both the Git object hash and the expected content SHA-256. Thus template A can keep its exact earlier dependency while template B uses a designer edit or deliberately upgrades the current archetype file. It does not silently substitute newer CKM content. No duplicate archive files are required, and same-repository project moves preserve these blob references.

Older schema `/1` packages remain readable. If their current dependency file has changed or disappeared, the loader locates the commit that last changed that manifest, verifies its exact manifest bytes, and reads the dependency there. Missing or mismatching historical content fails explicitly. Templates without a package manifest still use their project folder and require native compilation; they have no recorded dependency pin to recover.

`template_compile_project` similarly updates a stable `templates/opt/` path and retains source/dependency revisions and hashes in build metadata. Repeating the same build reuses its revision. QA for an older source can retrieve the matching build evidence from that output’s history. A manually owned output or an output belonging to a different source is not silently replaced. Immutable imported originals remain protected; updates belong in working artefacts.

## Modelling and governance

File history is separate from [openEHR archetype/template identification](https://specifications.openehr.org/releases/AM/development/Identification.html). The platform preserves supplied openEHR identifiers; it does not infer a semantic version change from a byte hash. A deliberate modelling change may require an identifier/version decision and updated references. Newly saved or compiled content remains a draft; approvals remain tied to their exact reviewed revision.

## Verification

- `chat/test/template-packages.test.mjs`: GitHub and GitLab updates, unchanged saves, stale writes, stable outputs, previous bytes, shared-archetype pins and legacy package recovery.
- `chat/test/repository-models.test.mjs`: profile access, immutable references, hash checks, missing/tampered inputs and bounded caches.
- `chat/test/personal-workspace.test.mjs`: standalone artefact updates and unchanged-content writes; complete browser change previews and receipts.
- `chat/test/browser.spec.mjs`: current-file, saved-version and version-history links.
- `tests/Enterprise/TemplateBuildsTest.php`: changed builds retain their output path, previous content and evidence for both repository providers and both native output formats.
- `tests/Enterprise/GitRepositoryTest.php`, `tests/Enterprise/RepositoryAndGovernanceTest.php`: durable revisions, unchanged saves, concurrency and historical reads.

These checks use synthetic model artefacts and make no patient-data queries.
