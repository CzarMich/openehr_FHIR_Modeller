# SharePoint model repository

`MODEL_REPOSITORY_PROVIDER=sharepoint` implements the same logical project, artifact, metadata, revision, history, archive and stale-write contract as filesystem storage. It uses Microsoft Graph behind the repository boundary; modelling services have no Graph SDK dependency. Terminology, a CDR and an LLM provider are unnecessary. Native Git remains the preferred option for sharing ordinary model files with Archetype Designer.

## Storage and concurrency

Each accepted project state is a new JSON snapshot in a dedicated SharePoint document-library folder. A dedicated SharePoint list contains one pointer row per project. The pointer stores the snapshot item identifier and SHA-256 digest. Updates upload a candidate, then conditionally update the pointer with the previously read list-item ETag. A competing update returns a revision conflict and leaves the accepted pointer intact. The adapter never overwrites an earlier snapshot. New projects use an indexed, unique `ModelProjectId` column, so two instances cannot create duplicate project heads.

Artifact revisions and their history are platform revision identifiers inside the snapshot, including deletion tombstones. They are independent of SharePoint document-version numbers. History and metadata use the same domain implementation as the filesystem provider. No agent-supplied approval fields are accepted. Reads verify the snapshot's folder, digest and project identity before returning its content. Manually editing the index or snapshot files is unsupported; use repository tools to preserve these invariants.

Application immutability does not replace the site's retention, backup or administrator-access policy. A failed conditional commit can leave an unreferenced candidate file. A timed-out request may have committed remotely: read the current revision before retrying. The adapter deliberately does not delete candidates after an ambiguous outcome. Retention or garbage collection must first prove that a candidate is unreferenced and preserve the relevant recovery window.

The initial snapshot implementation bounds a project, including all retained artifact history, to `SHAREPOINT_MAX_PROJECT_BYTES` (8 MiB by default, at most 32 MiB). Set `MAX_UPSTREAM_BYTES` at least as high. Individual artifacts remain bounded to 2 MiB and metadata to 64 KiB / 16 nested levels. Oversized writes fail before uploading a candidate. There is no automatic history truncation. Collection traversal is bounded to 100 pages and 10,000 entries and fails explicitly when exceeded. Full-project snapshots favor simple atomic recovery; large model libraries and long histories require capacity planning rather than assuming unlimited SharePoint storage implies unlimited repository operations.

## Deployment configuration

The adapter runs in the same PHP container on local Docker, development and server deployments. It makes outbound HTTPS calls; it needs no public inbound callback. Configure a dedicated site/list/library folder for model snapshots, then inject identifiers and credentials privately:

```dotenv
MODEL_REPOSITORY_PROVIDER=sharepoint
MODEL_REPOSITORY_WRITE_ENABLED=false
SHAREPOINT_GRAPH_URL=https://graph.microsoft.com/v1.0/
SHAREPOINT_SITE_ID=<site-id>
SHAREPOINT_LIST_ID=<index-list-id>
SHAREPOINT_DRIVE_ID=<document-library-drive-id>
SHAREPOINT_FOLDER_ID=<snapshot-folder-item-id>
SHAREPOINT_DOWNLOAD_HOSTS=yourtenant.sharepoint.com
SHAREPOINT_MAX_PROJECT_BYTES=8388608
MAX_UPSTREAM_BYTES=8388608

# Choose externally rotated access token OR client credentials.
SHAREPOINT_ACCESS_TOKEN=
SHAREPOINT_TENANT_ID=<directory-tenant-id>
SHAREPOINT_CLIENT_ID=<application-id>
SHAREPOINT_CLIENT_SECRET=<secret-from-private-runtime-configuration>
SHAREPOINT_TOKEN_URL=
SHAREPOINT_TOKEN_SCOPE=https://graph.microsoft.com/.default
```

The default client-credentials endpoint is constructed from `SHAREPOINT_TENANT_ID`. `SHAREPOINT_TOKEN_URL` supports an explicitly configured HTTPS authority, including the appropriate national-cloud authority. Configure the matching Graph URL and token scope for that cloud. No tenant identifier is hard-coded. A configured bearer token bypasses token acquisition and must be renewed by the deployment's secret manager. Do not configure both authentication methods. Client-credentials tokens are reused within one service instance until their refresh window; they are not persisted to disk or included in model content.

Outbound Graph credentials are separate from inbound MCP authentication. Users may authenticate to the platform through any supported OIDC issuer, including Keycloak. Their incoming token is not forwarded to Microsoft Graph. For the runtime application, prefer [selected-resource permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview): consent to the appropriate Selected scope and explicitly grant access to the configured site or resources. Read-only operation needs read permission; model writes need write permission. Consent alone does not grant resource access. Provisioning a new list/folder requires an administrator identity with the applicable creation permissions; it is separate from ordinary modelling operations.

