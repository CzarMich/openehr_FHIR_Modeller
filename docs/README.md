# openEHR Modelling Assistant documentation

Independently maintained and developed by Michael Anywar.

Copyright © 2026 Michael Anywar.

Licensed under the [MIT License](../LICENSE). Separately licensed third-party
material retains its respective terms; see the
[third-party notices](../THIRD_PARTY_NOTICES.md).

## Setup and use

- [Installation](install.md), [deployment](DEPLOYMENT.md) and [configuration](CONFIGURATION.md)
- [Claude, Codex and other MCP clients](MCP_CLIENTS.md); [Microsoft clients](MICROSOFT_AGENT_INTEGRATION.md)
- [Browser chat](BROWSER_CHAT.md), [workspace](BROWSER_WORKSPACE.md) and [human review setup](REVIEW_DEPLOYMENT.md)
- [Bounded AI task execution](TASK_EXECUTION.md): context budgets, project handoffs and independent review.
- [Copilot Studio browser setup](COPILOT_BROWSER.md): Microsoft sign-in, published agents, client tools and verification.
- [Capabilities and limitations](../CAPABILITIES.md), [MCP tools](MCP_TOOLS.md) and [protocol support](MCP_PROTOCOL.md)
- [Identity and access](IDENTITY_AND_ACCESS.md), [OIDC](OIDC.md) and [security](SECURITY.md)

## Modelling and storage

- [CKM sources](CKM_SOURCES.md) and [model imports](MODEL_IMPORTS.md)
- [Artefact versions](ARTEFACT_VERSIONING.md)
- [Model repository](MODEL_REPOSITORY.md), [hosted Git](HOSTED_REPOSITORIES.md) and [SharePoint](SHAREPOINT_REPOSITORY.md)
- [Native validation and compilation](OPT_COMPILATION.md), [legacy OET/OPT support](LEGACY_OPT_COMPILATION.md) and [project QA](VALIDATION_AND_QA.md)
- [Terminology](TERMINOLOGY.md), [catalogues](TERMINOLOGY_CATALOGUE.md) and [binding plans](TERMINOLOGY_BINDING_PLANS.md)
- [Governance](GOVERNANCE.md), [requirements traceability](REQUIREMENTS_TRACEABILITY.md) and [storage/cache](POSTGRES_AND_CACHE.md)
- [External modelling tools](MODELLING_TOOL_INTEGRATION.md), [Archetype Designer](ARCHETYPE_DESIGNER_INTEGRATION.md) and [compatibility](ARCHETYPE_DESIGNER_COMPATIBILITY.md)
- [Shared Git workflow](workflows/shared-git-models.md) and [neonatal modelling example](workflows/neonatal-admission.md)

## Development

- [Architecture](ARCHITECTURE.md), [development environment](development.md), [conventions](conventions.md) and [testing](testing.md)
- [Requirements](requirements.md), [traceability](traceability.md) and [architecture decisions](decisions/README.md)
- [Model API and CLI](MODEL_API.md); OpenAPI contracts for [models](openapi/models.json) and [reviews](openapi/reviews.json)
- [Planned capabilities](COMPLETION_QUEUE.json) and [external exchange requirements](EXTERNAL_MODELLING_REQUIREMENTS.json)

## Historical records

[Baseline audit](BASELINE_AUDIT.md), [migration notes](WHITE_LABEL_MIGRATION.md) and
[implementation history](IMPLEMENTATION_REPORT.md) record earlier checks. Their test
counts and deployment observations apply to the revisions recorded there. Use the
[testing guide](testing.md) to verify the current checkout.

- [AQL workspace and private CDR connections](CDR_WORKSPACE.md) — setup, user workflow, privacy and execution limits.

External IG/package URLs, StructureDefinition and ValueSet imports, connected definition searches and extensible release capabilities: [FHIR external sources](FHIR_EXTERNAL_SOURCES.md). The browser User guide includes the same workflow.
