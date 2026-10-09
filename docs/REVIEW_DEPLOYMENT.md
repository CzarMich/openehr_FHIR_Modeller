# Deploying the human review workspace

For the relationship between IdP invitations, signed claims, API scopes, project grants and browser review permissions, see [OIDC authorization and browser review roles](IDENTITY_AND_ACCESS.md).

The review workspace is an optional browser adapter to the provider-neutral modelling core. It supports organisation OIDC and optional native local accounts. It can run without conversational chat, an LLM account, a CDR or an external terminology server. Models still require qualified validation before clinical approval or publication.

## Environments and storage

For a local container contract check, run `scripts/test-governance-container.sh`. It uses isolated synthetic identities, fixture keys, model volumes and an actual core container. Its keys are never deployment credentials.

For development, staging and production, use authenticated HTTPS, persistent model storage and a separate persistent governance ledger. The root Compose configuration mounts `governance:/data/governance`. The browser needs no ledger mount. Retain that volume across upgrades. Use one authoritative core/ledger instance for each repository governance namespace; separate development and server deployments do not automatically share approval history.

The default browser image target is `reviews`; it contains OIDC and review functionality without a model-provider executable. Conversational chat requires `MODELLING_BROWSER_TARGET=chat` and the separately configured provider credential. The existing development chat override explicitly selects that target. If enabling chat on an older deployment, select the target before rebuilding; startup fails clearly when chat is enabled in a review-only image.

## Core variables

| Variable | Default | Purpose |
|---|---|---|
| `GOVERNANCE_ENABLED` | `false` | Enable persisted governance operations |
| `GOVERNANCE_DATABASE_PATH` | `/data/governance/audit.sqlite` | Separate persistent SQLite ledger; never place in a shared Git checkout |
| `GOVERNANCE_BROWSER_ORIGIN` | empty | Exact public browser origin, without a path or trailing slash |
| `GOVERNANCE_OIDC_ISSUER` | empty | Exact verified browser identity issuer |
| `GOVERNANCE_LOCAL_IDENTITY_ISSUER` | empty | Exact local issuer accepted only for `interactive_local` assertions |
| `GOVERNANCE_BROWSER_KEYS` | `{}` | JSON object of accepted key identifiers to dedicated random signing keys; up to three keys for rotation |
| `GOVERNANCE_SESSION_MAX_AGE` | `900` | Maximum sign-in age for decisions in seconds, 60–3600 |
| `GOVERNANCE_BROWSER_SESSION_MAX_AGE` | `3600` | Maximum sign-in age for reading reviews; at least the decision limit and at most the browser session lifetime |
| `GOVERNANCE_ROLE_MAP` | role mapping in `.env.example` | Domain role to accepted signed ID-token role values |
| `MODEL_REPOSITORY_WRITE_ENABLED` | `false` | Required for lifecycle changes as well as model draft writes |

Generate a separate random key with `openssl rand -hex 32` into a protected credential file or secret manager. Configure that value as the active key in the core and browser; never paste it into a model, MCP request, Git file, browser page or shared log. Accepted key values are 64–128 lowercase hex characters. An example structure is `{"active":"<dedicated-random-key>"}`; the placeholder is not a valid key.

Defaults map `modeller`, `reviewer`, `approver` and `publisher` to `modelling-modeller`, `modelling-reviewer`, `modelling-approver` and `modelling-publisher`. There is no implicit clinical permission for an administrator. Assign real clinical roles according to organisational policy. The software must not grant an AI service account human approval authority.

## Browser variables

Existing `CHAT_PUBLIC_URL`, `CHAT_OIDC_ISSUER`, `CHAT_OIDC_CLIENT_ID`, `CHAT_OIDC_CLIENT_SECRET`, optional `CHAT_ALLOWED_GROUPS` and `CHAT_MCP_URL` configure organisation sign-in and the core location. Native accounts are separately enabled with `CHAT_LOCAL_IDENTITY_ENABLED=true`; configure `CHAT_LOCAL_IDENTITY_ISSUER` to the same exact value as the core's `GOVERNANCE_LOCAL_IDENTITY_ISSUER`, and set `CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY` to a dedicated 32-byte random key encoded as 64 lowercase hexadecimal characters. The review API uses the origin of `CHAT_MCP_URL`, and does not forward its normal MCP API key.

