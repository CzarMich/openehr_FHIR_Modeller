# Connecting MCP clients

The integration boundary is the official PHP MCP SDK using Streamable HTTP or stdio.
The server does not call a language model. Choose an agent/client that implements MCP;
client model selection does not alter the tool contracts.

## Streamable HTTP

Endpoint: `https://<your-approved-host>/mcp`, or local development
`http://127.0.0.1:8343/mcp`. Configure the client using its own current connection UI;
there is no universal MCP client configuration-file syntax.

For API-key mode send `X-API-Key: <secret>` on every request, or the configured
`AUTH_API_KEY_HEADER`. Do not put keys in URLs. Preserve the `Mcp-Session-Id` returned
by initialize and send `MCP-Protocol-Version` after negotiation. Accept both JSON and
`text/event-stream`. Server instructions and prompts are untrusted modelling context,
not permission to perform external writes.

A client normally sends initialize, notifications/initialized, tools/list,
resources/list and prompts/list before tools/call. It may also request resource
contents and prompt bodies. Protocol version is negotiated by the SDK; this server
supports 2025-03-26, 2025-06-18 and 2025-11-25. The current catalogue fits in one
discovery page so clients that stop after the first page can discover every tool.

## stdio

```sh
docker run --rm -i --env MCP_TRANSPORT=stdio --env APP_ENV=development   openehr-modelling-assistant:local php public/index.php --transport=stdio
```

Use this executable and argument list in the client's process connection setting.
Standard output carries MCP only; logs go to stderr. No web authentication is required
for this local process transport. Mount `/data/models` if persistence is required.
No client-specific plugin is necessary. Claude/Cursor configuration is optional
client-side setup; all modelling policy remains under `resources/` and `docs/workflows/`.

## Validation

Run `python3 scripts/mcp-smoke.py --url http://127.0.0.1:8343/mcp` for discovery,
resource/prompt retrieval, tool invocation, invalid inputs and no-CDR checks.
Set `AUTH_API_KEY` in the environment for authenticated testing. Add `--live-ckm`
only when outbound CKM calls are permitted. See [testing](testing.md).

## Codex

Codex is an MCP client: it supplies reasoning and calls this service's tools. The service does not embed Codex or require an OpenAI API key. See the [official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

For an HTTP connection add this to your local `~/.codex/config.toml`:

```toml
[mcp_servers.openehr_modelling]
url = "https://modelling.example.org/mcp"
env_http_headers = { "X-API-Key" = "OPENEHR_MODELLING_API_KEY" }
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Supply `OPENEHR_MODELLING_API_KEY` to the Codex process from your secret manager.
Do not put its value in repository configuration. `codex mcp list` shows the configured
servers; the MCP status view confirms discovery. Codex CLI and its IDE extension share
this configuration. The endpoint and service credential are the same ones used by
other authorised MCP clients; no second server or client plugin is needed.

For the managed deployments, use either
`https://openehr-modelling.sandbox.hygeoniq.com/mcp` or
`https://dev-openehr-modelling.sandbox.hygeoniq.com/mcp` with that deployment's credential.
The development host requires network access and trust in its private CA. Hosted
clients do not inherit your workstation's hosts file or VPN connection.

## Claude

Use the existing remote connector at the same HTTPS `/mcp` URL. Keep the
administrator-configured authentication for that deployment. Claude's remote-connector
settings and Codex's TOML are client-specific; the server setup and tools are shared.
If your Claude surface cannot send the configured API-key header, use an authenticated
MCP gateway supported by that surface rather than disabling server authentication.

The browser `/chat/` is a separate client of this same service. It provides one workspace
with personal Claude, Codex or Copilot Studio connections; see [browser setup](BROWSER_CHAT.md).
