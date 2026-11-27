# Development

The application is C#/.NET 10. The browser backend remains Node 22; private standards engines retain their Java/Node toolchains. Use the pinned SDK container in the [Makefile](../Makefile) for compilation and tests. Application images are built on hosted CI, never shared Dev or production.

## Local checks

`make install` restores locked application/worker dependencies and installs browser test dependencies. `make compile` compiles the services without building images. `make unit` runs synthetic application, deterministic mapping/delivery and source-plan checks. `make spec-check` verifies requirement/path/ADR drift; `python3 scripts/spec-check.py --render` updates the derived matrix. `make browser` runs the browser-backend tests. Use `npm --prefix chat run test:browser` after installing the pinned Playwright browser dependencies when changing browser workflows.

`make ci` combines the functional local checks. Hosted [PR validation](../.github/workflows/pr-validation.yml) additionally verifies packaged primary/independent runtimes, actual terminology HTTPS fixture compatibility, standards-engine acceptance and browser flows. `make build` requests hosted image validation for the current branch through the existing authenticated GitHub CLI. This verifies images; delivery is a separate exact-main workflow.

Security scans and attack/load testing are deferred at the user's request. Functional permission, confirmation, read-only and data-integrity checks continue. Do not describe the deferred checks as passed. Never run source-write probes on a real clinical database.

## Running prebuilt images

`make env` creates installer defaults without overwriting existing settings. Set the intended prebuilt images and private installation configuration. `make up` or `make up-dev` starts those images without a local image build. Existing volumes are retained. The development overlay mounts resource content without masking installed application binaries. C# changes require a newly built image; changing a source mount does not compile a running service.

The application listens on HTTP port 9000 behind ingress; the browser backend uses 8350. Public TLS belongs to the approved gateway. `make run-stdio` runs the installed primary MCP in standard-I/O mode. HTTP Host/Origin and identity rules remain in effect on their respective transports; an API key is a service identity, not a human approver.

For shared Dev use the [validated delivery procedure](FHIR_DEV_DELIVERY.md), not local Compose builds. Production promotion targets `hygeoniq-prod` through the existing GitOps path; `amcdr-vps` is the edge. Preserve data, stable issuer identifiers, secrets and rollback digests. See [production delivery](FHIR_PRODUCTION_DELIVERY.md).

## Working safely

Use only synthetic records in generic MCP and provider tests. Keep source profiles separate from internal audit storage. Clinical/source databases are read-only without an override. Patient records and private processing output do not belong in model repositories, chat, reusable project memory or CI artifacts.

Retrieve exact models, dictionaries and standards rather than guessing clinical meaning. Prefer [existing work and checkpoints](REUSE_AND_LEARNING.md) before generation. Update [requirements and traceability](traceability.md) with behavioural changes and retain explicit implementation/qualification limits.
