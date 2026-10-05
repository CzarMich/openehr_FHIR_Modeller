# Traceability Matrix

> Part of the [Specification-Driven Development docs](README.md). This is the
> backbone of the SDD chain: every requirement traces forward to the code that
> implements it, the test that verifies it, and the decision that shaped it —
> and every component traces back to a requirement.
>
> **This table is the human-readable rendering.** The machine-checked source of
> truth for REQ→artefact links is [traceability.yaml](traceability.yaml),
> validated against the tree by `make spec-check` on every PR
> ([ADR-0006](decisions/0006-machine-checked-traceability.md)). Keep the two in
> step: the requirement id set here, in `traceability.yaml`, and in
> [requirements.md](requirements.md) must match, or the gate fails.

## How to keep this current

When you change behaviour, walk the chain in order:

1. **Requirement** — add/edit a `REQ-#` in [requirements.md](requirements.md).
2. **Design** — reflect it in [architecture.md](architecture.md) and, if it is
   architecturally significant, an [ADR](decisions/).
3. **Code** — implement under `src/`.
4. **Test** — add/extend the mirrored `*Test`.
5. **Matrix** — add or update the row(s) below.

A row whose Test column is empty is a coverage gap; a `src/` class absent from
the Implementation column is either dead code or an undocumented requirement.

## Requirements → implementation → tests → decisions

| REQ | Requirement (short) | Implementation | Test(s) | ADR |
|-----|---------------------|----------------|---------|-----|
| **REQ-F1** | CKM archetype/template search & get | `src/Tools/CkmService.php`, `src/Apis/CkmClient.php` | `tests/Tools/CkmServiceTest.php`, `tests/Clients/CkmClientTest.php`, `tests/Tools/CkmServiceUpstreamShapeTest.php` | 0002 |
| **REQ-F2** | Guide discovery / retrieval / ADL idioms | `src/Tools/GuideService.php`, `src/Resources/Guides.php`, `src/Helpers/SearchTokenizer.php` | `tests/Tools/GuideServiceTest.php`, `tests/Resources/GuidesTest.php`, `tests/Tools/SearchEnvelopeTotalTest.php` | — |
| **REQ-F3** | Curated examples search & get | `src/Tools/ExamplesService.php`, `src/Resources/Examples.php`, `src/Helpers/SearchTokenizer.php` | `tests/Tools/ExamplesServiceTest.php`, `tests/Resources/ExamplesTest.php`, `tests/Tools/SearchEnvelopeTotalTest.php` | — |
| **REQ-F4** | Terminology resolution | `src/Tools/TerminologyService.php`, `src/Resources/Terminologies.php`, `src/Helpers/TerminologyXmlLoader.php` | `tests/Tools/TerminologyServiceTest.php`, `tests/Resources/TerminologiesTest.php` | — |
| **REQ-F5** | Type specification lookup (BMM) | `src/Tools/TypeSpecificationService.php`, `src/Resources/TypeSpecifications.php` | `tests/Tools/TypeSpecificationServiceTest.php`, `tests/Resources/TypeSpecificationsTest.php`, `tests/Resources/SpecDigestsTest.php` | 0005 |
| **REQ-F6** | Guided MCP prompts (14) | `src/Prompts/*.php` (extend `AbstractPrompt`) | `tests/Prompts/*Test.php`, `tests/Prompts/AbstractPromptTest.php`, `tests/Prompts/PromptArgumentSubstitutionTest.php` | 0003 |
| **REQ-F7** | Resource exposure via `openehr://` URIs | `src/Resources/*.php` | `tests/Resources/*Test.php` | — |
| **REQ-F8** | Argument auto-completion | `src/CompletionProviders/{Examples,Guides,SpecificationComponents}.php` | `tests/CompletionProviders/{GuidesTest,SpecificationComponentsTest}.php` | — |
| **REQ-F9** | Dual transport (http / stdio) | `public/index.php`, `src/Helpers/CliOptions.php` | (covered via startup / conformance) | 0001 |
| **REQ-F10** | Global server instructions | `resources/server-instructions.md` | `tests/Prompts/PromptPolicySeparationTest.php` | 0003 |
| **REQ-N1** | Authoritative spec retrieval | `resources/guides/howto/spec-lookup.md`, content under `resources/` | `tests/Content/SpecLookupAndReadmeClaimsTest.php` + content review | 0005 |
| **REQ-N2** | Test mirror + mocked HTTP | all `tests/`, `CkmClient` mocking | whole suite (`composer test`) | 0002 |
| **REQ-N3** | PSR-12 + PHPStan | `phpstan.*`, CS config | `composer check:phpstan` | — |
| **REQ-N4** | Cached discovery / fast startup | `public/index.php` (Symfony Cache), `src/constants.php` | `tests/Content/DiscoveryCacheNamespaceTest.php` + startup | 0001 |
| **REQ-N5** | Docker-only runtime | `.docker/`, `Makefile` | CI / `make` targets | 0004 |
| **REQ-N6** | MCP conformance | `make conformance`, `node` service | `tests/conformance-baseline.yml` | — |
| **REQ-N7** | Concise AI-facing content | guide/prompt bodies, policy split | `tests/Prompts/PromptCompositionTest.php` | 0003 |
| **REQ-N8** | Machine-checked traceability drift gate | `src/Sdd/SpecCheck.php`, `scripts/spec-check.php` | `tests/Sdd/SpecCheckTest.php` | 0006 |
| **REQ-N9** | Published MCP tool schemas validated in CI | `src/Tools/*.php` (`#[Schema]` / `outputSchema`) | `tests/Tools/{InputSchemaGuardTest,InputSchemaValidationTest,OutputSchemaConformanceTest,SearchEnvelopeTotalTest}.php`, `tests/Helpers/OutputSchemaValidatorTest.php` | — |
| **REQ-N10** | Install docs canonical and externally consumable | `docs/install.md` | `tests/Content/InstallDocContractTest.php` | 0007 |

