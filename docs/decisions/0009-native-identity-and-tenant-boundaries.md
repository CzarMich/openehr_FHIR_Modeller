# ADR-0009: Native identity and tenant boundaries

- Status: Accepted
- Requirements: REQ-N11, REQ-F12

## Context

Native bearer verification was reserved while API keys and browser login were already usable. The completion mandate requires provider-neutral OIDC, scoped write permissions and trustworthy actors for later governance. Reusing browser identity implicitly or accepting unsigned role/tenant arguments would cross established trust boundaries.

## Decision

Use a maintained JWT verifier behind the existing authentication interface. Pin issuer and API audience; discover or explicitly pin the key endpoint. Allow a bounded RS256 profile, bounded refresh, signed scope/role/tenant checks, and verified transport credentials only. Keep no successful-token cache that can outlive expiry. Preserve the local/API-key defaults.

Namespace model storage by issuer and signed tenant and sessions by issuer/tenant/subject. Require distinct explicitly mapped Git remotes across tenants; folder separation alone does not isolate repository history or hosted review metadata. Keep browser chat as a separate MCP client. Bearer principals never prove an interactive human approval, even when MFA appears in authentication-method claims.

## Consequences

Existing API-key data and clients remain usable. Switching authentication modes is an explicit storage/client migration. Providers using another signing algorithm must be configured for RS256 or receive a separately tested adapter extension. Full tenant administration, project ACLs, MCP OAuth onboarding and human governance remain distinct work. Unit/security tests and real identity-provider acceptance verify this increment; Entra tenant acceptance remains externally unexecuted.
