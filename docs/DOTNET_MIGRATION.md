# C#/.NET migration

## Current boundary

The production PHP update is maintained as the compatibility baseline. The new
service targets .NET 10 LTS, SDK 10.0.404/runtime 10.0.15 and the official MCP
ASP.NET Core package 2.4.0. Versions and transitive dependencies are locked and
audited. The guide service now shares a C# core with the separately enabled modelling/integration workspace. The original `/mcp` endpoint remains a PHP compatibility surface; a full PHP removal has not occurred. New application/domain features must be C#; no new PHP features are permitted.

| Surface | .NET status | Gate |
|---|---|---|
| guide_get | First slice | Published input schema/annotations and original Markdown parity |
| Guide resources/list, templates/list, read | First slice | All public guide URIs and byte-for-byte body parity |
| HTTP and stdio | First slice | Initialization, calls, framing, auth rejection and clean stdout |
| HTTP API key/host/origin/body limits | First slice | Positive/negative independent client probes |
| OIDC, tenants and browser accounts | Not migrated | Existing identity/security tests must pass before cutover |
| Search, examples, terminology and CKM | Not migrated | Preserve ranking, scope, versions, provenance and bounded results |
| New integration projects/models/mappings | Independent C# registry | Immutable versions and hash pins; existing PHP repositories are not automatically migrated |
| New integration model/rule confirmation | C# protected review | Purpose/request-bound human assertions, roles, project scopes, sequence checks and HMAC event chain; existing clinical governance remains separate |
| New private source/mapping execution | C# core and worker | Bounded file adapters, deterministic rules, validation, export and conditional-create FHIR delivery; see [integration guide](INTEGRATION_ENGINE.md) |
| Browser backend/providers | Not migrated | Preserve personal credential isolation and browser journeys |
| Compiler/validator engines | Retained | Reuse installed Java/Node services and exact toolchain versions |

## Compatibility boundary

The new tools are `modelling_project`, `modelling_model`, `modelling_mapping`, `source_inspect` and `modelling_engine`. The browser launches a private C# service and workers. Its authenticated public MCP adapter is `/chat/integration/mcp`; the integration page is `/chat/integration/`. The Node browser adapter is retained. This is not a Node or Java rewrite, and specialised engines are not being ported to C#.

The C# registry is a shared organisation workspace for the configured API-key principal. Human calls additionally enforce verified project scopes. Do not advertise API-key tenant isolation. Re-provide and confirm existing models in this registry before assigning a new integration channel; PHP confirmation identifiers are not interchangeable.

## Original guide slice

`dotnet/Modeller.Mcp` reads existing guide files directly into an immutable bounded
index. It exposes only the implemented guide tool/resources. API-key HTTP access
requires an explicit secret file, approved hosts and optional exact browser origins.
Stdio is a trusted local-process transport. It has no model writes, patient-data
operations, database connections or approval capability. Content is not rewritten.

Tests compare every indexed guide against the repository bytes, captured tool and
resource-template metadata, both guide addressing forms, invalid/unknown arguments,
traversal/symlink rejection, unauthenticated requests, Host/Origin restrictions,
request bounds and stdio framing. A private Dev endpoint uses separate credentials
and no production/model data volumes. Production remains on the verified service.

## Delivery and credit discipline

Use one tool group per change and an explicit done condition. Reuse contract tests,
compiler engines, browser assets, fixtures and existing documents. Keep this parity
matrix current; read only the files needed for the next slice. Run deterministic
scripts for build/test/CI monitoring and return concise failures. Do not estimate
credit savings as a percentage without usage evidence. A complete 174-file PHP
rewrite is outside this increment.

Build application images on GitHub-hosted runners. Local Dev compilation/testing
uses the pinned .NET SDK container. Keep the standard Dev-first approval and exact
image digest policy for eventual production replacement. A partial .NET service
must never silently take over the complete production MCP endpoint.
