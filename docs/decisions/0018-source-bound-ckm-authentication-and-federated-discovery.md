# ADR-0018: Source-bound CKM authentication and federated discovery

- Status: Accepted

## Decision

Keep named HTTPS CKM sources as administrator configuration. Bind each optional outbound credential profile to one source and apply it per request. Support the published API's Basic and session-header methods, plus bearer/API-key gateways. Mounted secret files permit rotation without exposing credentials through discovery. Reject redirects, ambiguous credential configuration and unknown source selection.

Put federated aggregation behind a domain search port and a shared application service. Reuse the existing CKM mapping/ranking implementation through its configured integration adapter; do not duplicate its lexical rules. The legacy implementation currently resides with its MCP capability class and can move behind the port during the planned transport/domain refactor.

Keep source identities and versions separate. Expose per-source failures, unattempted sources, reported totals and retrieved windows. Bound source count, result size and shared request time. Never call a truncated or partially unavailable search an exhaustive model inventory, and never substitute a different source during retrieval.

## Consequences

Public-source defaults and single-source tool contracts remain. Organisation credentials are deployment service identities, distinct from inbound user authentication; per-user upstream entitlements require later access-policy work. Private-source account acceptance remains external when credentials are unavailable. Isolated HTTPS authentication/rotation contracts and opt-in public reference acceptance are reproducible independently.

Search remains deterministic and available without semantic embeddings, a model provider, CDR or terminology server. Qualified dependency builds must subsequently pin selected model versions and hashes. See [CKM sources](../CKM_SOURCES.md) for configuration, limits and migration.
