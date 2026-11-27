# .NET runtime and compatibility

Application/domain logic is implemented in C#/.NET 10. The browser backend remains Node, and specialised Java/Node services provide openEHR and FHIR compilation/validation. The product does not require a particular language-model provider. Dependency versions and transitive packages are locked and audited.

This guide describes the source-tree runtime and compatibility contracts. It does not identify the image currently running in an environment. Verify the exact deployed revision/digests and acceptance evidence through the [delivery procedure](FHIR_PRODUCTION_DELIVERY.md).

## Application surfaces

| Surface | Implementation and verification boundary |
|---|---|
| Primary modelling MCP | `Modeller.Mcp` full-application mode adapts shared services. Captured tool/resource/prompt contracts and byte-preserved resources are checked over HTTP. Source discovery adds explicit, separately tested contracts. |
| Human review REST API | Purpose/request-bound assertions, verified identity and role/project permissions, persistent replay nonces and exact source revisions. Ordinary MCP credentials cannot approve as humans. |
| Source discovery | Explicit database/platform selection jobs. Native SQL Server metadata discovery is tested against an isolated SQL Server 2022; other listed connectors remain gated until implemented and qualified. |
| Model repositories | Filesystem snapshots, native Git history/layout and SharePoint conditional immutable snapshots. Preserve revisions, original bytes and provider-specific concurrency semantics. Live provider acceptance is separate from local domain tests. |
| Standards operations | Retained installed compilers/validators; exact source, dependency and output hashes. Unsupported/missing stages remain explicit. Technical results do not establish clinical approval. |
| Private integration | Separate versioned registry, model/rule confirmation, file-source worker, channels, quarantine/export and controlled FHIR delivery. See [integration operations](INTEGRATION_ENGINE.md). |
| Browser/provider connections | Existing Node workspace and human identity adapters. Patient data remains outside model-provider conversations. |

## Preserved data and identity

Do not reset model, governance, browser, CDR or engine volumes during a runtime upgrade. Preserve stable human identity issuers, subject/tenant derivation, account stores, encryption/signing keys and access configuration. A local issuer string is a stable identity identifier, not an endpoint to rewrite during deployment.

Filesystem snapshots retain their project/artifact/history envelope and original bytes. Git retains native source files, metadata and commit revisions. The protected audit reader validates existing event bytes and hash chains rather than rewriting history. Original import identities and receipts retain their established serialization rules. Conditional writes must reject stale revisions.

The private integration registry has its own model/mapping confirmation records. Other model-review or supplied-model selection identifiers do not automatically authorise private processing. Re-provide/pin and confirm exact models in the registry used by the operational channel. API-key workspaces are shared service-principal workspaces; browser sign-in alone does not establish per-user repository isolation.

## Runtime boundaries

`Modeller.Core` and the file-processing worker do not depend on database drivers. Clinical-source adapters live separately from internal audit storage. SQL Server source discovery is metadata-only, uses operator-protected profiles and cannot be used to select an internal audit database for unrestricted operations.

The primary application uses HTTP internally. Ingress and Kubernetes health/readiness probes must match that protocol and preserve Host allowlisting. Application images run as UID/GID 1000 for existing volume ownership. The ingress, browser, application and standards engines remain an immutable release cohort.

## Verification and release gates

Run application-domain, contract, authentication, source-schema, actual standards-engine and private processing/delivery acceptance checks. Source database write-denial tests run only on disposable synthetic fixtures. Use provider fixtures for external adapters; a synthetic catalogue or mocked response does not prove acceptance against a hospital installation.

Build application images on hosted CI. Verify on shared Dev, promote exact successful image digests to `hygeoniq-prod`, and verify through the `amcdr-vps` HTTPS edge. Preserve persistent resource identities and secrets. A partial implementation or passing subset must not be described as full runtime parity or a completed production upgrade.
