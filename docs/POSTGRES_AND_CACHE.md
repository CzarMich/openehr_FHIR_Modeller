# Internal audit storage and model caching

This document concerns the platform's own modelling metadata. **Clinical/source databases are read-only and must never be selected as an audit/migration target.** Source driver profiles and internal governance storage are separate configuration paths.

## Preserving an existing audit store

The C# `AuditLedger` reads the established SQLite/PostgreSQL event envelope and exact stored JSON/hash-chain bytes. It verifies sequential event numbers, tenant/subject/project identities, previous hashes and content hashes. SQLite remains the default internal store; PostgreSQL is explicitly selected with protected internal credentials. An unavailable PostgreSQL store does not silently fall back to SQLite.

SQLite uses WAL, bounded lock waits, durable commits and immutable-event triggers. PostgreSQL uses the existing versioned governance schema, append-only event grants, immutable-event triggers and bounded transaction/lock timeouts. PostgreSQL schema installation is an explicit operator task with the installation owner identity, using [the schema](../deploy/postgres/001-governance.sql); ordinary application startup does not perform PostgreSQL schema migrations.

For a runtime upgrade preserve the current driver, store, keys and event bytes. Do not change identity issuers or rewrite approvals. Switching storage engines is a separate maintenance operation requiring stopped writers, a consistent backup, exact-byte import, verified counts/hash chains and rollback evidence. The installation-only C# command is `storage cutover` on the primary application entrypoint. It verifies/installs the shipped schema with the private owner identity, makes a consistent SQLite backup, checks complete source hash chains, imports exact event text/hashes and live replay nonces in one protected transaction, and verifies destination counts/chains. Repeating an identical import is idempotent; a conflict or divergent destination rolls back without rewriting history. The source and private backup remain intact. `storage verify` checks an existing store; `storage import-sqlite /absolute/internal-audit.sqlite` selects an explicit internal source. These commands are not exposed through HTTP/MCP and never accept a clinical source profile. The deployment helper stops the writer and supplies the one-off protected migration-owner credentials; do not use that owner identity for normal service operation.

## Model retrieval and task recovery

The browser's encrypted immutable model cache keys entries by identity, repository/connection, credential fingerprint, exact revision, kind and path. Source access is rechecked before cache use. Entries are bounded/expiring and can be evicted without losing authoritative models. Credentials, CDR queries/results, patient records and approval decisions are excluded. [Private checkpoints](TASK_EXECUTION.md) retain drafts and modelling evidence for interrupted tasks; current repository state and uncertain writes are checked again.

The current C# application does not use the former optional shared retrieval-cache service. Leaving an old cache container/configuration present does not establish that current model reads are accelerated by it. The browser model cache and the authoritative mapping registry are separate mechanisms.

[Exact-context mapping reuse](REUSE_AND_LEARNING.md) finds saved drafts or currently confirmed mappings without model-provider calls. It verifies current protected decisions rather than caching approval. Human corrections are versioned proposals and require confirmation. No cache or learned pattern grants clinical approval, source write access or destination delivery permission.

## Verification

Current application-domain tests verify immutable audit readback, concurrency, replay protection and integrity failures on disposable internal stores. `dotnet/tests/storage-contracts.py` verifies consistent backup/source retention, exact event bytes/hashes and replay nonces, repeated cutover, ordinary application readback, conflict rollback and durable PostgreSQL restart against disposable internal stores. Live storage switching still needs a controlled stopped-writer maintenance window and installation-specific rollback evidence. Historical storage evidence applies only to its recorded revision. Dedicated security/attack tests are deferred at the user's request; ordinary functional integrity and access checks continue.
