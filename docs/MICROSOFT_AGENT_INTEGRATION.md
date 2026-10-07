# Microsoft agent integration

Microsoft is the primary documented enterprise consumer. The openEHR core has no
Microsoft dependency. The model offered within the organisation's Copilot deployment
is a client choice: no Claude/GPT provider is configured in this MCP server.

For **Copilot Studio replies inside this browser**, use the separate [Copilot Studio browser setup](COPILOT_BROWSER.md). It preserves profile-scoped source/repository tools and browser confirmations through client-tool events. The MCP onboarding below remains the route for Microsoft-hosted agent interfaces.

## Supported Microsoft paths

Official documentation reviewed 2026-09-26:

| Platform | Documented connection | Verification boundary |
|---|---|---|
| Copilot Studio | MCP onboarding wizard or Power Apps custom connector; Streamable HTTP | Primary path below; tenant acceptance not yet performed |
| Microsoft Agent Framework | `MCPStreamableHTTPTool`, with `static_headers` or a `header_provider` | Client integration option, not a server dependency |
| Microsoft Foundry agents | Remote MCP endpoint and project connection for authentication | Azure project/identity configuration belongs to the consumer |
| Microsoft 365 Copilot | Organisation-managed agent extension/distribution path | No generic ChatGPT-style config file is asserted |

Sources: [Copilot Studio connection procedure](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent),
[MCP in Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp),
[Agent Framework MCP tools](https://learn.microsoft.com/en-us/agent-framework/agents/tools/local-mcp-tools),
[Foundry remote MCP](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol),
[Microsoft 365 extensibility](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview).
Availability and tenant policies must be checked in the target organisation.

## Connect with Copilot Studio

The browser's **Help → Connect Copilot Studio** page provides these steps and the
deployment's exact server address/header. A signed-in native administrator can
explicitly retrieve the configured MCP key there; retrieval is audited and requires
CSRF protection. This is the existing deployment key, not a newly issued per-user key.
No key is exposed to the assistant or to ordinary workspace users.

Deploy the app according to [deployment](DEPLOYMENT.md) and expose
`https://<enterprise-host>/mcp`. Use `AUTH_MODE=api_key` for this implementation,
with a secret-managed key. On the agent's Tools page choose Add a tool, New tool,
then Model Context Protocol. Enter the server name, description and HTTPS URL.
Choose API key, Header, and `X-API-Key` (or your configured header). Create the
connection and add the server to the agent. These wizard fields and the Streamable
transport are documented by Microsoft; legacy standalone SSE is not the target.

The server-side authentication decision is independent of which LLM the agent uses.
No code in `domain/`, CKM or terminology depends on Microsoft Graph or Azure OpenAI.

## Discovery and acceptance workflow

1. Confirm `/ready` through the monitoring path and initialise MCP with an independent client.
2. In the agent, check that `ckm_sources`, `ckm_archetype_search`, `guide_get`,
   `model_validate` and `terminology_lookup` are discovered. Compare with [the catalogue](MCP_TOOLS.md).
3. Ask for blood-pressure archetypes. Inspect the actual tool call and selected `ckm` name.
   Retrieve a returned identifier; do not accept a plausible but unretrieved identifier.
4. Ask for neonatal-admission modelling with birth details, gestational age, weight,
   Apgar, vital signs, examination, diagnosis, feeding and medications. Follow
   [the workflow](../workflows/neonatal-admission.md), recording missing concepts.
5. Use `template_build_oet` with direct `entries` or an explicit parent-first `placements`
   list containing exact archetype-relative paths. Inspect its document and optional native
   compile-check reports. Do not call the draft an OPT or a deployment-ready template.
6. Ask for an AQL query for birth weight below 2500 g using retrieved paths. The result
   is an agent-authored draft, with syntax/execution validation unavailable.
7. Try a wrong API key, unavailable CKM and unavailable terminology server. Verify errors
   appear and local guide retrieval still works. Test the published agent channel too.
8. Keep project writes disabled initially. When enabling them, inspect the agent's
   tool approvals and verify revision-conflict behavior. No approve/release tool exists.

These are repository-specific acceptance steps, not claims of an executed tenant test.

## Entra/OIDC and proxies

The `Authenticator` interface is outside the domain. Native OIDC access-token
verification is implemented, including issuer metadata discovery, JWKS, signatures,
audience/time validation, scopes, roles and tenant isolation. See [OIDC](OIDC.md)
for the Entra profile and migration. Register the actual API and consuming client;
use their real tenant-specific issuer, API audience and permissions. Automatic MCP
protected-resource discovery/client registration remain separate work, so preconfigure
the OAuth connection. Existing API-key deployments do not become OAuth endpoints automatically. A gateway can authenticate enterprise
users and hold the upstream service key under the controls in [security](SECURITY.md).

Preserve Host and MCP session/protocol headers through the HTTPS gateway. Allow the
configured API-key header, JSON and event-stream responses, and sufficiently long
request timeouts. Configure outbound proxies and enterprise CA trust; never disable
TLS verification. Restrict CORS to actual browser origins if needed; server-to-server
clients do not require a wildcard CORS policy. A public development tunnel is not
required for local tests; any tenant-accessible dev endpoint must use approved HTTPS
and authentication. Do not assume a tenant can reach a workstation's localhost.

## Troubleshooting and status

| Symptom | Check |
|---|---|
| 401 | API key present on every request and exact header name |
| 403 | Actual Host and Origin match configured allowlists |
| 404 | Exact `/mcp` path and gateway route |
| 413 | Client payload, application limit and gateway limit |
| Session invalid after restart | Initialise a new session |
| Tools missing | Refresh discovery; deployed image and schema-cache revision |
| CKM/terminology failure | Source name, machine credential, egress, CA trust, timeout |
| Tenant tool unavailable | Platform availability, connection sharing and tenant data policies |

| Component | Status | Evidence boundary |
|---|---|---|
| Remote MCP and API-key authentication | WORKING | Repository integration tests; see execution report |
| Microsoft discovery and execution | NOT TESTED | Requires the target tenant |
| HTTPS gateway deployment | NOT TESTED | Local verification uses loopback HTTP |
| Native OIDC verifier | IMPLEMENTED | Live identity-provider acceptance and Entra-style signed fixture tests; live Entra tenant acceptance still required |
| CKM/template/AQL through Copilot | NOT TESTED | Exact acceptance steps above |

Final enterprise deployment requires the organisation's architecture and security review.