Graph commonly redirects content downloads to a preauthorized SharePoint URL. Configure exact lower-case HTTPS download hostnames in `SHAREPOINT_DOWNLOAD_HOSTS`; no wildcard is accepted. The second request carries neither the Graph bearer token nor cookies, refuses further redirects, verifies TLS and enforces the response bound. Download URLs are never returned as model metadata or written to logs. `HTTP_CA_BUNDLE` may supply an enterprise trust chain; certificate verification cannot be disabled.

## Provisioning

Create a dedicated generic SharePoint list with these API-facing columns:

| Column | Type | Constraint |
|---|---|---|
| `Title` | Built-in text | Project identifier |
| `ModelProjectId` | Text, 64 characters | Required, indexed, unique |
| `SnapshotItemId` | Text, 250 characters | Required |
| `SnapshotHash` | Text, 64 characters | Required SHA-256 |

Create a separate folder in the configured document library. The repository checks the column contract before access and refuses an index without uniqueness enforcement. Use portable project identifiers such as `neonatal-admission`.

With `SHAREPOINT_SITE_ID`, `SHAREPOINT_DRIVE_ID` and provisioning credentials configured, run inside the PHP tooling container:

```sh
php scripts/sharepoint-provision.php --create --name=modelling-test
```

This creates a new index list and snapshot folder and prints their configuration identifiers. It never deletes or modifies an existing resource by name. If creation fails partway through, the report lists only resources it created; inspect them before retrying. The scripts are repository tooling and are not copied into the production runtime image. Mount the selected script read-only under `/app/scripts/` when using that image, or use the development container. Keep provisioning credentials outside the model repository and replace them with runtime credentials afterward.

## Native OIDC tenants

For `AUTH_MODE=oidc`, configure `OIDC_TENANT_SHAREPOINT_REPOSITORIES` with each verified issuer/tenant namespace mapped to:

```json
{
  "<64-character-tenant-namespace>": {
    "site_id": "<site-id>",
    "list_id": "<list-id>",
    "drive_id": "<drive-id>",
    "folder_id": "<folder-item-id>"
  }
}
```

Every tenant needs a distinct list and snapshot folder. Missing mappings fail closed; authenticated requests do not fall back to the global identifiers. The configured outbound service identity must have access to those resources. This mapping partitions platform tenants within the configured Graph authority; it does not automatically provision Microsoft tenants or issue separate tenant credentials. API-key mode uses the single configured repository principal. Model-write authorization and browser confirmation remain unchanged.

## Verification and acceptance

The stateful contract fixture checks actual Graph request shapes, unique creation, ETag conflicts, lost-update prevention, immutable history, metadata restrictions, failed uploads/commits and digest failures. Security cases cover unsafe paths, cross-folder pointers, response bounds, pagination origin/path checks, OAuth failures and credential-free downloads. Filesystem regression tests exercise the extracted shared snapshot semantics.

Run the production-container integration test without a Microsoft account:

```sh
scripts/test-sharepoint-container.sh
```

It generates an ephemeral TLS CA, starts isolated Graph/OAuth fixtures and the production PHP image, exercises the real MCP protocol and repository writes, then removes only its disposable containers/data. Its download endpoint rejects any forwarded Authorization header. [Container evidence](evidence/sharepoint-container-smoke.json) is fixture acceptance, not a live Microsoft tenant result. CI repeats this test.

For a configured SharePoint tenant, run inside the PHP container:

```sh
php scripts/sharepoint-smoke.php
php scripts/sharepoint-smoke.php --allow-test-writes
```

The first is read-only and verifies schema/list access. The second additionally requires `MODEL_REPOSITORY_WRITE_ENABLED=true`; it creates a uniquely named synthetic project, verifies content/history/conflicts/tombstones, and archives it. It does not operate on existing clinical projects. Live SharePoint acceptance remains externally blocked until tenant credentials and storage identifiers are available; the implementation, configuration, mocks, contracts and integration harness are present independently.

## Migration, backup and failure handling

Existing filesystem snapshots retain their layout and revision semantics. The shared domain implementation is an internal refactor, not an on-disk migration. Selecting SharePoint does not copy existing data. Export artifacts through the repository contract and import exact bytes into a new SharePoint project, preserving source revisions/provenance in metadata. Keep the source repository until the reviewed migration passes acceptance. Deep metadata that exceeds the documented nesting bound is now rejected before saving, preventing revisions that cannot be read back.

Back up both the index and the snapshot folder, together with configuration identifiers. Capture accepted pointer rows and their referenced immutable files, verify digests, and restore into a separate dedicated list/folder before changing production configuration. Site retention/deletion policies must preserve referenced snapshots. An external policy that removes one is reported as unavailable or invalid storage; the adapter never silently substitutes another revision.

No SharePoint operation approves or releases a clinical model. Branching, hosted reviews, webhooks and release tags are not SharePoint repository capabilities. Use Git hosting or the governance services for those workflows.

References: [conditional list-field updates](https://learn.microsoft.com/en-us/graph/api/listitem-update?view=graph-rest-1.0), [column uniqueness](https://learn.microsoft.com/en-us/graph/api/resources/columndefinition?view=graph-rest-1.0), [file uploads](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0), [content downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0), [client credentials](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
