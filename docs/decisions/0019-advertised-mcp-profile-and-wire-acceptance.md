# ADR-0019: Advertised MCP profile and wire acceptance

Status: Accepted

## Context

REQ-F20 requires tested protocol behaviour without adding demonstration tools or suppressing product defects behind an expected-failure list. The SDK's automatic discovery advertised subscriptions even though the product has static resources and no update service. Its older pinned release returned uncorrelated errors for unknown methods. Hard-coded client/server versions obscured negotiation.

## Decision

Upgrade the official PHP SDK to the locked 0.8 series. Retain the existing HTTP/stdio architecture and explicitly advertise the product's supported handshake versions and capabilities. Keep modern stateless MCP, tasks and resource-update delivery outside the advertised profile until they have an implementation and acceptance evidence.

Use a small adapter to negotiate within the supported versions, preserve SDK session state and correct the remaining unknown-method error-code mismatch. Keep this integration outside the modelling domain. Clients verify negotiated versions and response IDs. Allow explicitly configured HTTP loopback browser origins only outside production.

Make production-container HTTP/stdio product probes and pinned applicable official scenarios a required CI gate. Read all actual resources/prompts, test completion and negative/session/security behaviour. Keep the historical whole demonstration-suite evidence as diagnostic evidence, not a successful universal conformance claim.

## Consequences

The gate verifies actual advertised behaviour without installing fake clinical tools. SDK upgrades must pass the same wire tests and adapter/security contracts. The compatibility correction can be removed when the upstream error-code behaviour passes those tests. Optional protocol features remain explicit and cannot be inferred from dependency code presence. No clinical model validation or approval is established by transport acceptance.

## Sources

- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [Official PHP SDK releases](https://github.com/modelcontextprotocol/php-sdk/releases)
- [Official conformance suite](https://github.com/modelcontextprotocol/conformance)
