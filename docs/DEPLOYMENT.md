# Deployment and supported environments

## Purpose and boundaries

Deploy this service where AI agents need openEHR modelling knowledge, source retrieval,
persistent model drafts and terminology checks. No patient repository, internal LLM,
Microsoft account or CDR is required to start it. Live CKM and external terminology
operations need access to their configured services. Bundled resources work offline.

## Environment choices

| Environment | Transport and exposure | Authentication | Persistence |
|---|---|---|---|
| Local workstation | stdio or loopback HTTP | `none`, development only | Docker named volume or local mounted directory |
| Automated tests | isolated containers and mocked dependencies | dedicated test key for HTTP auth tests | disposable project root |
| Integration/sandbox | HTTPS gateway; controlled outbound connections | API key; separate machine key to terminology | backed-up dedicated volume |
| Enterprise controlled network | HTTPS ingress/API gateway, private service network | organisation-reviewed API key or native OIDC with configured API audience/scopes | dedicated storage and backup policy |
| Fully disconnected | stdio or local HTTP, bundled knowledge and filesystem/local Git projects | local policy | offline filesystem or Git with an empty remote; live CKM/terminology unavailable |

Container verification uses Linux amd64, PHP 8.4 and Docker Compose. macOS/Windows
Docker Desktop and Kubernetes deployments are architecture-compatible but not tested
unless listed in execution evidence. No cloud-provider-specific deployment is required.
A production organisation review is still required; deployment does not imply approval by that organisation.

## Source build and local startup

```sh
cp .env.example .env
docker build --target production -t openehr-modelling-assistant:local .
docker build --target ingress -t openehr-modelling-ingress:local .
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8343/health
curl --fail http://127.0.0.1:8343/ready
```

The app image serves **FastCGI on 9000**, not HTTP. Caddy serves a public introduction at `/`, plus `/mcp`, `/health`
and `/ready` on container port 8343. The optional Node chat client serves `/chat/` through the same ingress. Compose publishes 8343 on loopback by default.
No FPM port is published. Change `MCP_HOST` and `MCP_PORT` for the published socket;
they do not configure an embedded PHP web server. TLS belongs to the enterprise gateway.
The application, ingress and optional chat images build from this checkout. Image digests and Composer lock pin the
application inputs; Alpine package security updates are resolved at build time.

## Enterprise deployment

1. Copy the example environment to a secret-managed deployment configuration.
2. Set `APP_ENV=production`, `AUTH_MODE=api_key`, and a random `AUTH_API_KEY` of at least
   32 characters. Generate it with your secret manager (or `openssl rand -hex 32`).
3. Set `MCP_ALLOWED_HOSTS` to the actual forwarded MCP hostname plus any deliberate
   internal client hostname. Include loopback for local probes if required.
4. Terminate HTTPS at a trusted gateway. Route only `/mcp` to Caddy's private HTTP port.
   Restrict `/health` and `/ready` to monitoring networks if exposing them externally.
5. Forward the original Host, API-key header, Accept, Content-Type, Mcp-Session-Id,
   MCP-Protocol-Version and response headers. Do not log credential headers or bodies.
6. Bound request sizes at or below `MAX_REQUEST_BYTES`; align gateway timeouts with
   multi-call modelling operations. Do not buffer or strip MCP event-stream responses.
7. Allow outbound HTTPS only to configured CKM, terminology and approved identity endpoints.
8. Mount and back up the models volume. Enable model writes only for an appropriately
   restricted service deployment. One API key represents one service principal and can
   access all projects in that deployment; per-user/project RBAC is not implemented.
9. Run the independent MCP smoke tests, then the Microsoft tenant acceptance scenarios.

Native `oidc` mode validates issuer discovery, signatures, API audience, time claims,
scopes, roles and signing-key rotation. See [OIDC configuration and migration](OIDC.md)
for tenant namespaces, separate Git remotes and independent live acceptance.
An authenticating gateway may protect the API-key endpoint, but must keep its upstream
key secret and strip incoming client keys. This does not make the app a native OAuth server.

## Data, backup and restore

Compose mounts `models` at `/data/models`. With the filesystem provider, each project is an atomic JSON snapshot
containing current logical artefacts and append-only revision records. This simplifies
single-node consistency; projects are bounded to 32 MiB including history. Filesystem
permissions protect the storage from other operating-system users. Snapshot writes
use locks, temporary files and rename. Network filesystems need independently verified
flock/atomic-rename semantics. Multi-node writes and disaster recovery are not verified.

