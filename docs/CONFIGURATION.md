# Configuration reference

The executable source of truth is `src/Configuration/Settings.php`. `.env.example` contains local defaults, not production credentials. Compose reads `.env`; the PHP process itself reads process environment only. Restart/recreate containers after changes. Do not commit `.env` or include secret values in logs.

| Variable | Code default | Meaning / requirement |
|---|---|---|
| `OPENEHR_ENGINE_URL` | empty | Optional fixed native-engine origin; local `http://127.0.0.1:8090` or trusted HTTPS. |
| `OPENEHR_ENGINE_KEY_FILE` | empty | Absolute private engine service-key file; required when enabled. |
| `OPENEHR_ENGINE_TIMEOUT` | `50` | Native operation timeout in seconds, 1–60. |
| `APP_ENV` | `development` | development, testing or production; production HTTP requires authentication. |
| `PRODUCT_NAME` | `openEHR Modelling Assistant` | Human product name in instructions. |
| `PRODUCT_SHORT_NAME` | `openEHR Modelling Assistant` | Brand metadata reserved for client/UI presentation; not rendered by a server UI. |
| `PRODUCT_VENDOR` | `Michael Anywar` | Deployment branding metadata; does not change product ownership or third-party rights. |
| `PRODUCT_DESCRIPTION` | `AI-assisted openEHR modelling and knowledge services` | MCP server description. |
| `PRODUCT_URL` | empty | Optional HTTPS MCP website URL. |
| `PRODUCT_SUPPORT_URL` | empty | Optional branding metadata for integrators. |
| `PRODUCT_DOCUMENTATION_URL` | empty | Optional branding metadata for integrators. |
| `PRODUCT_LOGO_URL` | empty | Optional HTTPS MCP icon URL. |
| `MCP_SERVER_NAME` | `openehr-modelling-assistant` | MCP serverInfo name; clients can verify this identity. |
| `MCP_TRANSPORT` | `streamable-http` | streamable-http or stdio; --transport CLI option overrides. |
| `MCP_HOST` | `127.0.0.1` | Compose published bind address; 127.0.0.1 by default. |
| `MCP_PORT` | `8343` | Compose published port, 1–65535; internal ingress port remains 8343. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated literal hostnames without ports; no wildcard. |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated HTTPS browser origins, no path/trailing slash; empty denies browser origins. |
| `AUTH_MODE` | `none` | Local, deployment API key, or native OIDC bearer verification; production HTTP requires authentication. |
| `AUTH_API_KEY` | empty | Required secret for api_key, at least 32 characters. |
| `AUTH_API_KEY_HEADER` | `X-API-Key` | Inbound MCP key header name. |
| `OIDC_ISSUER` | empty | Exact trusted HTTPS issuer; required for OIDC. |
| `OIDC_AUDIENCE` | empty | Expected API access-token audience; required for OIDC. |
| `OIDC_JWKS_URI` | empty | Optional administrator-pinned HTTPS key URL; otherwise validated issuer discovery. |
| `OIDC_CLOCK_SKEW` | `60` | Allowed clock skew in seconds, 0–120. |
| `OIDC_MAX_TOKEN_AGE` | `7200` | Maximum age from issued-at in seconds, 60–86400. |
| `OIDC_ALLOWED_CLIENT_IDS` | empty | Optional comma-separated accepted azp/appid values. |
| `OIDC_REQUIRED_SCOPES` | `modelling.read` | Required scopes; accepts scope or Entra scp. |
| `OIDC_ROLES_CLAIM` | `roles` | Signed role-array claim, with dotted paths such as realm_access.roles. |
| `OIDC_REQUIRED_ROLES` | empty | Required signed roles, useful for application-only access. |
| `OIDC_WRITE_ROLES` | `modeller,administrator` | Roles allowing draft writes; modelling.write scope also permits writes. |
| `PROJECT_RBAC_ENABLED` | `false` | Enable repository-wide per-project authorization; requires OIDC. Tokens need `project:<id>:read` or `project:<id>:write`; `projects:admin` grants project administration. |
| `OIDC_TENANT_CLAIM` | empty | Signed tenant claim; empty treats the issuer as one tenant. |
| `OIDC_ALLOWED_TENANTS` | empty | Optional explicit signed-tenant allowlist. |
| `OIDC_TENANT_GIT_REMOTES` | `{}` | Tenant namespace hashes mapped to distinct Git remotes; see [OIDC migration](OIDC.md). |
| `CKM_API_BASE_URL` | `https://ckm.openehr.org/ckm/rest/` | HTTPS REST base for source default. |
| `CKM_TIMEOUT` | `15` | CKM timeout seconds, 1–60. |
| `CKM_SOURCES` | `{}` | JSON object mapping additional names to HTTPS REST base URLs; at most 32 including default. |
| `CKM_DEFAULT_SOURCE` | `default` | Configured name used when a tool omits ckm. |
| `CKM_AUTH` | `{}` | Private per-source Basic/session/bearer/API-key profiles; prefer `secret_file`. |
| `CKM_FEDERATION_TIMEOUT` | `30` | Shared request budget for one federated search, 1–60 seconds. |
| `TERMINOLOGY_FHIR_BASE_URL` | empty | Optional HTTPS FHIR base; empty disables external terminology calls. |
| `TERMINOLOGY_BEARER_TOKEN` | empty | Optional external terminology bearer secret; mutually exclusive with API key. No token refresh. |
| `TERMINOLOGY_API_KEY` | empty | Optional external terminology service secret, separate from inbound AUTH_API_KEY. |
| `TERMINOLOGY_API_KEY_HEADER` | `X-API-Key` | Outbound terminology key header. |
| `TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER` | `url` | url (FHIR standard) or explicit system compatibility for a legacy provider. |
| `HTTP_TIMEOUT` | `15` | External terminology timeout seconds. Legacy fractional environment values round upward; CKM inherits it if CKM_TIMEOUT absent. |
| `HTTP_SSL_VERIFY` | `true` | Must be true; false is rejected. |
| `HTTP_CA_BUNDLE` | empty | Optional readable CA bundle path mounted in the container. |
| `MAX_REQUEST_BYTES` | `2097152` | HTTP body limit; effective tool content budget is smaller due to JSON envelope. |
| `MAX_UPSTREAM_BYTES` | `8388608` | Maximum downloaded response bytes; also bounded by format-specific parsers. |
| `LOG_LEVEL` | `info` | debug/info/notice/warning/error/critical/alert/emergency; logs remain redacted. |
| `MODEL_REPOSITORY_PROVIDER` | `filesystem` | filesystem, git, github, gitlab and sharepoint are implemented. Hosted modes reuse Git storage and add API capabilities. |
| `MODEL_REPOSITORY_PATH` | `/tmp/openehr-models` | Absolute private writable path. Compose overrides it to /data/models; development override uses /tmp/development-models. |
| `MODEL_REPOSITORY_WRITE_ENABLED` | `false` | true enables draft project/artifact write tools; false denies them. |

