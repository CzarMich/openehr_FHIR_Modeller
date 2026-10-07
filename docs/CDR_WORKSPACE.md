# AQL workspace and CDR connections

The AQL workspace supports **Model → Query → CDR → Results** without an AI-provider connection. Open **AQL workspace** in the sidebar; user instructions also live in **Help → AQL and CDR connections** inside the application.

## User workflow

1. Open the settings gear, expand **CDR Connections**, enter the server address and authentication, then **Save connection** and **Test**. Connections belong to the signed-in profile. Existing secret fields remain blank when editing; blank preserves a saved secret. Delete a connection to remove its credentials.
2. Select the CDR environment in **AQL workspace**. Inspect a model from the enterprise repository, a personal Git connection, local files or the selected CDR. **Models → Query this model** carries the selected exact revision into AQL.
3. Personal repository templates automatically load their saved archetypes from the same Git commit and verify the package manifest hashes before compilation. Older project layouts use their own archetypes folder; local templates use the archetype files loaded alongside them. OPTs are already compiled. Remote CDR OPTs are read-only inputs and never overwrite repository files. The inspection records the source hash and available revision.
4. Select paths and generate a bounded AQL draft. To describe a query in plain language, enter what it should return and press **Ask assistant to write AQL**; an isolated provider session receives only inspected model fields and the drafting instruction, validates against that exact model, and puts its accepted draft directly in the single AQL query box. It receives no existing editor query, parameter values, results, history or chat transcript. Review and run the query yourself. Clear selection removes all path choices (including filtered-out paths), updates the count and disables path-based generation until another field is selected. When editing AQL, type the inspected model’s root alias followed by `/`, or press **Ctrl+Space**, to choose an exact path with the mouse or arrow keys and Enter. **Validate** checks syntax and, when selected, structural paths against the inspected OPT. **Explain** describes the parsed query; **Format** uses native normalisation.
5. Enter a JSON object of scalar query parameters, then **Run query**. Inspect table, JSON or raw response views. Copy/export requires a click. **Cancel query** stops the client request; a remote CDR may continue work after disconnect.
6. Save query text for reuse in the selected CDR environment within your private profile. Central connection definitions never create a shared query library. Older queries remain under **Show my unassigned queries** until you load and save a copy for an environment. History display and clearing are also scoped to that environment. History keeps the last 100 query texts, parameter names, counts, status and timing. It does not retain parameter values or results. Put patient identifiers in parameters rather than saved query literals. Reloading or signing out clears the results view.

## Supported scope

The provider-neutral `CdrAdapter` port has an initial generic openEHR REST implementation. It sends standard POST Query API requests with `q`, `query_parameters`, `fetch` and `offset`, and reads ADL 1.4 Definition API template metadata/OPTs. It has no composition create/update/delete methods. The reference CDR's public request construction was examined; its proprietary query engine is not a dependency.

Native AQL syntax validation remains available through `aql_validate` without any CDR. Optional `templates` accepts up to eight exact OPT inputs (`identifier`, `content`), hash-pinned at the engine boundary. SELECT, WHERE, ORDER BY and containment paths are checked using the parsed AST and the template's native RM profile. Excluded or absent paths fail. Unresolved slots, polymorphic paths and unsupported boolean/version containment produce `INCOMPLETE`, never a complete path-validation pass. Predicate values, function types, terminology and clinical meaning remain unverified. Validation is not clinical approval.

AQL LIMIT must be 1–1,000. When LIMIT is present, API fetch/offset are omitted; otherwise page size is 1–1,000 and offset is 0–1,000,000. The client rejects responses larger than 8 MiB, more than 1,000 rows or more than 200 columns. An empty portable `columns`/`rows` result is valid. A full page means another page *may* exist, not that a total count is known. Use ORDER BY for stable ordering.

Connection timeouts are 1–120 seconds. Connection testing uses shorter probes and a nil-EHR query bounded to one row, exposing diagnostics only. Remote errors return fixed codes, never raw error bodies. TLS, authentication, unsupported API, query rejection, rate limiting, timeout and cancellation have separate codes. Version headers are shown where supplied; a successful query establishes API availability even when the optional API-root description is absent.

