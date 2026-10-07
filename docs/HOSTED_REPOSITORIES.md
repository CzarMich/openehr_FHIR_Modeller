# GitHub and GitLab model repositories

Select `MODEL_REPOSITORY_PROVIDER=github` or `gitlab` to add hosting capabilities to the existing Git storage adapter. Model files, revision history, expected-revision checks, remote synchronization and layout mapping retain the generic Git contract. The hosting adapter reads the configured repository's metadata, paginated branches and protection status, and creates or reads draft pull/merge requests. It never approves or merges a clinical model.

## Configuration and environments

```dotenv
MODEL_REPOSITORY_PROVIDER=github
MODEL_GIT_REMOTE_URL=ssh://git@github.com/your-organisation/clinical-models.git
MODEL_GIT_BRANCH=draft/admission
MODEL_GIT_REVIEW_TARGET=main
MODEL_REPOSITORY_WRITE_ENABLED=true
MODEL_HOSTED_TOKEN=
MODEL_HOSTED_API_URL=
```

For GitLab, select `gitlab` and set a remote such as `ssh://git@gitlab.example.org/group/subgroup/clinical-models.git`. Nested group names are supported. The repository identifier is derived from the configured remote; it is never supplied by a tool caller. The default GitHub API is `https://api.github.com/`; the GitLab default is `https://<remote-host>/api/v4/`. For GitHub Enterprise Server set `MODEL_HOSTED_API_URL=https://<remote-host>/api/v3/`. A self-managed GitLab API may use an explicitly configured HTTPS port or path. The API and remote host must match, except for GitHub's documented `github.com` / `api.github.com` pairing.

The same configuration works in local Docker, development and server deployments. Mount a persistent Git cache and use separate scoped credentials for each environment. Configure SSH deployment keys and pinned host keys as described in [Model Repository](MODEL_REPOSITORY.md). SSH authenticates Git fetch/push; `MODEL_HOSTED_TOKEN` authenticates the HTTPS hosting API. One does not replace the other. Tokens must be provided through a private runtime environment/secret store; never through remote URLs, MCP arguments, browser storage or committed environment files.

For GitHub, use a repository-scoped fine-grained token or externally rotated installation token. Metadata and contents read access cover repository/branch reads; pull-request read/write access is needed for draft review operations. Git writes require a separate write-capable SSH key. For GitLab, use a project-scoped access token with `read_api` for read-only operation or `api` for creating merge requests, and the project role required by the hosting service. The adapter consumes the configured token; token issuance and renewal belong to the deployment's secret manager. Public repositories may permit anonymous reads. Provider permissions, branch rules, licensing and token expiry still apply.

In native OIDC mode, `OIDC_TENANT_GIT_REMOTES` maps each verified issuer/tenant namespace to a distinct remote. The hosting repository identity is derived after this mapping. Missing authenticated tenant mappings fail closed. Metadata discovery cannot enumerate other repositories visible to the service token. Equivalent GitHub SSH/HTTPS URLs cannot be assigned to different tenants. Project-level RBAC remains separate work.

## Tools and review workflow

| Tool | Behaviour |
|---|---|
| `model_repository_info` | Adapter capabilities, configured active branch, optional hosted repository metadata |
| `model_repository_branches` | Up to 100 hosted branches per page, revisions and reported protection; `next_page` signals possible more results |
| `model_branch_create` | Create-only Git branch from a reachable revision; active branch does not change |
| `model_repository_diff` | Bounded Git diff between reachable immutable revisions |
| `model_review_request` | Open a draft against `MODEL_GIT_REVIEW_TARGET`, or return an existing open request for the same repository and branch pair |
| `model_review_get` | Review number, URL, state, draft flag and available revision metadata |

Configure `MODEL_GIT_BRANCH` as the working draft branch before saving model changes. Branch creation does not switch the shared deployment workspace. After saving and checking the draft, request a review for that branch. GitHub requests have `draft=true`; GitLab requests use the documented `Draft:` title. Existing open reviews are returned without altering their state or contents. A repeated request does not silently replace the description. A conflict from a competing request is reported; reread/retry to locate the existing request.

Hosted review status is collaboration metadata, not clinical approval evidence. `clinical_approval` is always false. The review may already have been marked ready by a human; the adapter reports that state without changing it. GitLab's diff base is reported as `comparison_base_revision`, not as the current target branch head. Missing or inaccessible protection details remain null/unknown. No tool changes branch protection, requests a merge, approves a review, force-pushes model changes or publishes a release.

Repository mutations require deployment write enablement and the same verified OIDC write role/scope as artifact writes. The browser additionally displays the exact branch or review request and requires confirmation. Generic `git` remains usable offline; selecting a hosted mode adds a hosting API dependency only to hosting operations. Terminology remains optional.

## Failure and security contract

Requests use a fixed administrator-configured HTTPS origin, certificate verification, optional `HTTP_CA_BUNDLE`, configured timeouts and `MAX_UPSTREAM_BYTES`. Path segments are encoded separately; caller text cannot select an API destination. Redirects are refused, API error bodies are not returned, and tokens are omitted from operation results. Hosted errors distinguish access denial, not found, conflict, rate limiting, invalid response and unavailable service. Do not automatically retry a mutation after a timeout: inspect the hosted review before retrying.

The adapter does not perform account-wide repository discovery, manage provider OAuth installations, receive webhooks or automate merges. Existing filesystem and generic Git configurations are unchanged. Changing `git` to `github`/`gitlab` with the same remote, branch and cache adds API capabilities without rewriting model files. Changing repository identity requires a fresh cache and the normal reviewed migration procedure.

## Repeatable verification

`tests/Enterprise/HostedRepositoryTest.php` covers both provider HTTP contracts, nested paths, read/write boundaries, duplicate requests, error redaction, redirect refusal, response bounds and tenant mappings. `tests/Tools/HostedOutputCases.php` covers the published MCP output contracts. The standard MCP smoke client exercises discovery, repository information, Git branch creation and revision diffs when writes and Git are enabled. Browser tests exercise review confirmation separately from model saving.

Run live acceptance inside the PHP container with provider settings supplied privately:

```sh
php scripts/hosted-repository-smoke.php
php scripts/hosted-repository-smoke.php --allow-test-review --review-branch=acceptance/synthetic-model --review-target=main
```

The first command is read-only. The second requires an existing disposable `acceptance/` branch containing a synthetic commit ahead of its target; it creates/reuses a draft and checks revision retrieval. Close that draft and delete only the disposable branch afterward. The harness does not edit the default branch. Keep execution results in `docs/evidence/`. [GitHub live evidence](evidence/hosted-github-acceptance.json) records successful real API checks and cleanup. Live GitLab acceptance requires deployment credentials; mocked contract verification is not a claim that a particular tenant installation has been tested.

References: [GitHub pull requests API](https://docs.github.com/en/rest/pulls/pulls), [GitLab merge requests API](https://docs.gitlab.com/api/merge_requests/), [GitLab branches API](https://docs.gitlab.com/api/branches/).