| `MODEL_GIT_CONTENT_PATH` | empty | Relative model root in Git, e.g. local; does not move existing files. |
| `MODEL_GIT_LAYOUT` | `categories` | categories stores category folders; flat maps native ADL/template filenames at the configured root. |
| `MODEL_GIT_REMOTE_URL` | empty | Optional Git remote: ssh://, anonymous HTTPS, absolute local Git path; empty means offline Git. |
| `MODEL_GIT_BRANCH` | `main` | Branch for reads and draft commits. |
| `MODEL_GIT_REVIEW_TARGET` | `main` | Target branch for draft hosted reviews; independent of the active working branch. |
| `MODEL_HOSTED_API_URL` | empty | GitHub public API or GitLab remote-host API default; explicit HTTPS endpoint for enterprise hosts. Must match the Git remote host. |
| `MODEL_HOSTED_TOKEN` | empty | Secret API token for the configured GitHub/GitLab repository; separate from Git SSH credentials. See [hosted repositories](HOSTED_REPOSITORIES.md). |
| `MODEL_GIT_SYNC_SECONDS` | `5` | Read refresh interval, 0–300 seconds. Writes always refresh. |
| `MODEL_GIT_TIMEOUT` | `30` | Per-command Git timeout, 1–120 seconds. |
| `MODEL_GIT_AUTHOR_NAME` | `openEHR Modelling Assistant` | Git service committer name; not human approval identity. |
| `MODEL_GIT_AUTHOR_EMAIL` | `modelling-assistant@localhost` | Git service committer email. |
| `MODEL_GIT_SSH_KEY_FILE` | empty | Private SSH key path inside container; configure with known-hosts path. |
| `MODEL_GIT_KNOWN_HOSTS_FILE` | empty | Pinned SSH host identities; strict verification remains enabled. |

