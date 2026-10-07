# AGENTS.md

Instructions for AI coding agents working in the **openEHR Modelling Assistant** repository.

## Autonomous execution

Follow the user's [Autonomous Execution Policy](docs/AUTONOMOUS_EXECUTION_POLICY.md). Routine implementation, testing, debugging, configuration, documentation, commits, pushes, CI monitoring and deployment recovery are already authorized. Continue through the user's entire objective without routine permission questions. Preserve user work and data; investigate safely before escalating a genuine external-access or irreversible-action blocker. Higher-priority environment security controls still apply.

User-facing documentation and UI use **terminology server**, **server**, and **CDR**, without deployment-specific product names. Keep exact technical identifiers only where needed for reproducible setup.

## Ownership and third-party material

The current product is independently maintained and developed by Michael Anywar.
Keep the project under the MIT License. Use `Copyright © 2026 Michael Anywar.`
only for his original material. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Preserve upstream notices, source-model credits, dependency metadata and historical
commits; do not add blanket ownership headers to inherited or mixed files.

## Project Overview

- A PHP 8.4 MCP server exposing openEHR tools, prompts, and resources to MCP clients, built on `mcp/sdk` ([modelcontextprotocol/php-sdk](https://github.com/modelcontextprotocol/php-sdk)) with attribute-driven discovery (`#[McpTool]`, `#[McpPrompt]`, `#[McpResourceTemplate]`/`#[McpResource]`, `#[CompletionProvider]`). Feature overview: `README.md`.
- This product is client-neutral; no client plugin or model SDK is required.

## Documentation map

This repo follows a lightweight **Specification-Driven Development** paradigm. The spec set under [`docs/`](docs/README.md) is the source of truth; AGENTS.md is the rules layer that links into it. Keep detail in the owning doc and point to it.

| Document | Owns |
|----------|------|
| [`docs/requirements.md`](docs/requirements.md) | `REQ-#` functional and non-functional requirements (the *what*) |
| [`docs/architecture.md`](docs/architecture.md) | Components mapped to requirements (the *how*) |
| [`docs/decisions/`](docs/decisions/README.md) | Architecture Decision Records (the *why*) |
| [`docs/traceability.md`](docs/traceability.md) | REQ, code, test, ADR matrix; the machine-checked source is [`docs/traceability.yaml`](docs/traceability.yaml), validated by `make spec-check` ([ADR-0006](docs/decisions/0006-machine-checked-traceability.md)); SDD settings in [`docs/.sdd.yaml`](docs/.sdd.yaml) |
| [`docs/conventions.md`](docs/conventions.md) | **Canonical** coding and MCP authoring conventions: PSR-12, namespaces, tools, prompts (incl. the prompt policy split), resources, completion providers |
| [`docs/development.md`](docs/development.md) | Docker dev environment, services, transports, env vars, discovery cache, Makefile targets |
| [`docs/testing.md`](docs/testing.md) | Tests, PHPStan, coverage, conformance, drift gate |
| [`docs/install.md`](docs/install.md) | Independent and local setup, MCP client configurations (user-facing) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | PR checklist, branch naming, release housekeeping |

## Domain Context

### Looking up openEHR specification content

When authoring or editing guides, prompts, BMM JSON, terminology, AQL grammar, or anything that must track the upstream openEHR standards, **do not guess or rely on training memory**. Retrieve from `specifications.openehr.org`, cheapest representation first: `llms.txt` index, then `.md` twin, then structured `/api/*.json`, then HTML. The Markdown twin omits per-class attribute/function/invariant tables; use `type_specification_get` (BMM-backed) or the HTML page for those. Track the `development` branch, not `latest`.

Full policy and failure modes: the [`spec-lookup` how-to](resources/guides/howto/spec-lookup.md) (`guide_get(category="howto", name="spec-lookup")`; also in `resources/server-instructions.md`) and [ADR-0005](docs/decisions/0005-spec-aligned-content-retrieval.md).

### Guides and specification alignment

- Guides under `resources/guides/` and prompts that describe a standard (e.g. AQL) must stay aligned with the authoritative spec and any formal grammar in the repo. Avoid duplicate or misplaced paragraphs in guide files.
- **Archetypes/templates**: guides under `resources/guides/archetypes/` and `resources/guides/templates/` stay consistent with openEHR modelling docs and the project's ADL/OET conventions.
- **Simplified Formats**: guides under `resources/guides/simplified_formats/` (Flat and Structured JSON; Web Template field identifiers, ctx, pipe suffixes, underscore prefix) must align with the openEHR **ITS Simplified Formats** specification, retrieved per the spec-lookup policy above, not from memory.
- **Authoring conventions and templates**: guide Markdown style, spec-digest rules, and the copy-ready digest skeleton live under [`src/templates/`](src/templates/README.md). Start there before adding or modifying a guide.

### Clinical modelling and governance

When adding or changing guidance on archetypes, templates, or clinical modelling, uphold: **two-level modelling** (RM vs archetype/template); **single-concept archetypes**; **no workflow/UI in archetypes** (those belong in templates or apps); **reusability and semantic correctness** over app-specific convenience; **CKM and spec alignment**.

## Repository Layout

- `public/index.php`: entrypoint; registers MCP capabilities, selects the transport, and uses a file-based discovery cache for fast startup.
- `src/Tools`, `src/Prompts`, `src/Resources`, `src/CompletionProviders`: MCP capabilities; how to author each is in [`docs/conventions.md`](docs/conventions.md).
- `src/Apis`: internal API clients (CKM). `src/Helpers`: internal helpers. `src/Sdd`: the `spec-check` drift gate. `src/templates`: guide and spec-digest authoring templates. `src/constants.php`: env loading and defaults (incl. `APP_VERSION`). `scripts/`: CLI entrypoints (`spec-check.php`).
- `resources/`: guides, examples, BMM JSON, terminology, prompt bodies, `server-instructions.md`.
- `tests/`: PHPUnit tests (mirroring `src/`) and the PHPUnit/PHPStan configs.
- `chat/`: optional browser service, personal Claude/Codex provider connections, identity and chat tests. `public/chat/`: browser UI.
- Browser task context, session rotation, private project handoffs and token-budget rules: [`docs/TASK_EXECUTION.md`](docs/TASK_EXECUTION.md). Extend existing repository/traceability authority; do not treat transcripts or AI handoffs as approved decisions.
- `Dockerfile`: PHP and ingress images. `.docker/`: development Compose overlay and `Caddyfile`. `.github/workflows/`: `pr-validation.yml`, `release.yml`.

## Development

The runtime is **Docker-only**: the host (WSL2 on Windows) has no PHP or Composer. Never run `php`, `composer`, or `vendor/bin/*` on the host; they fail. Run them inside the `app` dev container ([ADR-0004](docs/decisions/0004-docker-only-runtime.md)). Services: `app`, `ingress` (Caddy), dev-only `node`. Scripts: `composer.json` `scripts`.

```bash
make up-dev       # start dev containers
make install      # install Composer dev dependencies
make ci           # spec-check + PHPStan + tests (mirrors PR validation); run before pushing
make conformance  # MCP conformance suite (stack must be up)
```

- Single test class, inside the container: `composer test -- --filter SomeTest` (a bare `vendor/bin/phpunit` finds no config; it lives at `tests/phpunit.xml`).
- Full `docker compose … exec` invocations: [`docs/testing.md`](docs/testing.md).
- **Transports:** `streamable-http` (default; dev port `:8343`) and `stdio` (`php public/index.php --transport=stdio`, or `make run-stdio`).
- **Configuration:** env vars and their code defaults are in [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).
- When you add or move a `REQ-*`, a capability class, or its test, update [`docs/traceability.yaml`](docs/traceability.yaml) in the same change, or `spec-check` fails.

### CHANGELOG style

Keep `## [Unreleased]` entries **short and high-level**: one-line bullets naming the artefact class and scope. Do not enumerate individual files, classes, or audit details (those belong in commit messages and PR bodies). Aim for one sentence with at most one short parenthetical example list; match the terseness of the `0.19.0`-and-earlier entries; no stacked enumerations or multi-clause bullets.

### Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with a scope, e.g. `feat(tools):`, `fix(resources):`, `docs:`.

### Versioning

- SemVer; `APP_VERSION` in `src/constants.php` is the single source, history is in `CHANGELOG.md`. Never restate the current version here.
- Tags are bare **`X.Y.Z`** (for example `0.20.0`), no `v` prefix; each has a GitHub release titled with the tag name. Pushing any tag runs `release.yml`, which builds and pushes the Docker image to GHCR.
- Release housekeeping (README version badge) is in [`CONTRIBUTING.md`](CONTRIBUTING.md#branching-and-versioning).

### Branching

Feature branches off `main` plus pull requests (naming in [`CONTRIBUTING.md`](CONTRIBUTING.md#branching-and-versioning)). CI (`pr-validation.yml`) validates pull requests and main/feature/fix pushes. Main delivery runs only after its validation succeeds. After a push run `scripts/watch-ci.sh <full-sha>` and resolve every failed workflow before reporting completion.

## Gotchas

- **Discovery cache:** after adding or renaming a capability class without bumping `APP_VERSION`, clear the cache or the capability does not register. Detail in [`docs/development.md`](docs/development.md#gotcha-mcp-discovery-cache).
- **DNS rebinding:** the `streamable-http` transport (SDK 0.6 and later) accepts only hosts in `MCP_ALLOWED_HOSTS` (loopback by default); set it to the reverse-proxy host / public domain when deployed behind a proxy.

## Learned User Preferences

- When updating guides under `resources/guides/`, prefer substantive improvements that add value; avoid trivial or small changes that do not improve the guidelines.
- Guide content is consumed by AI agents: keep it short, concise, and scannable.
- Do not flag or recommend `APP_VERSION` bumps during code-review tasks: version bumping is a manual action the maintainer invokes explicitly; leave it out of review findings.

## Learned Workspace Facts

- Repo tooling that can be implemented in PHP should live as classes in `src/` with CLI entrypoints (e.g. `scripts/*.php`) and `composer.json` script entries; update AGENTS.md and related docs when changing such tooling.

## FHIR fork boundary

This repository is the openEHR and FHIR Modeller fork. Original openEHR behaviour
remains available. FHIR implementation is under `fhir/`, `src/Domain/Fhir`,
`src/Integrations/Fhir`, `src/Application/FhirModelling.php` and `FhirTools`.
Keep publication/distribution in the existing HYQ-FHIR-Governance-Platform.
Git engineering artefacts target `CzarMich/fhir_ig`; modeller code targets
`CzarMich/openehr_FHIR_Modeller`. Deploy only Dev until explicitly promoted.
Use exact FHIR release/package versions and authoritative HL7/package source
content. Compilation, validator results and clinical approval are separate.
See `docs/FHIR_DEV.md` and ADR-0026. Never add generated patient records from a
runtime server to model context or an artefact repository.

Shared Dev delivery runs through `.github/workflows/deploy-dev.yml` after exact
main validation; see [`docs/FHIR_DEV_DELIVERY.md`](docs/FHIR_DEV_DELIVERY.md).
Build images on GitHub-hosted runners and deploy digests on the marked local Dev
host. Preserve existing project volumes, UID1000 app data and identity issuers.
Deployment orchestration uses host Bash/Python scripts under `scripts/`; its
offline boundary checks must pass before changing this delivery path. Never
restore the inherited VPS workflow or build application images on shared Dev.
