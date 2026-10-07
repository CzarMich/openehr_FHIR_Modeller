# Multiple CKMs and federated discovery

The assistant can use international, national, regional and organisation CKMs implementing the compatible CKM REST API. Existing search/get tools and draft OET generation accept a configured `ckm` name. `ckm_federated_search` combines discovery windows from several named sources while retaining each source's identity and version metadata. Source selection never accepts an arbitrary destination URL from an agent.

The adapter follows the [published CKM API contract](https://ckm.openehr.org/ckm/rest/v1/swagger.json), linked from the [openEHR CKM API documentation](https://openehr.atlassian.net/wiki/spaces/healthmod/pages/532643856/CKM+Webservices+REST+API). This contract advertises Basic authentication and a `JSESSIONID` header. Bearer and configurable API-key headers additionally support deployments behind compatible enterprise gateways; their availability depends on that deployment.

## Source and credential configuration

```dotenv
CKM_API_BASE_URL=https://ckm.openehr.org/ckm/rest/
CKM_SOURCES='{"national":"https://arketyper.no/ckm/rest/","organisation":"https://models.example.org/ckm/rest/"}'
CKM_DEFAULT_SOURCE=default
CKM_TIMEOUT=15
CKM_FEDERATION_TIMEOUT=30
CKM_AUTH='{"organisation":{"method":"basic","username":"modelling-reader","secret_file":"/run/secrets/ckm-password"}}'
```

`CKM_API_BASE_URL` defines source `default`; change it to replace the international endpoint. `CKM_SOURCES` adds names, with at most 32 sources including default. `CKM_DEFAULT_SOURCE` controls single-source calls that omit `ckm`. URLs require HTTPS, no credentials/query/fragment and the deployment's trusted CA configuration. TLS verification cannot be disabled. `HTTP_CA_BUNDLE` supports an organisation CA.

Omit a source from `CKM_AUTH` for public access. Each configured authentication profile requires `method` and exactly one of `secret_file` or `secret`. Prefer a read-only mounted secret file readable by the PHP runtime user. An inline secret belongs only in protected deployment configuration; never put either credential form in model files, chat or committed examples.

| Method | Extra fields | Outbound credential |
|---|---|---|
| `basic` | `username` | Basic username/password; the secret is the password |
| `session` | none | `JSESSIONID` header containing an existing session credential |
| `bearer` | none | Bearer token for the configured gateway |
| `api_key` | `header` | Credential in the configured header, such as `X-API-Key` |

Profiles cannot change URLs or unrelated request headers. Hop-by-hop, host, cookie, origin and authority headers are prohibited as API-key header names. Profile JSON rejects duplicate members and unknown fields. Credentials are never returned by `ckm_sources`, federated results or errors. Redirect following and automatic cookie handling are disabled. An authentication failure does not fall back to another source or an unauthenticated request.

Mounted secret files are read on each request, so credential rotation requires no client rebuild. A trailing newline is removed; blank, oversized or unsafe credentials fail closed. Directory mounts are preferable when a secret manager replaces files atomically. Session/token issuance and renewal remain the identity administrator's responsibility; the assistant does not log in as a browser user. The CKM credentials are deployment service identities shared by callers authorised to use that installation. They do not forward per-user upstream entitlements or implement CKM tenant ACLs.

## Federated search contract

```json
{"name":"ckm_federated_search","arguments":{"kind":"archetype","keyword":"body weight","sources":["organisation","national","default"],"maxResults":20}}
```

`kind` is `archetype` or `template`. Select one to eight distinct configured names; an empty list selects all configured sources only when there are at most eight. The keyword is nonempty UTF-8, up to 500 characters, without control characters. `maxResults` is 1–50. These limits reject invalid input rather than silently clamping it.

Sources are attempted in the supplied order within one shared `CKM_FEDERATION_TIMEOUT` budget of 1–60 seconds. Each request also respects `CKM_TIMEOUT` of 1–60 seconds. Sources not reached before the budget expires remain visible as NOT_EXECUTED. Network/authentication/response failures are FAILED with a safe generic code; successful sources are PASS.

Each result retains `source`, `source_url`, `kind`, CID and upstream revision/version metadata. The existing lexical/status ranking is reused, then ties are ordered by source, CID and revision/version/model identity. Identical archetype IDs from different CKMs stay separate. Always pass the selected source name into retrieval; the platform never silently substitutes another CKM's model or version.

`total` counts retrieved candidates before the final result limit. Each `source_results` record separately retains the upstream reported total and returned count. `truncated` is true when a source's reported matches exceed its retrieved window or the combined result exceeds the final limit. `all_sources_responded` and COMPLETE/PARTIAL/UNAVAILABLE describe request coverage, not an exhaustive global CKM index. A COMPLETE result may still be truncated. Search is deterministic lexical discovery and requires no embedding service or LLM.

This feature discovers candidates. It does not prove clinical suitability, resolve dependency compatibility, import models, approve models or compile templates. Dependency resolution must later pin the chosen source, revision and content hash.

## Deployment and repeatable verification

The PHP service alone implements source authentication and federation; browser clients use the same MCP operations. Add CKM settings and read-only secret mounts to the existing Docker/Compose deployment. For hosted services, provide the same settings and secret files through the platform's secret manager. Other storage providers, a CDR and external terminology remain optional.

The [optional Compose secret layer](../deploy/compose.ckm-secrets.example.yml) mounts a private directory. Set `CKM_SECRET_HOST_DIR` to that deployment directory, set each `secret_file` to `/run/secrets/ckm/<filename>`, and add `-f deploy/compose.ckm-secrets.example.yml` after the base Compose file and other applicable deployment layers. Grant the container's PHP user read access to the selected files and directory traversal; do not make credentials publicly readable. The layer contains no credentials and does not change existing CKM source settings.

Run the CKM configuration/client/federation and output-schema tests through the Docker development runtime. `scripts/test-ckm-container.sh` starts an isolated HTTPS fixture with synthetic Basic/session/bearer/API-key profiles and a real production MCP server. It verifies source isolation, search/retrieval, version preservation, partial failures, redirect rejection and mounted credential rotation; CI runs this harness automatically.

For explicitly opted-in read-only live acceptance, run `php scripts/ckm-public-smoke.php --allow-public-network` inside the development container. It uses the public international and Norwegian reference sources without deployment credentials and records retrieved identities/hashes. Live private CKM acceptance needs the organisation's account and permissions; isolated authenticated acceptance is not evidence of access to that account. [Public evidence](evidence/ckm-public-smoke.json) and [isolated HTTPS evidence](evidence/ckm-container-smoke.json) retain these scopes separately.

Migration: existing source names, single-source tools and default unauthenticated access remain compatible. CKM timeouts now have an explicit 60-second upper bound, source configuration is bounded to 32, and unexpected non-200 search/retrieval responses fail instead of being interpreted as successful content.
