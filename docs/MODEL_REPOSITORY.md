# Persistent modelling projects

A conversation is not a model repository. The same MCP project/artifact tools work with either implemented provider: `filesystem` or `git`. Set `MODEL_REPOSITORY_PROVIDER` in deployment configuration. Writes require `MODEL_REPOSITORY_WRITE_ENABLED=true`. Neither provider requires a terminology server, bindings, CDR or model-provider API key.

The provider-neutral `ModelRepository` contract supports project list/get/create/archive, artifact list/get/save/delete and history. MCP exposes list/get/create and artifact read/save/history. Archive/delete and the Git branch/diff methods are application interfaces, not additional MCP tools. Hosted pull-request creation and approval are not implemented.

## Shared contract

Use paths under `requirements/`, `archetypes/`, `templates/`, `terminology/`, `aql/`, `tests/`, `validation/`, `decisions/` and `documentation/`. No project needs every category. Paths are case-sensitive, up to 240 bytes. Filesystem paths accept ASCII letters, digits, underscore, dot, slash and hyphen. Git additionally accepts UTF-8 filenames, spaces and parentheses; controls, backslashes, percent escapes and traversal segments are rejected. Traversal, symlinks and arbitrary root files are rejected by model writes. Markdown, JSON, YAML, ADL, OET, OPT and AQL are stored as UTF-8 text; storage does not validate format or clinical semantics.

Create artifacts with `expectedRevision=null`. Update with the current revision from `model_artifact_get`; a stale value returns `REVISION_CONFLICT`. Saved content carries SHA-256, provider, timestamp and DRAFT status. Metadata is untrusted documentation and cannot confer approval. Deleted artifacts retain history with a tombstone. Archived projects remain readable and reject artifact writes.

## Filesystem provider

```dotenv
MODEL_REPOSITORY_PROVIDER=filesystem
MODEL_REPOSITORY_PATH=/data/models
MODEL_REPOSITORY_WRITE_ENABLED=true
```

Each project is an atomic `<project-id>.json` snapshot with a lock file. Logical paths are entries inside that snapshot, not separate model files. History uses opaque provider revisions. Per-project locks and atomic rename support one active application instance; qualify network filesystems separately. Limits: 2 MiB per artifact, 64 KiB metadata and 32 MiB per project including history. No history pruning is implemented.

## Git provider

```dotenv
MODEL_REPOSITORY_PROVIDER=git
MODEL_REPOSITORY_PATH=/data/models
MODEL_REPOSITORY_WRITE_ENABLED=true
MODEL_GIT_REMOTE_URL=ssh://git@github.com/your-organisation/clinical-models.git
MODEL_GIT_BRANCH=main
MODEL_GIT_AUTHOR_NAME="openEHR Modelling Assistant"
MODEL_GIT_AUTHOR_EMAIL=modelling-assistant@example.org
MODEL_GIT_SSH_KEY_FILE=/run/secrets/model_git_key
MODEL_GIT_KNOWN_HOSTS_FILE=/run/secrets/model_git_known_hosts
MODEL_GIT_SYNC_SECONDS=5
MODEL_GIT_TIMEOUT=30
```

Use a dedicated **model-content repository**, separate from the application's source repository. The adapter works with GitHub, GitLab, enterprise Git hosts, absolute local Git paths and local Git without a remote. Use `ssh://git@host/group/repository.git`; SCP-style `git@host:path` shorthand is not accepted. HTTPS remotes support anonymous access; authenticated private hosting uses SSH. Inline credentials, URL queries/fragments, redirects and interactive authentication are refused. `MODEL_GIT_REMOTE_URL=` provides fully offline Git history.

Mount a repository-scoped SSH deploy key and verified `known_hosts` read-only into the app. The runtime UID must be able to read them. Use a read-only deploy key and disable writes for a read-only integration; grant repository write permission when draft writes are required. Obtain host fingerprints through a trusted channel. No personal key, private key, access token or terminology credential belongs in a model repository. See `deploy/compose.git-secrets.example.yml` for mounts.

