# Baseline audit

Baseline revision: `600db3ecb4d5fe3e865393dc4fb976715e475fbe` from
[CzarMich/openehr-assistant-mcp](https://github.com/CzarMich/openehr-assistant-mcp).
Audited before architecture changes. Execution: 2026-09-26.

## Architecture and inventory

PHP 8.4; official `mcp/sdk` 0.7.0; attribute discovery of tools, resources,
prompts and completion providers. `public/index.php` builds a DI container,
loads bundled instructions, caches discovery by application version and stores
MCP sessions on disk. Streamable HTTP (PHP-FPM/Caddy) and stdio are implemented.
The original advertised protocol is 2025-03-26; product version is 0.20.0.

### tools

`ckm_archetype_search`, `ckm_archetype_get`, `ckm_template_search`, `ckm_template_get`, `guide_search`, `guide_get`, `guide_adl_idiom_lookup`, `type_specification_search`, `type_specification_get`, `examples_search`, `examples_get`, `terminology_resolve`

### prompts

`explain_aql`, `translate_archetype_language`, `explain_template`, `design_or_review_archetype`, `type_specification_explorer`, `explain_archetype`, `terminology_explorer`, `design_or_review_aql`, `fix_adl_syntax`, `design_or_review_simplified_format`, `explain_simplified_format`, `guide_explorer`, `design_or_review_template`, `ckm_explorer`

### resources

`openehr://guides/{category}/{name}`, `openehr://spec/type/{component}/{name}`, `openehr://terminology`, `openehr://examples/{kind}/{name}`

Guides and examples also register concrete resources dynamically. There are
66 guides (including specification digests), 424 BMM files, 24 examples,
14 prompt bodies plus shared policy, and bundled openEHR terminology XML.
There is no OET compiler, full ADL parser, AQL execution engine, persistent model
repository or external terminology adapter. Design/review functionality supplies
agent prompts and authoritative retrieval; it does not execute model reasoning.

## Dependencies and coupling

CKM uses Guzzle directly at configurable `CKM_API_BASE_URL`; there is no CKM
proxy. The CKM client accepts configurable TLS verification and timeouts.
The product icon points at Cadasto infrastructure. Compose image names, README,
install docs, plugin instructions, marketplace links and the website contract
advertise Cadasto services. PHP namespaces and Composer package name also carry
the upstream vendor. MIT copyright must remain; archived ADRs/plans and changelog
are historical records. All occurrences were searched, including hidden files.

`.claude/settings.json` enables maintainer plugins; `.claude/CLAUDE.md` points to
AGENTS.md and the marketplace. No unique modelling knowledge is in those files.
Domain knowledge already lives in `resources/`, not in a Claude runtime.
The GitHub Copilot instruction only points to AGENTS.md. No Cursor runtime exists.
No internal LLM client, Microsoft dependency or CDR dependency was found.

## Deployment and security

Multi-stage Docker build, non-root production PHP-FPM, Caddy ingress, development
Node/conformance and optional Inspector. Release workflow publishes to the active
GitHub repository's GHCR namespace; PR workflow runs spec-check, PHPStan,
PHPUnit and Docker build. No transport authentication or authorization exists.
Host checks are SDK-provided, but duplicate Host values are collapsed rather
than rejected. CORS defaults to no allowed origins. Debug logs include tool
arguments and response payloads. Exception messages may expose upstream URLs and
response bodies. Template identifiers are interpolated into CKM request paths.
External response sizes and request bodies are unbounded at application level.
XML terminology parsing has no explicit DTD rejection. Resource paths require
additional containment review. There is an FPM ping but no core readiness check.
No shell execution or LLM API calls occur in domain services.

## Baseline verification

Built unchanged `.docker/Dockerfile` development target as
`openehr-assistant-baseline:local`. Ran in Docker with the checkout mounted at `/app`:

```sh
composer install --no-interaction --no-progress
composer test
composer check:spec
composer check:phpstan
composer audit
```

PHPUnit: **536 passed, 2640 assertions, 0 failures, 0 skipped**.
Traceability: **PASS**. PHPStan level 8: **PASS**.
Dependency audit: **FAIL**, three advisories affecting two packages:
Guzzle CVE-2026-69246/CVE-2026-69245 (see exact audit log for identifiers) and
MCP SDK CVE-2026-53965. The audit log is the authoritative record.
[Raw output](evidence/baseline-tests.txt) and [surface inventory](evidence/baseline-surface.json).
No external Microsoft tenant test was performed. terminology server `/fhir/metadata`
returns HTTP 401 without credentials; browser routes redirect to login.
