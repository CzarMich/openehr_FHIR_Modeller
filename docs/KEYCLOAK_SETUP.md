# Keycloak organisation sign-in

The deployment uses the existing Keycloak service at `https://auth.sandbox.hygeoniq.com/` and realm `openfhir`. `https://auth.apps.hygeoniq.com/` redirects to that service. Do not recreate the realm, reset users or replace the identity database for an application upgrade.

## Two account types

| Group | Realm role | Authority |
|---|---|---|
| Users | platform-user | Normal modelling user |
| Administrators | platform-admin | Platform administration and the realm-management realm-admin composite for openfhir only |

Make **Users the only default group**. Keep built-in default account roles. Administrators are assigned manually by an existing administrator; email domain membership never grants that role. The two owner accounts explicitly authorised by the operator belong to Administrators. Do not assign master-realm or other-realm administration.

Configure OTP and Recovery Authentication Codes as enabled default required actions. Require verified email for public registration after SMTP is configured and tested. Users complete passwords, email verification and MFA privately in Keycloak; no credentials belong in chat or Git.

## Browser client

Use confidential client `openehr-modeller-browser`, authorization-code flow only, PKCE S256, and the exact callback `https://openehr-fhir-modeller.sandbox.hygeoniq.com/chat/auth/callback`. Use the exact application origin and `/chat/` home/logout URL; no wildcard redirects, implicit flow, password grants or service account. Default scopes are `profile`, `email`, `acr` and `basic`.

Add a realm-role protocol mapper emitting multivalued string claim `platform_roles` in the signed ID token. The browser verifies issuer, signature, audience, nonce and code flow before mapping that claim. Configure `CHAT_OIDC_ROLE_SCHEME=platform`, `CHAT_REVIEW_ROLES_CLAIM=platform_roles`, the exact HTTPS issuer, client ID and secret from protected configuration. Configure the application human assertion verifier with the same organisation issuer, preserving the distinct native identity issuer and existing assertion signing key. A browser client is not the MCP API audience.

The native owner and organisation identities remain separate. Switching sign-in methods does not migrate private conversations, credentials, account IDs or artifact authorship. Keep the native owner recovery route. Organisation role changes take effect on a fresh sign-in; existing sessions are bounded and can be invalidated by restarting the browser backend.

## Registration domain policy

The approved installation policy is:

```text
gmail.com,ey.com,*.ey.com,hygeoniq.com,alpamax.eu
```

Only `ey.com` includes subdomains. Case is ignored; suffix lookalikes and subdomains of the other listed domains do not qualify. Email verification establishes mailbox control. A matching domain alone does not establish employment, clinical authority or project access.

Use the [registration-only FormAction provider](../identity/keycloak-registration/) built against Keycloak **26.8.2**. Copy the built JAR into the existing providers mount, preserving all existing providers and the installed image's Guava patch. Restart the existing service without resetting its database, volumes or realm keys. Clone the built-in registration flow, add **Registration email domain allowlist** as **Required** inside its registration page, configure `allowed-domains` with the above value and bind the copied flow only to `openfhir` registration. Missing or invalid configuration denies registration.

Do not use a global user-profile email validator for this policy: it can also restrict administrators creating/updating accounts and existing users. This provider runs before registration creates a user; it does not restrict administrator provisioning or existing profile changes. Keep public registration closed until the copied flow is configured, SMTP and verified-email delivery work, and default User/MFA behaviour is checked.

Build with `mvn -B -ntp -f identity/keycloak-registration/pom.xml verify`. Hosted workflow **Keycloak registration provider** also starts a disposable official Keycloak instance with the actual JAR. It verifies approved registrations, rejected domains with no created account, normal User defaults and administrator provisioning outside the domain list. Those are synthetic functional checks, not hospital qualification or a penetration test. Provider upgrades must be checked against the exact deployed Keycloak version.

## Email and operation

Reuse only an operator-approved sender and mail configuration. This installation's approved sender domain is `alpamax.eu`; the existing `afyalink` realm holds the reusable SMTP configuration. Transfer credentials privately through authorised administration, preserve the source realm and leave SMTP debug disabled. Save and test the destination realm's email settings before advertising verification or password-reset email as working. A configured SMTP server is not proof of successful delivery.

An openfhir administrator manages users under Users, and promotes a person by adding Administrators explicitly. Removing an administrator assignment must include removal of any direct platform-admin grants; examine effective roles. Account disablement, logout, password reset and MFA recovery are Keycloak operations. Native workspace invitation/reset links remain a separate manual-delivery system.

Never publish client secrets, SMTP passwords, tokens, recovery codes, identity exports or private account records in logs or artifacts. Back up realm configuration and its database privately before identity-service changes. Preserve stable user subjects, realm keys, other realms, provider JARs and rollback versions.
