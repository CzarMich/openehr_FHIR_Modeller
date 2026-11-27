# Model API

The primary C# application exposes MCP tools and a versioned HTTP model API over shared repository services. API-key/OIDC access remains a service/verified-token boundary; human review decisions require their separate request-bound interactive flow. Do not send clinical records through these modelling endpoints.

| Operation | HTTP route |
|---|---|
| List/create projects | `GET` / `POST /api/v1/projects` |
| Read a project and artifact list | `GET /api/v1/projects/{id}` |
| Archive a project with its current revision | `POST /api/v1/projects/{id}/archive` |
| Read/save a model artifact | `GET` / `PUT /api/v1/artifacts?project={id}&path={encodedPath}` |
| Read an exact historical artifact | `GET /api/v1/artifacts?project={id}&path={encodedPath}&revision={revision}` |
| Read artifact history | `GET /api/v1/artifact-history?project={id}&path={encodedPath}` |

Project creation accepts `id`, `name` and optional `description`. Saving accepts exact `content`, `metadata` and `expectedRevision`; use null for a new artifact and the actual current revision for a replacement. Archive accepts `expectedRevision`. Unknown fields/query parameters are rejected. Project write/create permissions and the configured repository write policy apply. Original imports and immutable artifacts cannot be overwritten through a generic save.

The HTTP adapter is implemented in `dotnet/Modeller.Mcp/ApplicationBrowser.cs`; repository semantics are under `dotnet/Modeller.Application`. [OpenAPI](openapi/models.json) describes the model contract; current adapter acceptance remains authoritative for the installed release. Use MCP `model_*` operations for agent orchestration rather than a removed shell wrapper. `--stdio` selects the primary application transport; it is not a model-editing command interpreter.

Human review and the private integration registry are separate interfaces. See [governance](GOVERNANCE.md), [integration](INTEGRATION_ENGINE.md), [identity/access](IDENTITY_AND_ACCESS.md) and [reuse](REUSE_AND_LEARNING.md). Exact model/rule confirmation does not establish clinical approval or authorise delivery.
