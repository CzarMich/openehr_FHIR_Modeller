# ADR-0015: Persisted governance and interactive human approval

- Status: Accepted

## Context

Draft model artefacts are intentionally writable through MCP and Git. Governance authority cannot be established by an `approved` field or validation report supplied through those interfaces. Bearer credentials are delegable to agents, including credentials with MFA claims. The existing pure transition policy has no persisted authoritative event history or interactive approval surface.

## Decision

Introduce a domain audit-store interface and a transactional SQLite implementation in separately mounted service storage. Store append-only events with sequence compare-and-swap, exact source revision/hash, trusted actor identity, timestamp, previous/new state, comments and evidence hashes. SQL triggers prohibit normal update/delete operations; a verified hash chain detects event corruption. This is application-level immutability, not protection against an administrator replacing the entire database. Back up the ledger independently of model storage. One authoritative ledger instance owns a namespace; clustered database adapters remain a separate deployment concern.

MCP may prepare and request review. It cannot attest human presence or approve/publish a model. A dedicated browser review surface uses the existing verified OIDC session, origin/CSRF checks and explicit revision-specific confirmation. The browser backend signs short-lived, request-bound assertions with a dedicated deployment credential unavailable to model workers. The core verifies fixed audience/issuer, signature, expiry, body/method/path binding, tenant and role policy and single-use nonce. A normal MCP API key or OIDC access token is insufficient for the interactive review route.

The core obtains validation evidence only through its configured deterministic validation service. User-editable JSON cannot grant release eligibility. Partial/unexecuted validation prevents approval and publication. Human review must be independent of the registered author and tied to the exact revision. Source changes require a new review subject; old events remain queryable. The browser approval action is separate from chat's repository-write confirmation.

## Implementation gates

Complete and verify the ledger, service, identity bridge, browser review UI, explicit deployment settings, negative security tests and independent protocol checks before marking this capability implemented. The current unqualified validation pipeline must continue preventing operational release until the openEHR engine and required policy checks are qualified.

The assertion verifier follows [JWT best current practices](https://www.rfc-editor.org/rfc/rfc8725) and [JWT claim semantics](https://www.rfc-editor.org/rfc/rfc7519): fixed algorithm/key purpose, explicit token type and audience, bounded times, issuer validation and no remotely supplied key URLs. The browser identity originates from the [OIDC authorization-code flow](https://openid.net/specs/openid-connect-core-1_0.html). This project-specific assertion is an internal application contract, not an OIDC token or a claim of physical human presence from a bearer token.
