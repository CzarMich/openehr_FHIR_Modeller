# Install openEHR and FHIR Modeller

## Self-hosted deployment

```bash
git clone https://github.com/CzarMich/openehr_FHIR_Modeller.git
cd openehr_FHIR_Modeller
cp .env.example .env
docker compose up -d --build
curl --fail http://127.0.0.1:8343/ready
```

Docker with Compose v2 is required. These defaults expose a development endpoint only on loopback. Data persists in the named models volume. Production requires API-key authentication, a TLS gateway and explicit allowed hosts; see [deployment](DEPLOYMENT.md) before opening network access. No upstream hosted endpoint or client plugin is required.

## Browser owner setup

For built-in browser accounts, configure native identity and persistent browser
storage, then follow [one-time owner setup on Linux or Azure](REVIEW_DEPLOYMENT.md#generate-the-one-time-owner-setup-token).
The guide covers Linux Docker, Azure Container Apps, AKS and App Service, including
token retrieval, expiry, renewal and required MFA. Organisation OIDC accounts are
managed by the identity provider.

## Clients

Connect a Streamable HTTP MCP client to `/mcp`. Use [generic client instructions](MCP_CLIENTS.md) or [Microsoft Copilot Studio instructions](MICROSOFT_AGENT_INTEGRATION.md). Prompts and resources depend on client support. See [configuration](CONFIGURATION.md) for required and optional variables and [development](development.md) for stdio and contributor setup.
