# ADR-0032: Vendor sources and protected private capture

- Status: Proposed
- Requirements: REQ-F35, REQ-F45

## Decision

Separate source-driver execution from deterministic mapping. Use a C# private extractor with native SQL Server, Oracle, PostgreSQL and MySQL/MariaDB providers, a checksum-pinned installed HANA ODBC driver and approved Epic/FHIR/BW/REST read adapters. Do not infer vendor schemas or expose patient rows through MCP. Source metadata tools remain read-only and bounded.

Use encrypted owner/project-scoped browser profiles and explicit fresh human review of immutable source plans. Bind plans to configuration, schema and extractor runtime. Credentials and cursor values stay private. Require actual TLS and effective read-only permission verification; no source DML/DDL/procedure or permission repair operation exists.

Publish source intake only after a complete bounded snapshot/page chain. Preserve encrypted original API pages and durable manifests. Optional append-only capture requires an explicit committed-key contract and a unique numeric root key. Preserve cursor JSON exactly and advance only after durable capture. Do not pretend a sequence column establishes commit order or captures updates/deletions.

## Consequences

Actual licensed clients, source credentials, dictionaries and installation acceptance remain necessary. Generic fixture success cannot qualify a hospital, Epic community member or HANA installation. Source read approval does not approve target models, clinical meaning or destination delivery. Existing identities, approvals, held data and volumes are preserved during deployment.