Git contains ordinary model files. The `default` project maps to categories such as `archetypes/` and `templates/` beneath `MODEL_GIT_CONTENT_PATH` (empty by default; use `local` when the authoring repository uses that folder). Other projects map to `projects/<id>/...`. Optional project/artifact metadata lives under `.modelling/`. Existing root model files are discoverable as `default` without writing metadata. Files outside supported model categories remain in the tree but are not exposed as artifacts. Authoring JSON is preserved byte-for-byte; it is not converted to OPT. For a native flat authoring repository, set `MODEL_GIT_LAYOUT=flat`. The logical MCP path `templates/Example.t.json` then maps to `<content-path>/Example.t.json`, and `archetypes/Example.adl` maps to `<content-path>/Example.adl`. Supported flat native suffixes are `.adl`, `.adls`, `.adlf`, `.a.json`, `.t.json`, `.oet` and `.opt`. Other categories retain their folders. Flat native files cannot use nested artifact paths. Choose `categories` for a folder-based repository; mixed conventions require an explicit migration. Changing either setting does not move files. Actual native model bytes are preserved.

The local object store is `MODEL_REPOSITORY_PATH/git/objects.git`. It is a bare repository, so remote worktrees, hooks, submodules, attributes filters and executable model files are never run. Commits supply revision identifiers. Reads refresh at most every `MODEL_GIT_SYNC_SECONDS` seconds; writes always refresh first. No automatic merges or force-pushes of model updates occur. A stale artifact revision fails. A competing push fails without advancing the accepted local branch; reread and review the latest content before retrying. Remote history rewrites/deleted branches fail explicitly. To change the remote, select a fresh storage path and review the migration.

Individual Git commands have a timeout and bounded output. Accepted trees allow only regular files, up to 2 MiB each, 32 MiB total and 10,000 files. Artifact history is capped at 1,000 entries and fails explicitly above that limit. These limits do not bound the entire remote Git history downloaded during fetch: use a trusted, appropriately sized model repository and storage quotas. Large CKM mirrors need a separate design. A configured remote outage can prevent repository operations when refresh is due; bundled guides and local validation remain usable. Leave the remote empty for fully offline repository operation.

`model_branch_create` and `model_repository_diff` expose the existing Git branch/diff operations. Branch creation uses a create-only lease to avoid overwriting an existing remote branch. Select `github` or `gitlab` to add metadata, branch protection status and draft review API operations. See [hosted repositories](HOSTED_REPOSITORIES.md). Webhooks, merge automation and release tags remain separate work. Set the configured branch to a branch created through Git/your hosting service for the MCP modelling workflow; it cannot switch branches through a tool call.

## Provider capabilities

| Provider selection | Storage and history | Branch/diff | Hosted reviews |
|---|---|---|---|
| `filesystem` | Atomic snapshots and platform revisions | Unavailable | Unavailable |
| `git` | Plain files, Git revisions, optional remote synchronization | MCP tools | Unavailable |
| `github` / `gitlab` | Same native Git storage and revisions | MCP tools plus hosted branch listing | Draft creation, reuse and metadata |
| `sharepoint` | Immutable project snapshots, conditional pointer updates, logical revisions/history | Unavailable | Unavailable |

`model_projects` returns actual adapter capabilities. These flags describe the adapter; the documented MCP tool catalogue defines what clients can invoke. Unsupported provider-specific modes never silently fall back to filesystem.

## Backup and migration

Back up filesystem snapshots consistently while writes are stopped or under their locks. For Git, back up the bare object store and configuration; a configured remote provides the pushed commit history but does not replace a retention/backup policy. Restore into a separate persistent volume with the runtime UID ownership and verify current files, hashes and history before switching traffic. Give each instance its own cache and use remote revision checks between instances.

