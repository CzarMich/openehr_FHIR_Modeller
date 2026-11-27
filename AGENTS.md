# Instructions for coding agents

## Autonomous execution

Follow [the authorised execution policy](docs/AUTONOMOUS_EXECUTION_POLICY.md). Routine implementation, relevant tests, documentation, commits, pushes, CI monitoring and deployment recovery are authorised. Continue through the user's objective without routine permission questions. Preserve user work, clinical data and persistent application state. Current user instructions take precedence over older workflow notes.

Security scans and attack/load testing are currently deferred at the user's request. Ordinary functional, permission, approval and read-only correctness checks remain required. Never run write-denial probes against a real clinical/source database.

## Runtime and boundaries

Application/domain services, mapping, confirmation and processing are C#/.NET 10 under `dotnet/`. The Node browser backend owns sessions and browser orchestration. Retain the specialised Java/openEHR and Node/Java FHIR engines. The platform is client/provider-neutral.

Every clinical/source database connection is strictly **read-only**, with no override. Source profiles and internal application storage are separate. Never expose patient rows, private job results or credentials to general MCP, model repositories, reusable AI context or model-provider training. FHIR delivery is a separate authorised HTTP operation; source database access never performs delivery.

Exact supplied or agent-authored FHIR StructureDefinitions and applicable openEHR templates must be present and human-confirmed with the executable mapping. Technical validation, mapping confirmation, clinical approval and publication are distinct. Original user narrative, assumptions and corrections remain versioned; unresolved meanings block execution. Agents cannot approve as humans.

Before generating new work, inspect existing artifacts and exact-context reuse. Use deterministic tools and checkpoints. Recheck access, current source/model versions and protected decisions; never cache approval or repeat an uncertain write blindly. Human corrections become new versioned proposals for confirmation, not autonomous clinical rules.

## Ownership and documentation

The product is independently maintained and developed by Michael Anywar under the MIT License. Preserve upstream notices, contributors, source-model credits and Git history. Use `Copyright © 2026 Michael Anywar.` only for original material; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).

Use **openEHR Modeller** in visible branding. Never rename existing identity issuers, accounts, keys, namespaces or volumes for branding. User-facing documentation uses **terminology server**, **server** and **CDR**; retain exact vendor identifiers only where needed for reproducible configuration.

The [documentation index](docs/README.md) links purpose, operation, architecture and limits. Keep [requirements](docs/requirements.md), the [traceability source](docs/traceability.yaml), its [matrix](docs/traceability.md) and [ADRs](docs/decisions/README.md) current. Do not turn historical test reports or planning catalogues into current qualification claims. Connector selection is distinct from executable/qualified support.

## Source map

- `dotnet/Modeller.Mcp`: MCP HTTP/stdio and authenticated browser/review adapters.
- `dotnet/Modeller.Application`: repositories, external adapters, imports, governance, traceability, terminology, project QA and source jobs.
- `dotnet/Modeller.Core`: deterministic mapping, exact models, human confirmation and reuse; no clinical database driver dependency.
- `dotnet/Modeller.Database`: separately bounded source metadata/plan adapters and qualification.
- `dotnet/Modeller.Processing`: private file worker, validation, export and controlled FHIR delivery.
- `chat/src` and `public/chat`: Node browser/session adapter and UI.
- `engine`, `fhir`: retained private standards engines.
- `resources`: actual guides, prompts, examples, BMM and terminology bytes; authoring templates are under `docs/templates`.
- `scripts`: host delivery, functional fixtures and the dependency-free specification gate.

## Verification and delivery

Read [development](docs/development.md), [testing](docs/testing.md) and [migration/runtime boundaries](docs/DOTNET_MIGRATION.md). Use the pinned SDK container for compilation/tests. Build application images **only on hosted CI**, never shared Dev or production. Test the real packaged application plus affected adapters; meaningful synthetic acceptance is separate from hospital qualification. Run `python3 scripts/spec-check.py`; use `--render` after changing the source index. Tests must substantiate behaviour, not duplicate implementation.

Use feature branches and conventional commits. Keep Unreleased changelog bullets short and high-level. `VERSION` is the release version source; do not scatter versions into docs. After pushing, monitor exact-head CI with `scripts/watch-ci.sh` and resolve failures before claiming completion.

[Dev delivery](docs/FHIR_DEV_DELIVERY.md) deploys exact validated hosted-built digests. [Production promotion](docs/FHIR_PRODUCTION_DELIVERY.md) targets the existing RKE2 namespace on `hygeoniq-prod`; `amcdr-vps` is the public edge. The user has authorised the product upgrade, so routine release/promotion work does not require another permission question. Preserve PVCs, secrets, account/issuer identifiers, protected approval records and rollback digests. Match HTTP probes/ingress to the new image cohort atomically. Never restore an old VPS application deployment or build on production.

## Standards content

When changing openEHR standards guidance, retrieve authoritative material rather than guessing: `specifications.openehr.org`, `development` branch; prefer `llms.txt`, then Markdown twins/structured APIs, then HTML. Markdown twins omit per-class attribute/function/invariant tables; use BMM/type APIs or HTML for those. Follow [spec lookup](resources/guides/howto/spec-lookup.md) and [ADR-0005](docs/decisions/0005-spec-aligned-content-retrieval.md).

Keep guides aligned with ADL/OET conventions and bundled grammars. Simplified Flat/Structured JSON must follow the retrieved ITS Simplified Formats specification. Preserve two-level modelling, single-concept archetypes, reuse and clinical meaning; workflow/UI belongs in templates or applications. Start guide changes from [authoring templates](docs/templates/README.md). Avoid trivial rewrites; keep AI-facing guidance concise and useful.

FHIR work uses exact releases/packages and authoritative HL7/package content. Keep engineering Git separate from the existing governance platform's publication/distribution authority. Real patient records never enter FHIR model context or artifact repositories.