Other supported process settings: `HTTPS_PROXY` and comma-separated `NO_PROXY` control outbound HTTPS; `XDG_DATA_HOME` changes the cache/session root (default `/tmp`, application subdirectory added). Legacy `ALLOWED_HOSTS` is accepted only when `MCP_ALLOWED_HOSTS` is absent. Composer development uses `COMPOSER_HOME`. No model-provider or CDR secret is required by the MCP core. The optional browser chat has its own identity and model-provider configuration. Private Git remotes use the optional SSH credential files above; hosted GitHub/GitLab APIs use MODEL_HOSTED_TOKEN; SharePoint Graph credentials use the dedicated settings below.

## Multiple CKMs

```dotenv
CKM_SOURCES='{"regional":"https://regional.example.org/ckm/rest/","organisation":"https://models.example.org/ckm/rest/"}'
CKM_DEFAULT_SOURCE=regional
```

Replace example domains with actual CKM REST bases. The default international source remains available as `default`; change `CKM_API_BASE_URL` to replace it. Call `ckm_sources`, then pass `ckm:"regional"` to search/get/draft tools. Each server must implement the compatible CKM REST API. Per-source authentication and bounded federated discovery are implemented; unrelated API families need their own adapter. Public international/Norwegian acceptance and isolated authenticated HTTPS contracts pass. See [CKM sources and authentication](CKM_SOURCES.md) for profiles, secret mounts, limits and repeatable verification.

See [deployment](DEPLOYMENT.md) for environment choices, [security](SECURITY.md) for trust boundaries, and [terminology](TERMINOLOGY.md) for terminology server/Keycloak configuration.

## Browser chat settings