Changing the provider does not migrate existing data. Export artifacts through `model_artifact_get`, then import their exact content through the destination provider. Preserve original revision/provenance in metadata; filesystem revision identifiers are not Git SHAs. Do not commit filesystem snapshot internals as native Designer files. Retain the old volume until the reviewed migration is verified.

Record artifact type, human version, source CKM/version/hash, declared dependencies, requirement IDs and decision references. Never invent an author, version, approval or validation result. See the [shared Git workflow](workflows/shared-git-models.md) and [Designer integration](ARCHETYPE_DESIGNER_INTEGRATION.md).

## Native identity namespaces

[OIDC deployments](OIDC.md) select storage only from verified issuer/tenant claims. Filesystem and local Git caches use private namespace directories. Hosted Git requires distinct configured remotes per tenant; unknown mappings fail closed. API-key deployments retain their existing shared repository. Authentication changes do not automatically migrate or expose existing model data.

## SharePoint snapshots

Select `sharepoint` for the Graph repository adapter. It shares the filesystem revision/history semantics and adds remote ETag conflict detection, hash verification and dedicated tenant storage mappings. See [SharePoint provisioning, permissions and acceptance](SHAREPOINT_REPOSITORY.md). Metadata is limited to 64 KiB and 16 nested levels across providers so saved revisions remain readable. Native SharePoint document versions and clinical approvals are distinct from application revision history.

The [terminology catalogue](TERMINOLOGY_CATALOGUE.md) stores versioned code systems, value sets and mapping drafts under `terminology/catalogue/`. It uses the same conditional writes and history on every provider. Exact canonical/edition identity is hashed into the path; malformed external edits are reported as QA findings rather than ignored.

[Terminology binding plans](TERMINOLOGY_BINDING_PLANS.md) use `terminology/binding-plans/` for revision-bound DRAFT evidence across all repository providers. Save requires the observed source revision and, for updates, the plan revision. Reads recompute freshness against current source and catalogue; this does not provide a cross-artefact atomic transaction or clinical approval.

## Requirements graph storage

`requirements/traceability.json` stores the versioned [project requirements graph](REQUIREMENTS_TRACEABILITY.md). It uses the same artifact revision/history and conditional-write contract on filesystem, Git and SharePoint. Source nodes pin project-local artifacts; review/validation nodes refer to the separately protected governance ledger. Moving a model repository alone does not migrate its ledger. Graph reads revalidate direct file/Git edits and recompute source freshness; graph assertions never override authoritative lifecycle policy.

`model_project_qa` checks an exact retained model revision against the current repository and its recorded provenance/requirement/audit trail. Filesystem, Git and SharePoint share the same contract. It reports stale revisions and makes no repository writes. See [Validation and QA](VALIDATION_AND_QA.md).

## PostgreSQL and optional retrieval cache

See [PostgreSQL and cache deployment](POSTGRES_AND_CACHE.md) for the private service stack, restricted database role, migration preserving audit hashes, immutable-revision cache keys, outage fallback and backup/recovery procedure. `GOVERNANCE_DATABASE_PATH` is used only with the legacy SQLite driver. Authorization and clinical decisions always use authoritative state.

`template_compile_project` reads exact template/dependency revisions and saves native OPT 2 ADL or supported OPT 1.4 XML under `templates/opt/<source-name>.opt` together with its bounded build manifest in repository metadata. The save is atomic, creates a DRAFT, preserves source bytes, and keeps earlier builds in revision history when current output changes. Identical builds reuse their revision. [Default artefact versioning](ARTEFACT_VERSIONING.md). [Compiler and evidence contract](OPT_COMPILATION.md).

The create-only `originals/<import-id>/<filename>` namespace preserves original bytes and filenames. Ordinary saves/deletes reject this namespace. Git stores raw native files; filesystem/SharePoint snapshots use an explicit text or base64 envelope. Protected audit receipts, rather than editable sidecars, establish platform import provenance. Binary originals have `content: null`. See [manual imports](MODEL_IMPORTS.md) for retry, external Git tampering, transport limits and migration boundaries.
