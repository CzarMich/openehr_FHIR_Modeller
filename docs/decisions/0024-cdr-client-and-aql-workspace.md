# ADR-0024: Private CDR client and model-aware AQL workspace

Status: Accepted

## Context

REQ-F24 requires model-driven AQL construction and read-only execution against multiple CDR environments without turning the modelling repository into clinical storage. Browser users have individual identities while the browser's ordinary MCP credential identifies a shared service. CDR credentials and result rows must not flow into provider context or repository artifacts.

## Decision

Introduce a provider-neutral `CdrAdapter` port and generic openEHR REST adapter behind one PHP application service. Keep encrypted profile configuration and query metadata on a separate volume. Resolve credentials through an interface supporting encrypted records and administrator-only environment references; future keychain/vault implementations need not change the workspace. Reject credential URLs, unapproved private destinations, redirects, unverified TLS and oversized responses.

Use browser assertions with a distinct CDR purpose/audience, exact request binding and replay protection. Browser chat routes CDR tools through the verified human session. External MCP uses configured connection IDs assigned to its transport-derived principal. Only the explicit browser Run operation may execute queries and return rows. AI/MCP execution and query-library reads are denied: history and saved queries can contain patient identifiers in literals, and even count-only execution can disclose facts through repeated queries. Browser tool discovery hides these operations, and both browser and direct MCP dispatch enforce the boundary. History stores query text, parameter names and execution metadata, never results or parameter values.

Extend the native AQL parser boundary with exact hash-pinned OPT inputs and native RM path inspection. Preserve syntax-only use. Unsupported boolean/version containment or polymorphic paths produce INCOMPLETE. Path-based generation and explanation remain deterministic and independent of AI or CDR access. Optional assistant drafting uses a separate provider turn with only inspected model metadata, path search and validated submission tools. It writes the accepted draft directly into the existing editor; query text already in the editor, parameters, results and chat history never enter that turn. Central connection definitions share only connection configuration; saved queries and history remain keyed by tenant/user and selected environment.

## Consequences

The client supports standard Query API POST and ADL 1.4 Definition API reads, not composition writes or CDR deployment. API/version support is discovered by actual bounded requests. Cancellation terminates the client transfer but cannot guarantee that a CDR cancels its server-side computation. Query text can itself contain sensitive literals; the UI recommends parameters and permits clearing history. Encryption-key backup is required, and key rotation needs an explicit re-encryption process.

Verification includes mock transport/authentication failures, encryption/actor isolation, cancellation, row limits, query/result separation, native OPT path checks and desktop/mobile browser workflows. Live development verification is supplementary; CI uses synthetic fixtures.
