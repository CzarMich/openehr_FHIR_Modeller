# Native OIDC authentication

For the end-to-end IdP provisioning, API permission, project access and browser review role setup, see [OIDC authorization and browser review roles](IDENTITY_AND_ACCESS.md).

The HTTP MCP service accepts signed access tokens from a configured OIDC issuer. Identity verification is a transport boundary, independent of modelling services and model providers. Local process authentication and deployment API keys remain available. Browser chat has a separate interactive login and, by default, a shared service key; enabling native OIDC does not silently migrate that client.

## Trust and configuration

Set `AUTH_MODE=oidc`, an exact HTTPS `OIDC_ISSUER`, and the API's `OIDC_AUDIENCE`. Configure an API audience distinct from browser login clients. The verifier discovers `/.well-known/openid-configuration` beneath the configured issuer and requires its `issuer` to match exactly. A discovered `jwks_uri` must be HTTPS on the same host and port. A separately trusted key host can be explicitly pinned with `OIDC_JWKS_URI`. Token headers never select an issuer or a key URL. Discovery and key requests verify TLS, reject redirects and cap documents at 64 KiB. Private certificate authorities use `HTTP_CA_BUNDLE`; include the public roots needed by other configured HTTPS integrations in that bundle.

The supported signing profile is RS256 with RSA keys of 2048–8192 bits. Enforce this profile on the issuer. The maintained `firebase/php-jwt` dependency verifies signatures, expiry and not-before; the adapter additionally checks issuer, API audience, subject, issued-at, maximum token age, optional allowed client IDs, scopes, roles and tenant claims. Missing required claims fail closed. HS256, unsigned tokens, duplicate matching keys, encryption keys and token-supplied key locations are rejected. Signing keys and discovery metadata are cached for five minutes. Unknown key IDs can trigger a refresh at most once per 30 seconds per deployment cache. Rotate signing keys with distinct key IDs and an overlap period. Expiry is rechecked on every authentication, including repeated uses of one verifier instance.

```dotenv
AUTH_MODE=oidc
OIDC_ISSUER=https://identity.example.org/realms/organisation
OIDC_AUDIENCE=openehr-modelling-api
OIDC_JWKS_URI=
OIDC_REQUIRED_SCOPES=modelling.read
OIDC_ALLOWED_CLIENT_IDS=registered-agent-client
OIDC_ROLES_CLAIM=realm_access.roles
OIDC_REQUIRED_ROLES=
OIDC_WRITE_ROLES=modeller,administrator
OIDC_TENANT_CLAIM=
OIDC_ALLOWED_TENANTS=
OIDC_TENANT_GIT_REMOTES={}
OIDC_CLOCK_SKEW=60
OIDC_MAX_TOKEN_AGE=7200
MODEL_REPOSITORY_WRITE_ENABLED=true
```

The audience is the resource/API audience, not an arbitrary client ID copied from a login screen. Clients acquire tokens through their registered identity-provider flow and send `Authorization: Bearer <access-token>`. Tokens never belong in URLs, modelling arguments, Git or logs. Automatic OAuth client registration and MCP protected-resource discovery are separate capabilities; preconfigure the issuer/client connection for this implementation. OIDC requires HTTP; a trusted stdio process uses local authentication instead.

## Microsoft Entra configuration

Use a tenant-specific issuer, for example `https://login.microsoftonline.com/<tenant-id>/v2.0`, and the registered API's expected audience. The API registration determines the access-token version and audience; do not mix a v1 issuer with v2 metadata. Configure delegated permissions such as `modelling.read` and, for editing, `modelling.write`. Entra's `scp` claim is accepted alongside the standard configured-provider `scope` claim. Application roles use `roles`; application-only tokens can require a configured read role with `OIDC_REQUIRED_SCOPES` empty and `OIDC_REQUIRED_ROLES` set. `OIDC_ALLOWED_CLIENT_IDS` checks `azp` or `appid`. Use `OIDC_TENANT_CLAIM=tid` with an explicit allowed-tenant list where appropriate.

