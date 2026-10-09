# OIDC Authorization and Browser Review Roles

This guide configures an external OpenID Connect (OIDC) identity provider (IdP) for MCP access and browser review. For a workspace without an IdP, the application also supports [built-in accounts, owner bootstrap, invitations, passwords and MFA](REVIEW_DEPLOYMENT.md#browser-variables). Operators generate the one-time owner token using [Linux or Azure setup](REVIEW_DEPLOYMENT.md#generate-the-one-time-owner-setup-token). In the OIDC path, the IdP owns those functions. There is no default account; the username `admin` has no special meaning. Do not ship a reusable administrator password or treat an API key as a human identity.

The application consumes signed claims from the configured IdP and maps them to separate permissions. The main layers are:

| Layer | Credential and authority |
|---|---|
| MCP/API authentication | OIDC access token; validates issuer, API audience, signature, time, required scope/role and optional tenant/client restrictions |
| Model draft writes | Deployment writes must be enabled and the access token must contain `modelling.write` or a role in `OIDC_WRITE_ROLES` |
| Optional project RBAC | When `PROJECT_RBAC_ENABLED=true`, signed project scopes additionally limit repository reads and writes |
| Browser session | OIDC authorization-code flow with PKCE; creates an opaque browser session, not an MCP access token |
| Human governance | A short-lived request-bound assertion is minted by the browser backend from the verified signed ID-token identity and mapped governance roles |

An MCP bearer token or API key never becomes a human reviewer. Browser role assignment does not bypass exact-revision governance or the qualified-validation gate. In the current product, incomplete validation keeps approval/publication unavailable.

## Provisioning Users

1. Create or invite the person in the organisation's IdP. Add the person to the registered browser client and/or API client according to the intended access.
2. Assign only the necessary application roles and delegated scopes. Ensure the claims described below are emitted in the signed token that the relevant verifier reads.
3. Have the person sign in through the browser or acquire a token through the registered API client.
4. Remove or change assignments at the IdP when access changes. For the browser, the person must sign in again for changed role claims to take effect; existing sessions are bounded by their configured age and can be invalidated by restarting the browser service.

Invitation email, account verification, password policy/reset, MFA enrollment and account disablement are IdP functions. The application does not send invitation or password-reset emails. If the IdP cannot issue the required token claims, the user will not gain those application permissions merely by having an account.

Typical provider setup:

- **Keycloak:** define client roles for the governance values you use, assign them to users/groups, and add a protocol mapper/client scope that emits them in the signed ID token. Create/invite users through Keycloak's user administration and use its required-actions/email flow for verification or password setup.
- **Microsoft Entra ID:** define app roles on the API registration, assign users/groups to the enterprise application, and use Entra B2B invitation for external guests where applicable. Configure delegated API scopes separately from browser application roles.

Provider screens and exact invitation procedures vary by version and organisation. In all cases, confirm the resulting signed token claims rather than assuming an assignment was emitted.

## Configure the MCP/API Client

Set the core to verify access tokens from one exact HTTPS issuer and the application's API audience:

```dotenv
AUTH_MODE=oidc
OIDC_ISSUER=https://identity.example.org/realms/organisation
OIDC_AUDIENCE=openehr-modelling-api
OIDC_REQUIRED_SCOPES=modelling.read
OIDC_ROLES_CLAIM=roles
OIDC_REQUIRED_ROLES=
OIDC_WRITE_ROLES=modelling-modeller,modelling-administrator
MODEL_REPOSITORY_WRITE_ENABLED=true
```

Register the API/resource in the IdP and define `modelling.read` and, when needed, `modelling.write`. API clients request an access token for `OIDC_AUDIENCE` and send it as `Authorization: Bearer <access-token>`. The client ID is not a replacement for the API audience. Native verification accepts RS256 keys from validated discovery/JWKS, or an administrator-pinned `OIDC_JWKS_URI`; see [OIDC trust and configuration](OIDC.md).

`OIDC_REQUIRED_SCOPES` and `OIDC_REQUIRED_ROLES` are admission requirements: the token must satisfy configured required claims to authenticate. `OIDC_WRITE_ROLES` controls draft-write permission after authentication. Values must match the signed access-token claims exactly. `OIDC_ROLES_CLAIM` selects the role claim and accepts a dotted path, for example `realm_access.roles`. Scope extraction accepts `scope` and the Entra `scp` claim.

With `AUTH_MODE=api_key`, a valid key identifies one deployment-wide service principal. It does not identify an invited human, carry per-user roles, or authorize human governance. Production HTTP must use an authenticated mode.

## Configure Browser Review

The browser uses a confidential OIDC client and authorization-code flow with PKCE. Configure its callback URI as `<browser-origin>/chat/auth/callback`, then configure the review backend and core with the same intended issuer and tenant policy:

```dotenv
CHAT_REVIEW_ENABLED=true
CHAT_ENABLED=false
CHAT_PUBLIC_URL=https://models.example.org
CHAT_OIDC_ISSUER=https://identity.example.org/realms/organisation
CHAT_OIDC_CLIENT_ID=openehr-modelling-browser
CHAT_OIDC_CLIENT_SECRET=<secret-manager value>
CHAT_REVIEW_ROLES_CLAIM=roles
CHAT_REVIEW_TENANT_CLAIM=
CHAT_REVIEW_SESSION_MAX_AGE=900

GOVERNANCE_ENABLED=true
GOVERNANCE_BROWSER_ORIGIN=https://models.example.org
GOVERNANCE_OIDC_ISSUER=https://identity.example.org/realms/organisation
GOVERNANCE_BROWSER_KEYS={"active":"<same dedicated random key in both services>"}
GOVERNANCE_ROLE_MAP={"modeller":["modelling-modeller","modelling-administrator"],"reviewer":["modelling-reviewer","modelling-administrator"],"approver":["modelling-approver","modelling-administrator"],"publisher":["modelling-publisher","modelling-administrator"]}
CHAT_REVIEW_SIGNING_KEY=<same dedicated random key in both services>
CHAT_REVIEW_KEY_ID=active
MODEL_REPOSITORY_WRITE_ENABLED=true
```

Keep client secrets and signing keys in a secret manager or mounted secret files; the placeholder values above are not credentials. The browser OIDC client must put the selected role claim in the **signed ID token**, not only in an access token or user-info response. `CHAT_REVIEW_ROLES_CLAIM` selects that claim; dotted paths such as `realm_access.roles` are supported. `CHAT_REVIEW_TENANT_CLAIM` selects a signed tenant claim where required. The core must accept the same issuer and tenant so browser and MCP identities resolve into the intended repository namespace.

The browser review assertion has its own key purpose. `CHAT_REVIEW_SIGNING_KEY` and the matching `GOVERNANCE_BROWSER_KEYS` entry must be the same random secret; they are not the IdP client secret, MCP API key, JWT signing key or model-provider credential. Rotation procedure is documented in [review deployment](REVIEW_DEPLOYMENT.md).

When conversational chat is enabled, the browser backend normally calls MCP using `CHAT_MCP_API_KEY`, which is one configured service principal. Browser OIDC sign-in does not by itself make those MCP calls use each person's access token. Human review is separate: only the short-lived, request-bound review assertion carries the verified browser identity and mapped governance roles. Never treat chat's service key as a human account or assign it reviewer/approver authority.

The default governance role map translates signed IdP role values to application roles:

| Signed IdP role value | Application role | Permitted lifecycle responsibility |
|---|---|---|
| `modelling-modeller` | `modeller` | Prepare drafts and request review |
| `modelling-reviewer` | `reviewer` | Record an independent review or request changes |
| `modelling-approver` | `approver` | Approve after required qualified validation |
| `modelling-publisher` | `publisher` | Publish/deprecate after required qualified validation |
| `modelling-administrator` | all four roles under the default map | Identity-provider/platform administration plus these mapped workflow roles |

The application administrator mapping does not create an account or invitation. It is only effective when the IdP actually issues the signed role. Because the default administrator mapping includes approver and publisher, assign `modelling-administrator` only to people intentionally trusted with those governance roles. For separation of duties, remove that broad mapping and assign reviewer, approver and publisher roles separately in a custom `GOVERNANCE_ROLE_MAP`. The lifecycle still requires an independent authenticated human; a person cannot approve their own authored revision.

No domain role by itself overrides incomplete validation. `modelling-administrator` is not a bypass around the governance state machine or release gate.

## Project Access

Project RBAC is optional and disabled by default. Enable it only after the IdP issues per-project authorization:

```dotenv
PROJECT_RBAC_ENABLED=true
```

The MCP access token's `scope` or Entra `scp` claim must contain one of:

- `project:<id>:read` to read the named project.
- `project:<id>:write` to read and write the named project.
- `projects:create` to create projects.
- `projects:admin` to administer projects across the tenant.

There are no wildcard project grants. A generic role such as `administrator` does not bypass project scopes. The browser review client separately reads a signed ID-token claim selected by `CHAT_REVIEW_PROJECT_SCOPES_CLAIM` (default `project_scopes`) and carries the validated grants in its short-lived assertion. Configure that claim as a string array using the same scope syntax. The IdP is the trusted source of user/team membership and must calculate these grants; the repository's editable project metadata is not an authorization source.

## Verification and Troubleshooting

Run the isolated, disposable-container checks before accepting a provider configuration:

```sh
scripts/test-oidc-container.sh
scripts/test-governance-container.sh
```

These exercise local signed fixtures, not a production IdP. Live acceptance requires a disposable HTTPS deployment and short-lived test accounts/tokens; follow [OIDC live acceptance](OIDC.md#verification) and keep credentials out of files, URLs, Git and logs.

Common outcomes:

| Result | Meaning and check |
|---|---|
| `401 AUTHENTICATION_REQUIRED` | Access token absent/invalid, issuer/audience/signature/time/client/tenant mismatch, or required claims missing |
| `403 WRITE_PERMISSION_REQUIRED` | Token authenticated, but model writes are disabled or the user lacks `modelling.write`/a configured write role |
| `403 PROJECT_PERMISSION_REQUIRED` | Project RBAC is enabled and no grant covers that project and operation |
| `403 GOVERNANCE_ROLE_REQUIRED` | Browser assertion is valid, but its signed ID-token role claim maps to no governance role |
| `403 GOVERNANCE_INDEPENDENT_HUMAN_REQUIRED` | Required reviewer/approver/publisher role is absent, or the actor is not independent/human |
| `403 GOVERNANCE_VALIDATION_REQUIRED` | Required qualified validation is incomplete; adding a role does not bypass this gate |

Native account administration, owner bootstrap, invitations, password reset, TOTP MFA and service-credential management are implemented independently of OIDC; see [native setup](REVIEW_DEPLOYMENT.md#browser-variables). There is no default user. Passkeys, mail delivery and a shared transactional identity backend are not implemented. OIDC users remain managed in their IdP.


## Native registration, owner permissions and recovery

After the first owner finishes authenticator setup, the sign-in page offers **Create an account**. The owner controls registration and delegates shared-provider/repository permissions in **Accounts**. New users start with private workspaces and must complete MFA. See [native accounts and shared connections](BROWSER_CHAT.md#native-accounts-and-shared-connections) for scope and recovery rules.

Native sign-in shows the number of failures remaining before lockout at five. Choose **Forgot password or locked out?** and enter a saved recovery code to set a new password and authenticator. If no code is available, contact an administrator for a one-time recovery link; no email is sent. Keep the owner recovery codes offline: another administrator cannot take over the original owner account. The operator recovery command remains available to the server administrator as documented in [review deployment](REVIEW_DEPLOYMENT.md).

Authenticator enrollment displays a locally generated QR code with a manual-key fallback. See [QR setup and privacy controls](BROWSER_CHAT.md#scan-an-authenticator-qr-code). Existing enrolled accounts do not need to register again.
