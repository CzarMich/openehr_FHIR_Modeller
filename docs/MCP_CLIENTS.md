# MCP clients

The application uses the official C# MCP SDK and exposes Streamable HTTP and standard I/O. Clients supply their own model/orchestration; the modelling application does not depend on a model-provider SDK. The browser backend and external clients use the same primary modelling tools. Human decisions use a separate authenticated request-bound API.

## HTTP

Configure your MCP client with the deployment's HTTPS `/mcp` URL and its protected API-key or verified OIDC access-token settings. Use the administrator-configured API-key header. Do not paste credentials into prompts, model content, URLs or committed configuration. Set the correct API audience/scopes/project rights for OIDC. The server applies Host/Origin allowlists and separates tenants/service identities according to the installation configuration. See [OIDC](OIDC.md) and [identity/access](IDENTITY_AND_ACCESS.md).

API-key access is a service-principal workspace. Browser sign-in does not automatically convert that principal into a private human workspace or an approver. Mapping/profile confirmation and clinical review require the applicable verified interactive human flow.

## Standard I/O

Launch the installed application image/process with `--stdio`. The container entrypoint already runs `dotnet Modeller.Mcp.dll`; append the argument rather than replacing it with a different runtime. With configured prebuilt Compose images, `make run-stdio` supplies an open stdin. Keep stdout exclusively JSON-RPC. See [installation](install.md) and [protocol](MCP_PROTOCOL.md).

## Cost-aware workflow

Retrieve the relevant guide/model rather than loading the entire catalogue into a prompt. Reuse exact existing artifacts and [mapping reuse/checkpoints](REUSE_AND_LEARNING.md) before generation. Supply actual model bytes and exact versions. Preserve user narratives, provenance and unresolved meanings. Tool output and an AI summary are not clinical approval.

The private C# modelling registry has a separate `/chat/integration/mcp` adapter when enabled by the browser service; it does not replace the primary MCP or share approval identifiers automatically. Keep its supplied models/rules and exact confirmation evidence intact. See [integration](INTEGRATION_ENGINE.md).

Clinical/source databases are strictly read-only. Real patient records, private outputs and credentials stay outside general MCP and provider context. An external FHIR destination is a separate authorised HTTP operation, never a direct database write.