The optional Node client reads `.env.chat` or the external `MODELLING_CHAT_ENV_FILE`. Its complete variable table is in [browser chat configuration](BROWSER_CHAT.md#configuration), with a copyable [example](../.env.chat.example). These settings do not change the PHP configuration contract.

## SharePoint repository settings

| Variable | Default | Meaning |
|---|---|---|
| `SHAREPOINT_GRAPH_URL` | `https://graph.microsoft.com/v1.0/` | Pinned HTTPS Graph API root; configure the matching cloud authority/scope. |
| `SHAREPOINT_SITE_ID` | empty | Site containing the dedicated project-index list. |
| `SHAREPOINT_LIST_ID` | empty | Index list with required unique project key and snapshot-pointer columns. |
| `SHAREPOINT_DRIVE_ID` | empty | Document-library drive containing snapshots. |
| `SHAREPOINT_FOLDER_ID` | empty | Dedicated snapshot folder item identifier. |
| `SHAREPOINT_DOWNLOAD_HOSTS` | empty | Comma-separated exact HTTPS download hostnames; no wildcard or credential forwarding. |
| `SHAREPOINT_MAX_PROJECT_BYTES` | `8388608` | Project snapshot/history bound, 1–32 MiB; must not exceed MAX_UPSTREAM_BYTES. |
| `SHAREPOINT_ACCESS_TOKEN` | empty | Externally renewed Graph bearer token; alternative to client credentials. |
| `SHAREPOINT_TENANT_ID` | empty | Outbound directory tenant used to construct the default token endpoint. |
| `SHAREPOINT_CLIENT_ID` | empty | Outbound application identity for client credentials. |
| `SHAREPOINT_CLIENT_SECRET` | empty | Private outbound client credential; never model content. |
| `SHAREPOINT_TOKEN_URL` | empty | Optional explicit HTTPS token endpoint; otherwise constructed from tenant ID. |
| `SHAREPOINT_TOKEN_SCOPE` | `https://graph.microsoft.com/.default` | Resource scope for outbound token acquisition. |
| `OIDC_TENANT_SHAREPOINT_REPOSITORIES` | `{}` | Verified platform tenant namespace to distinct site/list/drive/folder map. |

See [SharePoint setup, permissions, migration and acceptance](SHAREPOINT_REPOSITORY.md). These settings are unnecessary for other providers. Inbound identity and outbound Graph credentials remain separate.

Terminology operation settings apply to lookup, validation, expansion, ConceptMap translation and canonical resource discovery. No server is required. Language, count/offset and independent resource editions are tool arguments, not environment variables. Live acceptance uses the `SMOKE_*` variables documented in [Terminology](TERMINOLOGY.md#repeatable-verification); they do not change production configuration.

Local terminology catalogues need only the configured ModelRepository; they add no service credentials. Catalogue saves use `MODEL_REPOSITORY_WRITE_ENABLED` and native OIDC draft-write permissions. Explicit external records use existing terminology settings. The PHP `mbstring` extension is required for Unicode case rules and is included in the supplied images. See [catalogue schema and limits](TERMINOLOGY_CATALOGUE.md).

Binding plans need no new environment variables. They use repository and write-access settings and remain available without a terminology server. Bounds and explicit per-request aliases are documented in [binding plans](TERMINOLOGY_BINDING_PLANS.md).

## Human review and audit configuration

Persisted governance is opt-in with `GOVERNANCE_ENABLED=true`; use PostgreSQL for production/shared storage, with SQLite retained for compatible local deployments. [Storage and cache configuration](POSTGRES_AND_CACHE.md) documents every PostgreSQL and optional Valkey setting. The [review deployment variable tables](REVIEW_DEPLOYMENT.md#core-variables) document every `GOVERNANCE_*` and `CHAT_REVIEW_*` setting, role mapping, tenant alignment, signing-key rotation and upgrade requirements. Default Compose browser builds use `MODELLING_BROWSER_TARGET=reviews` and need no model-provider credential. Set `MODELLING_BROWSER_TARGET=chat` when enabling conversational chat; the development chat override already selects it. Clinical actions require repository writes, an authenticated interactive human, the corresponding role and qualified validation.

The [requirements graph](REQUIREMENTS_TRACEABILITY.md) uses existing model repository and write settings, without a graph database or model-provider configuration. Optional audit-event links use `GOVERNANCE_ENABLED` and the configured ledger; ordinary requirement/model links work without governance or terminology services. Native inherited path checks remain an engine integration boundary.

Document validation and project QA add no mandatory settings. They use the configured repository and tenant; authentic validation/review links require governance storage. FLAT/STRUCTURED input files can select their format explicitly. See [Validation and QA](VALIDATION_AND_QA.md).

MCP versions and capability advertising are product contracts rather than administrator overrides. Explicit HTTP loopback CORS origins are allowed only outside production; other origins require HTTPS. See [the MCP protocol profile](MCP_PROTOCOL.md).

Browser chat and model governance share one verified human session. Review browsing and decision freshness have separate bounded lifetimes; the explicit platform-administrator role maps to all governance roles. See [review deployment](REVIEW_DEPLOYMENT.md#one-browser-identity-for-chat-and-governance).

The optional compiler overlay also reads `MODELLING_ENGINE_KEY_FILE` and `MODELLING_ENGINE_IMAGE`; the Java process reads `ENGINE_KEY_FILE`. See [complete engine configuration](OPT_COMPILATION.md).

Manual imports use existing `MODEL_REPOSITORY_WRITE_ENABLED`, OIDC write permissions and `GOVERNANCE_ENABLED`/audit database settings. No import secret is added. The decoded limit is 2 MiB; base64 increases request size. Set `MAX_REQUEST_BYTES=4194304` consistently at ingress and application if a full 2 MiB source must pass HTTP; the default 2 MiB request limit admits a smaller source. Project snapshot/client limits still apply. Read-only inspection needs no audit backend. See [manual imports](MODEL_IMPORTS.md).

## Optional CDR connections

`CDR_ENABLED`, `CDR_DATA_DIR`, `CDR_ENCRYPTION_KEY_FILE`, `CDR_CONNECTIONS_FILE`, `CDR_ALLOWED_HOSTS`, `CDR_ALLOW_HTTP` and browser `CHAT_CDR_ENABLED` configure the separate CDR client. Defaults, encrypted storage, private network rules, credential resolution and deployment are documented in [CDR workspace](CDR_WORKSPACE.md#configuration).
