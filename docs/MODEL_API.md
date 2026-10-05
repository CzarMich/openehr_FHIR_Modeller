# Model Application API and CLI

The versioned application API exposes bounded project and artefact operations over the configured repository. It shares repository revisions, optimistic write conflicts, OIDC project scopes and deployment write policy with MCP. OpenAPI contract: [models.json](openapi/models.json).

## HTTP API

Production requests must pass the normal HTTP authentication, host/origin, body-size and TLS proxy boundaries. Configure `AUTH_MODE` as documented in [OIDC](OIDC.md) or [security](SECURITY.md). The API is mounted below `/api/v1`:

| Method and path | Operation |
|---|---|
| `GET /api/v1/projects` | List projects visible to the caller and repository capabilities |
| `POST /api/v1/projects` | Create a project; requires model-write permission and, with project RBAC, `projects:create` or `projects:admin` |
| `GET /api/v1/projects/{project}` | Read a project and its artifact summaries |
| `POST /api/v1/projects/{project}/archive` | Archive a project with its current `expectedRevision`; stale revisions return HTTP 409 |
| `GET /api/v1/artifacts?project=...&path=...&revision=...` | Read the current or exact historical artifact |
| `PUT /api/v1/artifacts?project=...&path=...` | Create or update a draft artifact with optional `expectedRevision` |
| `GET /api/v1/artifact-history?project=...&path=...` | Read artifact revision history |

Example update body:

```json
{"content":"<template/>","metadata":{},"expectedRevision":"previous-revision"}
```

Omit `expectedRevision` only when creating a new artifact. A stale revision returns HTTP 409 with `REVISION_CONFLICT`; the API never silently overwrites newer work. Errors have a stable `{ "error": { "code": "..." } }` envelope. Requests reject unknown fields and unsupported query parameters. Project-scoped OIDC mode filters lists and checks every project read/write at the repository boundary.

## CLI

The CLI runs in the app container against the same configured repository. It does not start a second storage implementation:

```sh
docker compose exec -T app composer model -- projects
docker compose exec -T app composer model -- project neonatal
docker compose exec -T app composer model -- artifact neonatal templates/admission.oet
docker compose exec -T app composer model -- history neonatal templates/admission.oet
docker compose exec -T app composer model -- save neonatal templates/admission.oet /tmp/admission.oet <expected-revision>
```

`create <id> <name> [description]` creates a project. `save` requires `MODEL_REPOSITORY_WRITE_ENABLED=true`, reads at most 2 MiB from the supplied local file, and accepts an expected revision for updates. The CLI refuses `AUTH_MODE=oidc`: a local process cannot impersonate a verified user or select an OIDC tenant. Use the HTTP API or authenticated MCP transport for OIDC-scoped access. The CLI is a trusted local operator interface, not a remote multi-user endpoint.