# Contributing

Use a focused feature/fix branch and a pull request. Follow [agent/developer rules](AGENTS.md), [engineering conventions](docs/conventions.md) and the [authorised execution policy](docs/AUTONOMOUS_EXECUTION_POLICY.md). The product is maintained by Michael Anywar under MIT; retain upstream notices, contributor history and third-party model credits.

Before generating new work, inspect current artifacts, requirements and available deterministic reuse. Clinical meaning needs actual models, dictionaries and user guidance. No patient records, credentials or source-database writes belong in contribution/test workflows. Human confirmation, clinical approval and publication remain distinct.

## Change checklist

- Explain the concrete problem and resulting behaviour.
- Update current requirements, implementation/test paths, relevant architecture/ADRs and user documentation.
- Run `make ci` and affected browser/adapter/standards checks. Verify actual behaviour and preserve the limits of synthetic evidence.
- Run `python3 scripts/spec-check.py --render` after changing the source index. Keep requirement IDs stable.
- Keep Unreleased changelog bullets short and high-level.
- Use conventional commits such as `feat(mapping):`, `fix(terminology):` and `docs:`.

C# compilation/tests use the pinned SDK container. Application images are built only on hosted CI. Shared Dev and production receive immutable verified images; never build applications there. Dedicated security scans/attack testing are currently deferred by the user. Functional authorisation, confirmation, integrity and read-only checks still apply.

## Branching and versioning

Use feature branches off current `main`, submit a PR, and resolve exact-head CI failures before merging. `VERSION` is the release version source. The changelog records release behaviour; documentation should not duplicate a drifting current version. Release tags are bare SemVer (`X.Y.Z`), with a GitHub release titled by the tag. Do not create a tag merely to trigger an unverified production build.

Dev delivery requires successful exact-main validation and hosted-built image digests. Production promotes the verified cohort through the infrastructure GitOps repository to `hygeoniq-prod`; `amcdr-vps` supplies the public edge. Preserve PVCs, users, identity issuer strings, secrets, approval evidence and rollback images. The user has authorised the current product upgrade; routine delivery/recovery does not require repeated permission questions. See [delivery and rollback](docs/FHIR_PRODUCTION_DELIVERY.md).
