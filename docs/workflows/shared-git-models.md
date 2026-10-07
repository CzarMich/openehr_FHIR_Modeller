# Shared model repository workflow

Use the same `ModelRepository` tools with filesystem, SharePoint or Git storage. Filesystem keeps projects in local snapshots. Git keeps native files and commit revisions and can synchronize with GitHub, GitLab or another approved remote. Terminology is optional throughout. Users can follow this workflow in the [browser chat](../BROWSER_CHAT.md) or another connected MCP client. Browser users review and confirm each proposed repository write before it is executed.

```mermaid
flowchart TD
    Start[Choose model repository provider] --> Choice{Storage}
    Choice --> FS[Filesystem project snapshots]
    Choice --> SP[SharePoint project snapshots]
    SP --> Open
    Choice --> Git[Git: local or configured remote]
    FS --> Open[Open project and read current artifact revision]
    Git --> Open
    Author[Archetype Designer or another Git authoring client] -.-> Remote[Shared model-content repository]
    Git <--> Remote
    Open --> Draft[Review requirements and draft model changes]
    Draft --> Check[Run available structural checks and inspect diff]
    Check --> Save[Save model DRAFT using expectedRevision]
    Save --> Conflict{Revision or push conflict?}
    Conflict -->|Yes| Open
    Conflict -->|No| Terms{Terminology binding required?}
    Terms -->|No| Hosted[Optional draft pull or merge request]
    Terms -->|Yes| Plan[Inspect saved source; preserve references; propose catalogue candidates]
    Plan --> Evidence[Save revision-bound DRAFT plan; review findings and freshness]
    Evidence --> Hosted
    Hosted --> Human[Independent human review and qualified validation]
    Human --> Review[Review and merge through the hosting service]
```

The Designer edge requires account authorization and verified directory/format compatibility; no hosted UI round trip has been completed. The assistant can create a hosted draft review; human review and merge remain in the hosting service. Neither creates clinical approval evidence.

1. Create a dedicated model-content repository. Retain application source and deployment secrets elsewhere. Create a review branch in Git or the hosting UI.
2. Configure `MODEL_REPOSITORY_PROVIDER=git` (or `github`/`gitlab` for hosting APIs), the remote, that branch, and a scoped deploy key with pinned host identities. Mount a persistent cache. See [repository settings](../MODEL_REPOSITORY.md).
3. Open project `default` for the configured content root. Use `MODEL_GIT_CONTENT_PATH=local` when needed, with `MODEL_GIT_LAYOUT=categories` for folders or `flat` for native files directly under that root. MCP still exposes logical paths such as `archetypes/<name>.adl`. Existing files are discovered without metadata changes. For a new empty repository, call `model_project_create` with `id: "default"`. Other project IDs use `projects/<id>/`.
4. Fetch an artifact through `model_artifact_get`, preserving its revision and original content. Retrieve supporting CKM sources and guides. Native authoring JSON stays JSON; an exported OPT is a separate artifact.
5. Review proposed content with `model_diff` where supported and `model_validate`. Neither tool certifies full model semantics. Terminology-free models need no binding records. Local value sets work without a server; requested external checks with no configured server return `NOT_EXECUTED`.
6. Save through `model_artifact_save` with `expectedRevision`. The adapter refreshes the remote, commits native files and pushes without overwriting remote history. Conflicts require rereading and reconciling changes. A failed push does not become an accepted local revision.
7. Preserve reports and requirement links alongside models. Call `model_review_request` for a hosted draft, or request review through the hosting service and use a qualified compiler/validator before any operational release. Review branches and commits are not approval evidence.
8. Refresh the authoring client after the reviewed merge. Verify imports/exports against the original model, dependent archetypes, languages, cardinalities and bindings before claiming lossless interoperability.

For an entirely local workflow leave `MODEL_GIT_REMOTE_URL` empty, or select `filesystem`. Choose the repository based on collaboration and backup needs; no terminology or model-provider service is required for either.

For coded XML sources, use [binding plans](../TERMINOLOGY_BINDING_PLANS.md) to inspect explicit choices, preserve references, compare project ValueSets and record unresolved decisions. Save the plan against the source revision, then regenerate it after source or catalogue changes. This does not edit the native model or establish clinical approval.

Native ADL 2 and supported legacy OET builds can use `template_compile_project`; the generated `.opt` stays a native file and build evidence uses repository metadata. It never rewrites imported sources or constitutes Git/clinical approval. [Compiler profiles](../OPT_COMPILATION.md).

Manually exported source files can be preserved through [original imports](../MODEL_IMPORTS.md). Native bytes are committed under the create-only original namespace; protected platform receipts identify their exact commits and hashes. Compile supported OET/ADL using those pinned revisions, keeping the OPT and build evidence separate. External-tool declarations and a shared Git history do not establish semantic round-trip equivalence.