The first native owner is created without a shipped account or password. Follow [owner setup for Linux and Azure](#generate-the-one-time-owner-setup-token), then choose a username and password and enroll TOTP before using the workspace. No default username or password exists.

Invitations, password resets and account recovery produce one-time links for delivery through an approved operator channel; no email is sent. Account recovery replaces the password and TOTP seed and requires MFA enrollment again. TOTP recovery codes are shown once. Local account data lives under `CHAT_DATA_DIR/identity`, separate from conversations; MFA seeds are AES-GCM encrypted with the external encryption key, and the key must be backed up separately. This JSON backend is designed for one chat instance on one host with persistent local storage. Do not run multiple chat replicas against it; use OIDC or a future shared transactional identity backend for horizontally scaled deployments. Back up and restore the identity directory and encryption key together, and test recovery in isolation.

| Variable | Default | Purpose |
|---|---|---|
| `CHAT_REVIEW_ENABLED` | `false` | Enable `/chat/reviews` and its authenticated backend |
| `CHAT_LOCAL_IDENTITY_ENABLED` | `false` | Enable local usernames, passwords and required TOTP MFA alongside or instead of OIDC |
| `CHAT_SIGNUP_ENABLED` | `true` | Allow native signup after owner MFA setup; owner may close registration in Accounts |
| `CHAT_LOCAL_IDENTITY_ISSUER` | `<browser-origin>/identity/local` | Stable local identity issuer; must match core governance configuration |
| `CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY` | empty | Dedicated 32-byte hex key for encrypted local MFA seeds; required when local identity is enabled |
| `CHAT_REVIEW_SIGNING_KEY` | empty | The dedicated active review key, kept server-side |
| `CHAT_REVIEW_KEY_ID` | `active` | Identifier matching `GOVERNANCE_BROWSER_KEYS` |
| `CHAT_REVIEW_ROLES_CLAIM` | `roles` | Dot-separated signed ID-token role claim, for example `realm_access.roles` |
| `CHAT_REVIEW_TENANT_CLAIM` | empty | Signed tenant claim when using native core OIDC tenant isolation |
| `CHAT_REVIEW_PROJECT_SCOPES_CLAIM` | `project_scopes` | Dot-separated signed ID-token claim containing bounded per-project read/write grants |
| `CHAT_REVIEW_SESSION_MAX_AGE` | `900` | Browser-side maximum sign-in age; match the core policy |
| `CHAT_ENABLED` | `false` | Conversational chat; may remain false for human review |
| `MODELLING_BROWSER_TARGET` | `reviews` | Compose build target; use `chat` only when its provider adapter is needed |

### Generate the one-time owner setup token

An operator runs the bootstrap script in the browser container for the intended
environment. Enable `CHAT_LOCAL_IDENTITY_ENABLED=true`, configure the dedicated
`CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY` and retain a stable
`CHAT_LOCAL_IDENTITY_ISSUER`. Keep keys in protected deployment configuration.
Persist `CHAT_DATA_DIR` (default `/data/chat`) across container replacements, with
write access for the browser's UID1000 user. The native identity store requires
private file permissions, exclusive file creation and atomic rename; verify these
on the chosen storage. Back up the identity directory and encryption key together.

Use one browser instance with this JSON identity backend. On managed platforms,
keep at most one active instance/revision using that identity directory; prevent
overlap during updates. Multiple replicas require an identity design suited to
shared transactional storage or organisation OIDC. These are operator setup
instructions for an already deployed browser service, not Azure provisioning
templates or an automated Azure delivery workflow.

All server, container, resource and browser names below are placeholders. Replace
`Server_vps` with your own verified SSH alias or `operator@server.example.com`,
`chat-container` with your running browser container, and the Azure placeholders
with resources in the intended subscription. Dev and production have separate
identity storage and setup tokens.

#### Linux server with Docker

From the operator's Linux workstation, generate and retrieve the token into a
private file outside the checkout:

```bash
ssh Server_vps 'docker exec chat-container node /app/chat/src/bootstrap-identity.mjs'
install -d -m 700 "$HOME/.config/modelling-assistant"
(umask 077; ssh Server_vps 'docker exec chat-container cat /data/chat/owner-bootstrap.token' > "$HOME/.config/modelling-assistant/bootstrap-token")
chmod 600 "$HOME/.config/modelling-assistant/bootstrap-token"
```

The SSH account needs permission to execute commands in the browser container.
Use the configured operator key and verified SSH host key. If working directly
on the Linux server with the correct Compose project and environment selected:

```bash
docker compose exec -T chat node src/bootstrap-identity.mjs
```

Retrieve the token privately from `/data/chat/owner-bootstrap.token` in that
container. Adapt the retrieval path if `CHAT_DATA_DIR` is configured differently.

#### Azure Container Apps

Use an Azure identity authorized to open the application's container console.
In the portal, open **Monitoring → Console**, select the running browser revision,
replica and container, then choose `sh`. Alternatively, from a workstation with
Azure CLI:

```bash
az login
az account set --subscription "<subscription-id>"
az containerapp exec \
  --resource-group "<resource-group>" \
  --name "<browser-container-app>" \
  --container "<chat-container>" \
  --command /bin/sh
```

Specify `--revision` and `--replica` when needed to select the instance serving
the browser. Inside the application container's console:

```bash
node /app/chat/src/bootstrap-identity.mjs
cat "${CHAT_DATA_DIR:-/data/chat}/owner-bootstrap.token"
```

Copy the token directly into the setup form through the private operator console;
a local download is optional. Ensure the data directory uses persistent storage,
not the container's ephemeral filesystem. Validate the storage semantics and
single-instance constraints above before enabling native identity.
See Microsoft's [container console instructions](https://learn.microsoft.com/en-us/azure/container-apps/container-console)
and [storage mounts](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts).

#### Azure Kubernetes Service (AKS)

With Azure CLI and `kubectl` installed, authenticate to the intended cluster and
select the running browser pod. The operator needs Kubernetes permission to
execute commands in that pod:

```bash
az login
az account set --subscription "<subscription-id>"
az aks get-credentials --resource-group "<resource-group>" --name "<cluster-name>"
kubectl -n "<namespace>" get pods
kubectl -n "<namespace>" exec "<browser-pod>" -c "<chat-container>" -- node /app/chat/src/bootstrap-identity.mjs
kubectl -n "<namespace>" exec "<browser-pod>" -c "<chat-container>" -- cat /data/chat/owner-bootstrap.token
```

Use the same pod for generation and retrieval. Mount persistent storage at the
configured data directory and keep one browser pod using it, including during
rollouts. See Microsoft's [AKS credentials reference](https://learn.microsoft.com/en-us/cli/azure/aks#az-aks-get-credentials).

#### Azure App Service (Linux custom container)

An App Service custom Linux image needs SSH support configured before its
container console works. The repository's browser image does not include an SSH
server; these commands require an image adapted for App Service's documented SSH
contract. Do not assume they work with the unmodified image.

Once configured, open the browser container's SSH console in the portal, or run:

```bash
az login
az account set --subscription "<subscription-id>"
az webapp ssh --resource-group "<resource-group>" --name "<browser-web-app>"
```

If the SSH console runs as root, first switch to the image's browser user with
`su -s /bin/sh node`, preserving the configured environment. Run bootstrap as the
same UID1000 user as the browser process so private identity files remain readable.
Then run the same `node` and `cat` commands shown for Container Apps. Provide persistent storage for `CHAT_DATA_DIR`; keep one instance
and prevent deployment slots from concurrently sharing that identity directory.
See Microsoft's [App Service container SSH instructions](https://learn.microsoft.com/en-us/azure/app-service/configure-linux-open-ssh-session).

#### Complete setup, expiry and renewal

Open `https://<browser-host>/chat/` and choose **Set up the platform owner**.
Enter the retrieved token in **One-time setup token**, choose a username and a
password of at least 12 characters, enroll an authenticator and save the recovery
codes. Successful account creation consumes the token and deletes the server
file; delete any retrieved local copy after use. Keep tokens out of Git, CI logs,
shared terminals and model artefacts.

The script generates 32 cryptographically random bytes using Node's
`crypto.randomBytes(32)`, encodes them as Base64url and adds `boot_`. It registers
the token's SHA-256 digest and a 15-minute expiry in the identity store, audits
`OWNER_BOOTSTRAP_CREATED`, and writes the token file with mode `0600`. Its normal
output contains only the event and file path. An independently invented token
will not work because its digest has not been registered.

If the token file already exists, retrieve it. If the token has expired or was
rejected, replace it in the same browser container:

```bash
# Linux workstation
ssh Server_vps 'docker exec chat-container node /app/chat/src/bootstrap-identity.mjs --rotate'

# Inside an Azure application container console
node /app/chat/src/bootstrap-identity.mjs --rotate
```

For Compose or AKS, append `--rotate` to the bootstrap script command above.
Retrieve the replacement using the same method. Rotation immediately invalidates
the earlier token and starts a fresh 15-minute window. Once an owner account
exists, bootstrap is permanently closed, including with `--rotate`. Use
[owner recovery](#owner-recovery-without-email) for an existing account.

### Managed VPS configuration

For deployments without an organisation IdP, use built-in accounts instead. Keep
the browser variables in the protected `chat.env` selected by
`MODELLING_CHAT_ENV_FILE`, and set `MODELLING_BROWSER_TARGET=chat` for browser AI providers:

```dotenv
CHAT_ENABLED=true
CHAT_LOCAL_IDENTITY_ENABLED=true
CHAT_LOCAL_IDENTITY_ISSUER=https://<public-host>/identity/local
CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY=<dedicated-32-byte-hex-key>
CHAT_PROVIDER_ENCRYPTION_KEY=<different-dedicated-32-byte-hex-key>
CHAT_PUBLIC_URL=https://<public-host>
CHAT_OIDC_ISSUER=
CHAT_OIDC_CLIENT_ID=
CHAT_OIDC_CLIENT_SECRET=
CHAT_MCP_URL=http://ingress:8343/mcp
CHAT_MCP_API_KEY=<existing-core-api-key>
```

Use the native owner bootstrap described above, then complete account creation and
MFA in the UI. Users connect Codex, Claude or Copilot Studio through **My AI connections**. Native
human review additionally needs `CHAT_REVIEW_ENABLED=true`, matching review signing
keys and `GOVERNANCE_LOCAL_IDENTITY_ISSUER` in the core. The optional Copilot Studio
walkthrough lives in **Help**; a native administrator can copy connection details
there. No OIDC client configuration is required for this setup.

The VPS uses `/opt/openehr-modelling-assistant/config/runtime.env` as Compose's project environment. Keep browser-only secrets in a separate mode-`600` file such as `/opt/openehr-modelling-assistant/config/chat.env`, then set this path in `runtime.env`:

```dotenv
MODELLING_BROWSER_TARGET=reviews
MODELLING_CHAT_ENV_FILE=/opt/openehr-modelling-assistant/config/chat.env
GOVERNANCE_ENABLED=true
GOVERNANCE_BROWSER_ORIGIN=https://openehr-modelling.sandbox.hygeoniq.com
GOVERNANCE_OIDC_ISSUER=https://identity.example.org/realms/organisation
GOVERNANCE_BROWSER_KEYS='{"active":"<dedicated-random-key>"}'
```

The protected `chat.env` needs the browser OIDC client and review settings; it does **not** need a Codex or model-provider credential:

```dotenv
CHAT_ENABLED=false
CHAT_REVIEW_ENABLED=true
CHAT_PUBLIC_URL=https://openehr-modelling.sandbox.hygeoniq.com
CHAT_OIDC_ISSUER=https://identity.example.org/realms/organisation
CHAT_OIDC_CLIENT_ID=openehr-modelling-browser
CHAT_OIDC_CLIENT_SECRET=<secret-manager-value>
CHAT_REVIEW_SIGNING_KEY=<same-dedicated-random-key-as-GOVERNANCE_BROWSER_KEYS>
CHAT_REVIEW_KEY_ID=active
CHAT_REVIEW_ROLES_CLAIM=roles
CHAT_REVIEW_TENANT_CLAIM=
CHAT_REVIEW_SESSION_MAX_AGE=900
CHAT_MCP_URL=http://ingress:8343/mcp
```

Register `https://openehr-modelling.sandbox.hygeoniq.com/chat/auth/callback` as the browser OIDC redirect URI and issue the configured governance roles in the signed ID token. If the Models tab must read MCP project data, also set the private `CHAT_MCP_API_KEY` in `chat.env`; browser login and human review use the separate request-bound review assertion, not that service key. Do not set `CHAT_ENABLED=true` unless conversational chat is intended.

After provisioning the external OIDC client and secret, recreate the browser service from the active release directory with the deployment account. Verify `GET /chat/api/session` reports `reviewEnabled: true` and `enabled: false`, then visit `/chat/` and test sign-in. The response `Browser review is disabled...` means the chat env file is missing/not selected or `CHAT_REVIEW_ENABLED` is not true. An OIDC redirect/client error instead means the browser issuer, client credentials, callback URI or IdP registration needs correction. Never commit either configuration file or its secrets.

Configure the identity provider's confidential browser client with redirect URI `<browser-origin>/chat/auth/callback`, authorization-code flow and PKCE. Ensure selected role and project-scope claims are included in the **signed ID token**, not only in the access token or user-info response. Project grants use `project:<id>:read` or `project:<id>:write`; wildcard grants are rejected. For Keycloak, a protocol mapper/client scope can expose assigned roles and project grants; for Entra or another OIDC provider, use its equivalent claims. Keep engineering/admin permissions separate from clinical approver assignments.

In core `AUTH_MODE=oidc`, the browser issuer must match `OIDC_ISSUER`; the tenant claim and allowed tenants must match the core policy. Signed browser identity resolves to the same subject/tenant namespace as native bearer authentication. Existing per-tenant Git/SharePoint mappings continue to apply. API-key/local deployments use one shared repository namespace; browser users still have distinct authenticated actor identities.

## Upgrade, rotation and backup

Build and start the configured containers, then inspect `/ready`, `/chat/api/session` and the review page through the HTTPS gateway. A healthy container proves startup, not that an identity provider has supplied appropriate clinical roles. A user with the configured role must verify actual interactive sign-in. Synthetic fixtures are not live tenant acceptance evidence.

For signing-key rotation, first add the new key identifier/value to the core's accepted map. Switch the browser to that identifier/value, then remove the previous key after its short-lived assertions have expired. Restart the browser to invalidate in-memory sessions when role assignments or identity policy change. No approval key is available to the model worker.

Back up model storage and the governance ledger separately. Use SQLite's [consistent online backup](https://www.sqlite.org/backup.html) or [VACUUM INTO procedure](https://www.sqlite.org/lang_vacuum.html), or stop the core before copying the database and its journal state. Do not copy only an active `.sqlite` file while ignoring its WAL. Preserve file permissions and encryption/access policy in backup storage. Restore into an isolated deployment first, verify audit history and hash chains, compare model revisions and keep publication disabled until required qualification checks pass. A ledger backup is not an external signed audit attestation.

The current qualified-engine gap deliberately blocks real clinical approval/publication. The review workspace can record review findings and requests for changes while that gate remains open.

## One browser identity for chat and governance

Chat and model governance share the same authenticated browser session. The review header identifies the signed-in user. Reading reviews uses the browser-session age limit; submitting a decision uses the shorter decision freshness limit. A stale decision session can be refreshed through the existing sign-in flow without changing the selected account.

Assign the explicit `modelling-administrator` identity-provider role to a platform owner. The default role map grants this role modeller, reviewer, approver and publisher permissions. Custom `GOVERNANCE_ROLE_MAP` configurations must add their administrator claim explicitly. Include the assigned role in the signed ID-token claim selected by `CHAT_REVIEW_ROLES_CLAIM`. A username such as `admin`, or an unrelated identity-provider administration role, does not grant platform permissions by itself. Role changes take effect after the browser signs in again.

An authenticated account without a mapped governance role receives `403 GOVERNANCE_ROLE_REQUIRED`. Invalid or expired identity assertions receive `401 INTERACTIVE_REVIEW_AUTHENTICATION_REQUIRED`. This keeps permission problems distinct from authentication problems. Administrators use the same exact-revision, validation, independent-human and lifecycle checks as other reviewers; agent/API credentials cannot acquire human approval authority.

## PostgreSQL and optional retrieval cache

See [PostgreSQL and cache deployment](POSTGRES_AND_CACHE.md) for the private service stack, restricted database role, migration preserving audit hashes, immutable-revision cache keys, outage fallback and backup/recovery procedure. `GOVERNANCE_DATABASE_PATH` is used only with the legacy SQLite driver. Authorization and clinical decisions always use authoritative state.

The [unified browser workspace](BROWSER_WORKSPACE.md) provides Chat, Models and Governance in one window. Model browsing reads the configured filesystem, Git or SharePoint repository and carries the selected revision into chat.

### Owner recovery without email

The owner should use a saved recovery code from **Forgot password or locked out?**. If every factor has been lost, a trusted server operator can run `docker compose exec chat node src/bootstrap-identity.mjs --recover-owner`. This creates a single-use 15-minute link in `/data/chat/owner-recovery.url` (mode 0600), logs only its path, and audits `OWNER_RECOVERY_ISSUED` as `server_operator`. Retrieve that file through an approved private operator channel, open the link, choose a new password and enroll MFA again. Remove the file after use. Issuing another link invalidates the previous owner reset links. This command requires access to the server's identity storage and encryption key; it is never exposed as an HTTP or AI tool. It preserves the original owner ID and private workspace.