Personal Git model listing is bounded to 5,000 model files. Truncated upstream trees fail explicitly rather than silently omitting dependencies. Model input is at most 2 MiB per file; the native engine request including selected dependencies is bounded to 8 MiB. Exact revision/hash evidence accompanies inspected inputs; no silent dependency retrieval or version substitution occurs.

## Deployment

CDR support is opt-in and independent of conversational chat. Use the existing browser identity configuration and request-signing key (`CHAT_REVIEW_SIGNING_KEY` / `GOVERNANCE_BROWSER_KEYS`, matching browser origin and local/OIDC identity issuer). CDR assertions use a separate `openehr-cdr+jwt` type and audience, bind HTTP method, target and body digest, expire after 60 seconds and consume a replay nonce. Governance decision freshness and permissions remain unchanged. A signed-in user can configure their private CDR connection without a governance role.

1. Generate a dedicated 32-byte hexadecimal key outside the repository (`openssl rand -hex 32`). Protect the file, grant the application read access and back it up separately from the volume. Do not rotate by replacing it: existing profiles require re-encryption with the previous key.
2. Set `MODELLING_CDR_KEY_FILE` to that host file and add `-f deploy/compose.cdr.yml` to the normal Compose invocation. This enables `CDR_ENABLED` and `CHAT_CDR_ENABLED` and mounts the key at `/run/secrets/cdr-key`. The base Compose file provides the separate `cdr-data` volume; the image creates `/data/cdr` owned by the runtime user.
3. Include `deploy/compose.engine.yml` for native validation/inspection. Ensure the application and browser share matching browser-signing configuration. No model provider is required for AQL.
4. For private servers, set `CDR_ALLOWED_HOSTS` to exact hostnames/IPs. Public HTTPS hosts work without this list. Private HTTP additionally requires `CDR_ALLOW_HTTP=true`; use only for explicitly trusted development networks. TLS verification cannot be disabled. A connection may carry its trusted CA certificate.
5. Preserve the CDR route's request size and response timeouts when using another reverse proxy. The supplied Caddy and VPS Nginx configurations permit model payloads up to 16 MiB and 180-second responses. File uploads have a separate two-minute request timeout.

The VPS delivery script includes the CDR overlay when `/opt/openehr-modelling-assistant/config/cdr-key` exists. Back up `cdr-data` and its encryption key as a pair. Losing the key makes private connection credentials and query libraries unrecoverable.

### Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `CDR_ENABLED` | `false` | Enable private CDR application operations |
| `CHAT_CDR_ENABLED` | `false` | Enable the browser proxy and profile-scoped chat tools |
| `CDR_DATA_DIR` | `/data/cdr` | Separate encrypted profiles, query metadata and transient cancellation markers |
| `CDR_ENCRYPTION_KEY_FILE` | empty | Absolute path to the dedicated 64-hex-character encryption key |
| `CDR_ALLOWED_HOSTS` | empty | Exact private network destinations administrators permit |
| `CDR_ALLOW_HTTP` | `false` | Permit HTTP only for explicitly allowed destinations |
| `CDR_CONNECTIONS_FILE` | empty | Optional administrator-owned connection definitions for named authenticated actors |

AES-256-GCM encrypts profile state with the actor identity as authenticated additional data. The credential resolver interface can be replaced by a keychain/vault implementation. The shipped resolver supports encrypted application credentials and administrator-only `env:CDR_SECRET_*` references. Extra header values are encrypted and omitted from summaries. HTTP uses DNS-pinned addresses, verified TLS, bounded responses, no redirects, no ambient proxies and no cookies. Password/token/authentication headers are never accepted as MCP arguments.

For direct MCP clients, administrator definitions are explicitly assigned to transport-derived actor IDs, not caller-provided identities. Mount the JSON read-only and set `CDR_CONNECTIONS_FILE`:

```json
{"connections":[{"allowedActors":["the-authenticated-principal-id"],"connection":{"id":"development","name":"Development","baseUrl":"https://cdr.example.org","auth":"bearer","secretRefs":{"token":"env:CDR_SECRET_DEVELOPMENT_TOKEN"}}}]}
```

The HTTP service/API-key actor and a browser human are distinct identities. Browser chat routes CDR tools through the signed human session so it sees that person's connections. Administrator connections cannot be edited through browser settings.

## MCP and privacy

Browser assistants also have `personal_repository_models` and `personal_repository_aql`. They list templates before archetypes, compile hash-verified packages, page/filter inspected paths, generate drafts and validate agent-written queries against the same pinned OPT. They neither modify repository files nor execute queries. GitHub reads use raw blobs verified against the Git object hash to avoid base64 download expansion. Inspected OPT 1.4 paths include field labels from each archetype’s own terminology. Repository reads enforce profile ownership, a two-minute deadline, concurrency limits and a single retry for interrupted reads.

Tools: `cdr_connection_list`, `cdr_connection_test`, `cdr_capabilities`, `aql_validate`, `aql_explain`, `aql_execute`, `aql_history`, `aql_saved_list`, `aql_saved_get`, `aql_saved_save`, `model_generate_aql`.

AI tools cannot execute CDR queries or read query history and saved-query contents. Browser discovery hides `aql_execute`, `aql_history`, `aql_saved_list` and `aql_saved_get`; both the browser tool dispatcher and direct MCP handlers enforce this restriction. History and saved query text can contain patient identifiers in literals, so merely removing result rows is insufficient. Blocking execution also prevents an assistant inferring patient facts through repeated count queries. Results require an explicit **Run query** in the browser and are not put into provider messages, chat snapshots, repository artifacts or query history. No AI result-sharing feature is introduced. Raw result exports are user-initiated; CSV export neutralises spreadsheet-formula prefixes.

Browser REST operations are under `/chat/api/cdr/<operation>` with session + CSRF protection and are forwarded to the purpose-authenticated `/api/v1/cdr/<operation>`. Remote credentials are sent only to validated configured endpoints. The service remains a CDR client; it does not become a clinical repository.

## Verification and standards

Mock CI covers multiple users/environments, encrypted state integrity, parameter forwarding, row bounds, error/secret redaction, OAuth client credentials, cancellation, saved queries, template inputs, request-bound browser authentication and result views. Native tests cover real OPT 1.4/OPT 2 paths. Live development checks use read-only nil-EHR queries and report metadata only; CI does not depend on an external CDR.

Authoritative development specifications: [AQL](https://specifications.openehr.org/releases/QUERY/development/AQL.html), [Query API](https://specifications.openehr.org/releases/ITS-REST/development/query.html), [Definition API](https://specifications.openehr.org/releases/ITS-REST/development/definition.html). Retrieval followed the specification index/Markdown policy; REST pages without Markdown twins used HTML and OpenAPI.

## Cached modelling sources

Personal Git trees and files use a disposable AES-256-GCM cache under the browser service’s `model-cache` directory. Keys bind the signed-in identity, connection, credential fingerprint, repository and immutable commit; raw Git blobs additionally reuse unchanged objects across commits. Branch access is rechecked upstream once per operation, even for pinned cache hits. Removed connections and revoked credentials cannot unlock old cached sources. SHA object checks and template-package SHA-256 checks remain mandatory. Failed or corrupted reads are not cached; cache unavailability falls back to the authoritative source.

Entries expire after 24 hours. The cache is limited to 256 MiB and 1,024 files, evicting least recently used entries; files are encrypted, owner-only and disposable. It contains modelling artefacts only, never CDR query results, saved-query text or parameter values. Enterprise repository reads retain their existing optional authenticated revision-keyed cache. CKM retrieval for new authoring continues to check its live source; a cached Git dependency is never presented as the latest CKM edition. Native compilation is rerun against exact bytes, avoiding stale results after a compiler deployment.

See [patient-data boundary and executable evidence](PATIENT_DATA_BOUNDARY.md).
