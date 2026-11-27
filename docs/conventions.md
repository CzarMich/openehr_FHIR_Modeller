# Engineering conventions

Application and modelling domain code lives under `dotnet/` in C#/.NET 10. Keep source-driver adapters outside the deterministic core and private file worker. The Node browser backend adapts verified human sessions and orchestrates private workflows; standards engines retain their specialised runtimes. Use explicit types, bounded inputs, cancellation, meaningful error codes and compiler warnings as errors. Browser code uses the pinned formatter and test tools from `chat/package.json`.

MCP is a provider-neutral application adapter. Primary tool/resource/prompt contracts are captured under `dotnet/contracts`; changing them is a deliberate compatibility change. Keep output scope honest. A tool's structured result, evidence and limitations must agree. Do not label missing model-aware validation as success or infer clinical approval from a compiler/validator.

Use exact immutable model revisions, hashes, FHIR releases/packages and dependency manifests. Preserve original imported bytes, provenance, user narratives, interpretations, assumptions and synthetic examples. Model selection, mapping confirmation, clinical approval and publication have separate permissions and evidence. Ordinary MCP service credentials cannot make human decisions.

Clinical/source databases are read-only without an override. Source discovery uses actual vendor metadata and dictionaries. Never hardcode clinical meanings from table names or let a caller submit arbitrary SQL/driver executables. Keep patient records, private outputs and credentials outside generic MCP, model/provider context, Git engineering artifacts and reusable modelling memory. FHIR destination writes use separately authorised HTTP operations.

Prefer deterministic [reuse and checkpoints](REUSE_AND_LEARNING.md) before AI generation. Recheck access and current protected decisions; a cache never grants approval. Human corrections create a versioned proposal for confirmation. Avoid per-record LLM interpretation in channels.

Use protected internal stores, explicit current revisions and atomic updates. New browser controls must call real server operations and show meaningful unavailable/qualification states. Do not ship decorative settings or silently widen access. Follow [shared workspace controls](WORKSPACE_ACCESS_AND_SETTINGS.md) and retain separate view, monitor, edit, operate and patient-result rights.

Update [requirements](requirements.md), [traceability](traceability.yaml), [architecture](ARCHITECTURE.md) and relevant ADRs with behaviour changes. Preserve public requirement identifiers. Keep release/changelog descriptions concise. Document actual acceptance evidence and remaining limits; preserve upstream notices and stable installation identities.

For guides, start with [authoring templates](templates/README.md) and retrieve the authoritative openEHR development specification using [the lookup policy](../resources/guides/howto/spec-lookup.md). Do not guess formal standards content. Keep prompts short, place detailed knowledge in retrievable guides and preserve source-model attribution.
