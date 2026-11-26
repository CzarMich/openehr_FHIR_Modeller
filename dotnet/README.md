# .NET MCP migration — first slice

This independent Dev slice implements `guide_get` and guide resource discovery/read
in C#. It reads the original bundled Markdown directly; there is no PHP proxy.
The production application and all stateful/clinical features remain on the
verified existing service. [Scope and next slices](../docs/DOTNET_MIGRATION.md).

The exact published tool/resource-template contracts are under `contracts/`.
`tests/contract-smoke.py` compares every guide's bytes and URI, checks metadata,
invalid arguments/traversal, authentication, Host/Origin/body limits and stdio
framing. `tests/run-contracts.py` creates isolated fixtures and a private key,
including a symlink to a canary outside the guide root, and runs both transports.
No patient data or production credentials are used.

Local Dev uses the pinned .NET SDK container; keep the NuGet package cache mounted
between restore/build invocations. Build application images only on hosted CI.
With .NET SDK 10.0.404 installed in an isolated development environment:

```sh
cd dotnet
dotnet restore Modeller.Mcp --locked-mode
dotnet build Modeller.Mcp -c Release --no-restore
python3 tests/run-contracts.py --dll Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll
```

Set `GUIDE_ROOT` to the bundled guide directory when running outside the image.
The runtime image includes it at `/app/resources/guides`.

HTTP startup requires `DOTNET_MCP_API_KEY_FILE` pointing to an absolute scoped key
file (32–256 characters). Requests use `X-API-Key`. Configure exact comma-separated
`DOTNET_MCP_ALLOWED_HOSTS` (default localhost/127.0.0.1) and, if needed, accepted
`DOTNET_MCP_ALLOWED_ORIGINS`. Cross-origin browser integration and OIDC/tenant
identity are not migrated. `/health` and `/ready` expose only service readiness.
`--stdio` is for a trusted local caller and does not need the HTTP key.

Never point the complete production workspace at this partial endpoint. No model
writes, approval, publication, source-record processing or database access exists
in this service. Keep current dependency audits and supported runtime patches.
The official C# MCP SDK license/transition notice and third-party notices are
retained verbatim under `notices/`. The .NET runtime retains its upstream notices;
see package lock metadata and [third-party notices](../THIRD_PARTY_NOTICES.md).