## Guard tests (cross-cutting invariants)

| Test | Invariant guarded | REQ |
|------|-------------------|-----|
| `tests/Prompts/PromptCompositionTest.php` | Prompt size stays within baselines (`tests/fixtures/prompt_lengths_before_shared.json`) | REQ-N7 |
| `tests/Prompts/PromptPolicySeparationTest.php` | Full global policy lives only in `server-instructions.md`, not duplicated in individual task-specific prompt files (see the `shared/policy.md` resilience exception in [ADR-0003](decisions/0003-prompt-policy-split.md)) | REQ-F10, REQ-N7 |

> The near 1:1 `src/` ↔ `tests/` mirror means most traceability links already
> exist in the tree; this matrix makes the requirement layer explicit on top of
> them.

## Modelling platform extensions

| Requirement | Implementation | Tests |
|---|---|---|
| REQ-F11 | Configurable branding and named CKM sources (landed) | `tests/Enterprise/ConfigurationAndAuthTest.php` |
| REQ-F12 | Filesystem/Git/SharePoint persistence and hosted Git draft reviews (landed) | `tests/Enterprise/RepositoryAndGovernanceTest.php`, `tests/Enterprise/GitRepositoryTest.php`, `tests/Enterprise/HostedRepositoryTest.php`, `tests/Enterprise/SharePointRepositoryTest.php` |
| REQ-F13 | Draft OET generation, bounded validation and structural diff (partial) | `tests/Enterprise/ModelValidationTest.php` |
| REQ-F14 | Explicit terminology, value sets, bindings, provenance and diff (partial) | `tests/Enterprise/TerminologyProviderTest.php` |
| REQ-N11 | Authenticated bounded transport, native OIDC and redacted failures (landed); [ADR-0009](decisions/0009-native-identity-and-tenant-boundaries.md) | `tests/Enterprise/ConfigurationAndAuthTest.php`, `tests/Enterprise/OidcAuthenticationTest.php`, `scripts/oidc-smoke.py` |
| REQ-N12 | Client-neutral deployment and truthful capability documentation (landed) | `tests/Content/InstallDocContractTest.php` |

## Browser chat

| REQ | Capability | Implementation | Verification |
|---|---|---|---|
| **REQ-F15** | Authenticated browser modelling chat | `chat/src/`, `public/chat/`, `chat/Dockerfile` | `chat/test/security.test.mjs`, `chat/test/codex.test.mjs`, `chat/test/browser.spec.mjs` |

| REQ-F16 | Persisted governance and interactive human review | `Application/ModelGovernance`, `Domain/Governance`, `Rest/ReviewApi` | `GovernanceAuditStoreTest`, `ModelGovernanceTest`, `InteractiveReviewAuthenticatorTest`, `ReviewApiTest`, browser review tests | ADR-0015 |

REQ-F17 connects the persistent project requirement graph to its domain/application/anchor adapters and repository/security contracts; see [requirements traceability](REQUIREMENTS_TRACEABILITY.md) and [ADR-0016](decisions/0016-versioned-requirements-graph-and-evidence-boundaries.md).

REQ-F18 maps staged document checks and exact-revision project QA to their shared services, storage/security contracts and negative tests; see [Validation and QA](VALIDATION_AND_QA.md) and [ADR-0017](decisions/0017-staged-document-validation-and-project-evidence-qa.md).

REQ-F19 maps CKM credentials/federation to its configuration, HTTP/domain/integration services, unit/schema checks and isolated HTTPS acceptance. See [CKM sources](CKM_SOURCES.md).

| REQ-F20 | MCP profile, negotiated clients and transport compatibility | HTTP/stdio product and pinned official probes | ADR-0019 |

| REQ-N13 | PostgreSQL audit storage and immutable-revision model cache | `src/Integrations/Governance`, `src/Integrations/Cache` | Storage configuration/unit contracts and `scripts/test-storage-container.sh` | ADR-0021 |

REQ-F21 maps the native engine boundary, compiler and project build evidence to their PHP, Java and actual MCP acceptance tests; see ADR-0020. The bounded legacy OET-to-OPT 1.4 compatibility profile and JSON transport regression are covered by ADR-0022 and the same container contract.

REQ-F22 links immutable external originals and protected import receipts to repository, audit, actual MCP and browser-download tests. See [ADR-0023](decisions/0023-immutable-originals-and-import-receipts.md) and the [workflow](MODEL_IMPORTS.md).

REQ-F23 links personal browser connections, attachment extraction and read-only sharing to isolated HTTP, parser, credential, revision and browser tests in `chat/test/personal-workspace.test.mjs` and `chat/test/browser.spec.mjs`. These tests use synthetic documents and mocked Git/CKM responses, not live user credentials.

REQ-F24 connects private CDR configuration, read-only execution, exact-template AQL checks and browser result handling to PHP service/authentication/contract tests, native path tests and browser privacy/cancellation tests. See [ADR-0024](decisions/0024-cdr-client-and-aql-workspace.md).

Repository-first designer source selection and deliberate CKM upgrades are covered under REQ-F23 by `TemplateAuthoringTest` and `chat/test/template-packages.test.mjs`; see [Artefact versions](ARTEFACT_VERSIONING.md).