This is a standards-based configuration profile, not a live Entra tenant acceptance claim. Signed fixture tests cover Entra-style claims. Live acceptance uses the available identity provider.

## Authorization and storage boundaries

Every authenticated caller must satisfy required scopes/roles and allowed client/tenant checks. Draft writes additionally require deployment write enablement and either the `modelling.write` scope or a configured write role. A reader token cannot write merely because deployment writes are enabled. Set `PROJECT_RBAC_ENABLED=true` to additionally require verified `project:<id>:read` or `project:<id>:write` scopes at the shared repository boundary; write grants include read access, `projects:create` allows project creation, and the explicit `projects:admin` scope grants project administration. Generic OIDC roles do not bypass project grants. This mode requires OIDC. Configure `CHAT_REVIEW_PROJECT_SCOPES_CLAIM` for the browser review assertion to carry the same signed grants. The identity provider remains responsible for mapping trusted team membership to project scopes; the application does not treat repository metadata as authorization.

Tenant names are taken only from verified claims. With no tenant-claim setting, the issuer is one tenant. The storage namespace is SHA-256 of the UTF-8 JSON array `[issuer, tenant]`, without escaped slashes; MCP sessions are isolated by verified issuer, tenant and subject. Filesystem and local Git use `<MODEL_REPOSITORY_PATH>/tenants/<namespace>`. Changing issuer or tenant selection creates a different namespace. Existing API-key data remains at its original location; enabling OIDC does not automatically expose or move it. Back up and explicitly migrate selected data when changing authentication modes.

For hosted Git, configure `OIDC_TENANT_GIT_REMOTES` as a JSON object mapping tenant namespace hashes to distinct, administrator-controlled remote URLs. Each tenant also has a private local Git cache. Unmapped tenants fail closed. Reusing the same configured remote for different tenants is rejected: a Git repository is the remote trust boundary, not a folder. Existing Git branch, layout, content-root and SSH verification settings still apply. Tenant claims cannot supply URLs or credentials. Readiness constructs no authenticated remote connection.

Bearer tokens can be delegated to agents. Even a signed password/MFA `amr` claim does not prove a human is approving the current model. Native bearer principals therefore never assert human approval. Governance must obtain a separate authenticated interactive approval bound to the exact revision and an authorized human actor.

## Verification

Run the PHP suite, including `OidcAuthenticationTest`, inside the development container. Tests cover forgery, algorithms, malformed claims, time boundaries, discovery trust, bounded key rotation, remote failures, write roles, issuer/tenant isolation, separate real Git remotes and stale revision conflicts.

Run `scripts/test-oidc-container.sh` for the CI acceptance path. It creates an isolated HTTPS issuer with disposable signing keys and a trusted test certificate, starts production application/ingress images, exercises the same HTTP authorization scenarios, and removes its containers, volumes and temporary credentials. Fixture evidence is explicitly marked separately from external identity-provider acceptance. TLS verification remains enabled.

For live acceptance, provision a disposable test deployment and three short-lived tokens: a modeller, a reader, and a modeller in another signed tenant. Put them in protected environment variables `OIDC_SMOKE_WRITER_TOKEN`, `OIDC_SMOKE_READER_TOKEN`, and `OIDC_SMOKE_OTHER_TENANT_TOKEN`, then run:

```sh
python3 scripts/oidc-smoke.py --url https://test-modelling.example.org/mcp \
  --allow-test-writes --evidence /tmp/oidc-acceptance.json
```

This creates only synthetic projects in the isolated deployment. It checks real discovery/JWKS, MCP initialization, authorized writes, rejected reader writes, revision conflicts, cross-tenant reads, cross-principal sessions and invalid credentials. Remove disposable clients, tokens and test storage afterward. The recorded [live evidence](evidence/oidc-live-acceptance.json) excludes credentials and model content. Current normal development/server clients keep their existing API-key configuration until intentionally migrated.

Sources: [OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html), [JWT security best practices](https://www.rfc-editor.org/rfc/rfc8725), [Microsoft access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens), and [the JWT verifier](https://github.com/googleapis/php-jwt).