The Git provider stores plain files as commits in `/data/models/git/objects.git`; optional SSH credentials are separate read-only mounts. See [Git backup and migration](MODEL_REPOSITORY.md#backup-and-migration). Changing provider does not migrate snapshots.

Back up the mounted directory consistently while writes are paused or the app is stopped.
Restore into a new volume, preserve ownership for `www-data`, start a separate stack,
and read projects and historical revisions before switching traffic. Do not use
`docker compose down -v` on a volume whose models must be retained.

`docker compose down` stops this stack and retains the named volume. FPM receives
SIGQUIT for graceful shutdown. Discovery and sessions are transient under `/tmp`;
a restart invalidates sessions and clients must initialise again.

## Health and dependency failures

`/health` reports process liveness. `/ready` constructs the MCP registry and reads
bundled terminology. It does not call CKM, terminology, Microsoft or a CDR. A failed
CKM operation therefore returns an error while local guidance remains usable.
FHIR failures return `NOT_EXECUTED` with `valid: null`, never successful validation.

## Corporate networks

Guzzle uses `HTTPS_PROXY` and `NO_PROXY`; `HTTP_PROXY` is a runtime proxy convention,
but external configured endpoints must use HTTPS. Mount a CA bundle and set
`HTTP_CA_BUNDLE` when an enterprise CA is required. TLS verification cannot be disabled.
Canonical terminology URLs are identifiers sent as operation parameters, never arbitrary
URLs fetched by the server. Only administrator-configured origins are contacted;
redirects are disabled. Restrict deployment configuration access and enforce egress rules.


## Managed server delivery

The configured deployment uses `https://openehr-modelling.sandbox.hygeoniq.com/mcp`, with Nginx terminating TLS and forwarding to loopback port 8343. The gateway configuration is `deploy/nginx-vps.conf`. State lives under `/opt/openehr-modelling-assistant`; `config/runtime.env` is secret-managed and is not part of release archives. The named Compose models volume persists across revisions.

Forward the root path to the application too: its landing page includes the browser-chat link. When upgrading an older gateway, remove any exact-root static response that overrides this page. Validate the updated gateway configuration before reloading Nginx.

GitHub validation runs on PRs and main pushes. The deployment workflow follows a successful main validation, transfers the exact Git archive, builds the locked application, waits for health, then runs an authenticated protocol smoke test against the public TLS endpoint. Deployment failure attempts to restore the previous source/image build without removing model data. GitHub requires MODELLING_VPS_SSH_KEY and MODELLING_VPS_KNOWN_HOSTS; the workflow never accepts an unverified SSH host key. Record the full deployed SHA and run `scripts/watch-ci.sh <sha>` after a push, including downstream workflows.

## Development server with Codex

Development URL: `https://dev-openehr-modelling.sandbox.hygeoniq.com/`; MCP endpoint: `/mcp`. The development LAN address is `192.168.178.20`. A client hosts entry can map the hostname to that address when local DNS does not. HTTPS uses the development certificate authority, which each connecting machine must trust. Never disable certificate verification. The root page describes the service; use an MCP client for modelling conversations.

The development instance has its own API key, model volume and Git history. Its shared authoring connection uses a private model-content Git remote with a scoped SSH deploy key; a separate local Git cache from the initial offline test is retained. External terminology is deliberately unconfigured, demonstrating that it is optional. The server deployment continues to use its existing filesystem model volume. These are separate datasets; switching provider is not an implicit migration.

The external mode-600 configuration is `/opt/hygeoniq/projects/openehr-modelling-assistant/config/runtime.env`. It sets the development hostname, `AUTH_MODE=api_key`, `MODEL_REPOSITORY_PROVIDER=git`, write enablement, optional Git remote/layout settings and empty terminology settings. The checked-in overlay provides the existing Traefik network and HTTPS route:

```sh
export MODELLING_ENV_FILE=/absolute/private/path/runtime.env
docker compose --env-file "$MODELLING_ENV_FILE" -p openehr-modelling-dev \
  -f docker-compose.yml -f deploy/compose.dev-host.yml up -d --build --wait
```

This overlay expects the `hygeoniq-proxy` external Docker network, a TLS-configured Traefik and the documented hostname; adapt these deployment-specific settings for another server. Keep the published port on loopback and allow only the intended LAN/clients through the gateway. Runtime secrets are excluded from Git.

Run `scripts/mcp-smoke.py --url https://dev-openehr-modelling.sandbox.hygeoniq.com/mcp --writes --without-terminology` with the dev key in `AUTH_API_KEY`. This tests authenticated discovery, persistence, history, conflict detection and absent terminology. Codex connection instructions are in [MCP clients](MCP_CLIENTS.md).

For the configured private model remote, also supply `MODEL_GIT_KEY_HOST_PATH` and `MODEL_GIT_HOSTS_HOST_PATH`, then append `-f deploy/compose.git-secrets.example.yml` before `up`. The external runtime configuration selects `/data/models/designer`, content path `local` and layout `flat`. The generic command above is sufficient for local Git or anonymous HTTPS; SSH requires the credential mounts.

## Optional browser chat

See [browser chat deployment](BROWSER_CHAT.md#deployment) for the workspace identity, personal provider connections, private conversation storage, environment variables and browser acceptance tests. Default deployments keep chat disabled until those dependencies are configured. Enabling it does not change MCP API-key authentication or require a terminology server. Apply the upload route in `deploy/nginx-vps.conf` when upgrading the managed gateway: it allows 10 MiB only for chat attachment uploads, retaining the ordinary 2 MiB request limit elsewhere.

File uploads have a two-minute request deadline. The Nginx upload route streams the body to the chat service and allows 120-second body/send timeouts. With Traefik, set `entryPoints.websecure.transport.respondingTimeouts.readTimeout: 120s` in the gateway's static configuration and restart the gateway after validation; its default 60-second read timeout otherwise cuts off slower transfers first. This setting applies to the whole HTTPS entrypoint.

For hosted model review workflows, use `MODEL_REPOSITORY_PROVIDER=github` or `gitlab` with the existing Git remote/cache/key settings and a privately injected `MODEL_HOSTED_TOKEN`. Set `MODEL_GIT_REVIEW_TARGET` separately from the working branch. Run the [hosted acceptance harness](HOSTED_REPOSITORIES.md#repeatable-verification) against a disposable synthetic branch before enabling repository writes for users. Neither a terminology server nor a CDR is required.

SharePoint is an alternative model repository with outbound Graph/OAuth access and no inbound callback. Provision its dedicated index and snapshot folder, set the documented identifiers and private credentials, run read-only acceptance, then synthetic write acceptance before enabling users. [SharePoint deployment](SHAREPOINT_REPOSITORY.md) includes Selected permissions, tenant mappings, download-host restrictions and backup/migration steps. CI exercises the production image against isolated HTTPS fixtures without account secrets.

Terminology integrations remain optional in every environment. CI runs `scripts/test-terminology-container.sh` against an isolated authenticated HTTPS fixture using the production image; no external clinical terminology licence or credential is required. Live provider acceptance is separate and read-only, using [the terminology harness](TERMINOLOGY.md#repeatable-verification). Server advertisement, dataset access and support for searchable resource endpoints are recorded independently.

Terminology binding plans deploy with the core service and require no engine, external terminology or model-provider credential for explicit XML inspection and offline catalogue proposals. Run the independent MCP smoke client with `--writes --without-terminology` against an isolated repository to verify persistence and stale-evidence handling; live writes create synthetic test artefacts. Native binding application remains an engine integration.

## Human review workspace

Follow [review deployment](REVIEW_DEPLOYMENT.md) to enable the OIDC review workspace, dedicated browser/core assertion keys and persistent governance volume. It supports development, staging and production without an LLM account or terminology server. The default browser image target is `reviews`; opt in to `MODELLING_BROWSER_TARGET=chat` before enabling conversational chat. Preserve the governance volume during upgrades and back it up independently of model repository snapshots. Live clinical approval remains blocked until qualified validation is implemented; fixtures do not override that gate.

## PostgreSQL and optional retrieval cache

See [PostgreSQL and cache deployment](POSTGRES_AND_CACHE.md) for the private service stack, restricted database role, migration preserving audit hashes, immutable-revision cache keys, outage fallback and backup/recovery procedure. `GOVERNANCE_DATABASE_PATH` is used only with the legacy SQLite driver. Authorization and clinical decisions always use authoritative state.

Enable the optional native Java validation/compiler sidecar with `deploy/compose.engine.yml` and a private service-key file. It shares application loopback, exposes no host port, and runs bounded disposable workers. [Configuration, limits and verification](OPT_COMPILATION.md).

For protected manual imports, enable model writes and the audit ledger. PostgreSQL is the recommended backend. No ledger migration is required for the new import stream types; historical events are unchanged. Confirm request-size limits for base64 payloads and back up both original storage and ledger. [Import setup and verification](MODEL_IMPORTS.md).
