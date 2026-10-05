# Connecting to openEHR Archetype Designer

[Archetype Designer](https://tools.openehr.org/designer/) can provide the visual modelling workspace alongside the openEHR Modelling Assistant. The integration boundary should be shared model artifacts and their revisions. A direct MCP connection inside the hosted Designer has not been established or verified.

## Recommended repository integration

Use a dedicated model-content GitHub repository, separate from the assistant application's source repository. Designer supports GitHub repositories, including private ones; its developer confirms this in the [repository support discussion](https://discourse.openehr.org/t/setting-up-an-archetype-designer-repository-linked-to-a-private-github-repo/2056/6). Its [GitHub authentication explanation](https://discourse.openehr.org/t/archetype-designer-is-asking-for-access-to-private-github-repos-and-more/5513/3) describes account authorization and repository permissions.

The shared-repository workflow is:

1. Author and visually review models in Designer using the dedicated repository.
2. Read the exact committed model revision through the assistant's repository adapter.
3. Use assistant tools to find CKM content, review requirements and differences, and optionally check terminology through terminology server or local value sets.
4. Configure the assistant to use a review branch created in Git. Save draft changes with the expected artifact revision. Review and merge through GitHub before refreshing Designer; selecting the `github` provider enables `model_review_request` to open a draft pull request. It does not merge or approve the model.
5. Export the needed operational artifacts from Designer and retain the source revision, exported content hash and validation reports together.

The assistant implements `MODEL_REPOSITORY_PROVIDER=git` with GitHub/GitLab/other Git remotes. It reads and writes ordinary model files, uses commit revisions, synchronizes before writes and rejects conflicts. Use project `default`, set `MODEL_GIT_CONTENT_PATH` to the actual model folder, and select `MODEL_GIT_LAYOUT=categories` or `flat` for the repository's native file arrangement. Existing native model-file edits from another Git client are covered by the integration tests; a hosted Designer UI round trip is still **not verified**. Category folders, flat native files and filenames containing Unicode/spaces/parentheses are covered by integration tests. Confirm the account's folder layout and branch selection before authoring. See [Git configuration](MODEL_REPOSITORY.md).

Filesystem storage remains available as a JSON snapshot provider and is not directly Designer-compatible. GitHub/GitLab draft review APIs are implemented; automatic merging and webhooks remain separate work. The user's Designer account must authorize repository access; deploying the adapter does not perform that account linking.

## File exchange with the current tools

An MCP client can read an exported model file and send its content to `model_validate`, `model_diff` or `model_artifact_save`. Store the exact original file, its Designer/source revision and provenance; update artifacts with `expectedRevision` to reject stale writes. Retrieve content with `model_artifact_get` for a reviewed handoff back to a modelling tool.

The assistant compiles ADL 2 templates into OPT 2 and performs native ADL 2/AOM/RM checks through the [configured engine](OPT_COMPILATION.md). A separate [bounded OET compatibility adapter](LEGACY_OPT_COMPILATION.md) uses the maintained ADL 1.4 parser and SDK OPT XML schema; complete OET/AOM coverage remains partial. Native output format and external-tool import compatibility must be checked independently. Designer's authoring JSON (`.t.json`) must be preserved as its own artifact; do not rename or assume it is an OPT or a lossless interchange format. The [Designer export discussion](https://discourse.openehr.org/t/automatically-convert-webtemplate-t-json-to-opt-format/4885) distinguishes Git-stored authoring artifacts from exported operational templates. Hosted export/automation capabilities must be verified against the actual account before enabling an automated release.

The assistant's draft OET generator supports a COMPOSITION with direct ENTRY identifiers or an explicit parent-linked nested placement tree and exact paths. A configured engine can check the nested draft against the retrieved ADL bytes under its bounded legacy profile. This is not evidence that Designer imports it without loss. Verify identifiers, cardinalities, languages, annotations, terminology bindings and dependent archetypes on an actual Designer import/export round trip before claiming interoperability.

## Terminology and access

The assistant already calls terminology server using a server-side service key. This key stays in its deployment secret store. Do not place it in a GitHub model repository or an externally hosted Designer configuration without verifying the Designer connector's supported authentication and credential handling. A direct Designer-to-terminology server connection has not been tested; terminology review through the assistant is available independently.

No public, supported hosted-Designer MCP or automation API was verified in this investigation. Account login pages and internal browser requests are not an integration contract. If a licensed/self-hosted Designer deployment supplies a documented API, implement a separate adapter against that contract and test authentication, concurrency, format preservation and deterministic compiler results.

See [repository capabilities](MODEL_REPOSITORY.md), [terminology](TERMINOLOGY.md), [validation limits](../CAPABILITIES.md) and [tool contracts](MCP_TOOLS.md).

## Configured shared repository and acceptance status

The development service is configured for the private [model-content repository](https://github.com/CzarMich/openehr-models), branch `main`, with `MODEL_GIT_CONTENT_PATH=local` and `MODEL_GIT_LAYOUT=flat`. It uses a repository-scoped SSH deploy key and pinned host identities. Application source remains in its separate repository. The previous local Git cache is retained; this connection uses its own persistent cache.

The live acceptance test saves a native ADL example through authenticated MCP, reads its exact bytes from an independent Git clone, pushes an external edit, verifies the assistant sees that commit, rejects a stale write, and verifies the next assistant save from the external clone. The model's embedded attribution remains intact. See `evidence/designer-git-roundtrip.json`. This tests repository interoperability, not clinical correctness or the hosted Designer UI.

To complete the hosted UI connection, an authorized account signs into [Archetype Designer](https://tools.openehr.org/designer/), authorizes its GitHub integration, selects the model repository and branch, then opens the native model from `local/`. Compare the saved Git revision and exported artifact with the assistant's retrieved content. Check dependent archetypes, paths, languages, cardinalities and bindings before accepting a full visual round trip. The inspected hosted service currently requires sign-in; no authenticated Designer session was available, so account linking and UI import/export remain explicitly unverified.

Different repository layouts are used in practice; the [modelling workshop repository](https://github.com/modellbibliotek/kurs-openEHR-jan-2021) demonstrates native files directly under `local/`, while [a clinical model library](https://github.com/regionstockholm/CKM-mirror-via-modellbibliotek) uses category folders. Configure the matching layout rather than relocating authored files silently.

The [unified browser workspace](BROWSER_WORKSPACE.md) provides Chat, Models and Governance in one window. Model browsing reads the configured filesystem, Git or SharePoint repository and carries the selected revision into chat.

See the [version/account compatibility report](ARCHETYPE_DESIGNER_COMPATIBILITY.md), [generic exchange architecture](MODELLING_TOOL_INTEGRATION.md), and [current step-by-step workflow](workflows/archetype-designer.md). These distinguish implemented operations from the remaining working-copy, handoff and semantic round-trip subsystem.

The assistant now accepts a manually exported file with `model_artifact_import`, preserving its exact original bytes and recording protected platform provenance. `model_import_inspect` distinguishes content markers from caller declarations; `.t.json` is preserved without an assumed OET/OPT/Web Template conversion. Imported supported OET/ADL sources can feed the documented compiler with explicit dependency revisions. This does not verify a hosted Designer UI round trip or automate its export API. [Manual workflow](MODEL_IMPORTS.md).
