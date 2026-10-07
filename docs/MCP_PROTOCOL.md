# MCP protocol and acceptance profile

The platform exposes the same modelling services through Streamable HTTP at `/mcp` and trusted local stdio. MCP is a client adapter; neither transport requires an LLM provider. Tool schemas, side-effect annotations and examples are in [MCP tools](MCP_TOOLS.md).

## Negotiation and capabilities

The supported handshake revisions are `2025-03-26`, `2025-06-18` and `2025-11-25`. A supported requested revision is retained; an unknown revision receives the newest supported counter-offer. Clients must verify the response and use the negotiated `MCP-Protocol-Version` on subsequent HTTP requests. The browser client checks that version and matches response IDs. Older revisions receive the SDK's compatible text result representation; structured tool results are available on supporting revisions.

The advertised capabilities are tools, prompts, resources, argument completion and logging-level selection. Discovery supports pagination; the 100-item page holds the current catalogue in a single response for clients that do not follow cursors. The protocol check rejects catalogue growth beyond that page. Bundled resources are static. The service does not advertise resource subscriptions, list-change notifications, task execution, sampling or elicitation. HTTP returns JSON for the current synchronous operations; an independent GET event stream returns 405. This is permitted by the [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). The newer stateless MCP lifecycle is not advertised merely because the dependency includes it.

The SDK is pinned through `composer.lock`. Product adapters explicitly select supported versions/capabilities. A narrow transport compatibility correction maps the SDK's invalid-request code for a well-formed unknown method to JSON-RPC method-not-found, preserving the original request ID and all session/authentication processing. It does not modify tool results or replace the protocol engine. Unit and actual-wire negative tests cover the correction.

## Authentication and browser origins

Production HTTP requires configured API-key or OIDC authentication. Sessions are partitioned by authenticated principal; a session identifier is never an authentication credential. See [OIDC](OIDC.md) and [security](SECURITY.md). Clients can explicitly delete an HTTP session; further use returns 404.

`MCP_ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS` are independent exact allowlists. The default rejects all browser origins. HTTPS origins may be explicitly configured. For local nonproduction development only, an explicit `http://localhost`, `http://127.0.0.1` or `http://[::1]` origin with an optional port is allowed. This exception does not permit wildcard origins, arbitrary HTTP hosts, production HTTP origins or insecure outbound CKM/terminology connections. Request-size limits apply before protocol processing; stdio has the SDK's finite line limit.

## Repeatable acceptance

Run `make conformance` or `scripts/test-protocol-container.sh`. The harness builds an isolated production image, uses a loopback listener and synthetic origin configuration, and removes its containers/network afterward. It does not invoke CKMs, terminology servers, commercial clients or model writes.

The product probe runs over both HTTP and stdio and verifies:

- initialization, capabilities, ping and supported/future-version negotiation;
- paginated tools/resources/templates, every bundled resource and every advertised prompt;
- resource argument completion, text/structured results and logging-level requests;
- unknown operations, invalid tool inputs, missing resources and traversal rejection;
- HTTP origin/host/version/session checks, bounded requests, malformed JSON, notifications, preflight and session termination.

The same harness runs the pinned official `@modelcontextprotocol/conformance` package's applicable generic scenarios: initialization, logging level, ping, tools/resources/prompts listing, concurrent POST requests and DNS rebinding. Every selected scenario must pass; there is no expected-failure baseline in this gate. `MCP_OFFICIAL_ACCEPTANCE=false` runs just the product probes for offline debugging, not the complete CI gate.

The historical [whole demonstration-suite result](evidence/mcp-conformance.txt) and [baseline](../tests/conformance-baseline.yml) retain earlier diagnostic evidence. Most excluded scenarios require names such as `test_tool`, `test_tool_with_logging`, `test://...` resources or demonstration prompts that this product does not expose. Others exercise optional subscriptions, sampling, progress or elicitation. Resource reads, prompt retrieval, completion and tool errors are exercised against the actual product by the independent probe; they are not absent because a demonstration name fails. The historical DNS exception is replaced by explicit allowed-origin and malicious-origin/host acceptance tests. Do not describe the selected profile as passing every official scenario or as universal MCP certification.

CI also runs authenticated OIDC/API-key rejection, tenant/session isolation, repository contracts and browser tests. Evidence records live external acceptance separately from isolated transport checks. [Current verification](evidence/protocol-verification.json), [HTTP](evidence/protocol-http-smoke.json) and [stdio](evidence/protocol-stdio-smoke.json) retain execution scope.
