# ADR-0021: PostgreSQL governance and immutable model cache

Status: Accepted

## Context

The platform needs durable governance across application workers and faster repeated template retrieval. Existing SQLite ledgers contain hash-linked events that must survive migration unchanged. Git, filesystem and SharePoint remain valid model storage choices.

## Decision

Add PostgreSQL behind the existing AuditStore contract and share canonical encoding/integrity rules with SQLite. Use bounded transaction-scoped locks for compare-and-append and replay prevention, indexed tenant/project queries, explicit schema installation and a separate restricted runtime role. Preserve legacy SQLite compatibility and provide an offline atomic migration with full history comparison.

Use optional Valkey/Redis caching only for immutable model reads. Keys include the repository scope and authoritative revision/hash. Recheck repository state before cache lookup, authenticate cached JSON with a separate HMAC key, bound size/expiry and fall back on cache failure. Governance state, identities, permissions and clinical decisions remain uncached.

The browser service uses a separate, disposable AES-256-GCM disk cache for personal Git modelling artefacts. Its keys include profile, connection, credential fingerprint and immutable revision/object hash. Each operation rechecks upstream branch access before any hit; bounds are 24 hours, 256 MiB and 1,024 entries. This avoids repeated archetype downloads without requiring a shared cache service on small installations. Clinical query results, authorization decisions and governance remain outside both caches.

## Consequences

The recommended service stack uses PostgreSQL plus Valkey without requiring a search cluster merely to load templates. Cache eviction cannot lose a model or audit event. A shared audit database does not by itself make browser sessions or local Git working stores horizontally scalable. PostgreSQL recovery and model backup remain separate responsibilities; the cache is disposable. See [configuration, migration and repeatable acceptance](../POSTGRES_AND_CACHE.md).
