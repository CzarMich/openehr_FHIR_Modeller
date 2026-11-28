# ADR-0033: Durable clinical integration

- Status: Accepted
- Date: 2026-11-28
- Requirements: REQ-F46

## Context

Continuous clinical channels need durable input identity, recoverable snapshots, explicit ordering and bounded resources. AQL lookup alone cannot make a lookup/create pair atomic. Unknown HTTP outcomes may already have committed. Reusing mapping results must not reuse human approval.

## Decision

Keep the Node session/orchestration boundary and C# domain/private workers. Use a durable SQLite channel inbox and fsynced admitted snapshots; never evict completed identities after a fixed count. Offer strict FIFO, dependency-aware sequential and bounded concurrent execution, with explicit heap, queue and retry limits. Clinical source databases remain read-only.

An isolated C# Kafka consumer pins cluster/topic identity, verifies TLS, reads committed records and never produces. Persist private records and exact decimal-string offsets before broker acknowledgment. Retained transport receipts make repeated fetches idempotent; delivery identity remains separate. Do not advertise distributed-group rebalancing or universal exactly-once delivery.

Use parameterised openEHR AQL and verified existing patient EHR identity. Permit creation only with installation-qualified deterministic composition UUIDs; permit newer-version updates only when authorised and protected by exact If-Match. Persist target write reservations and receipts; unknown mutations remain fenced until human reconciliation. Keep existing FHIR conditional-create semantics.

Cache deterministic mapping outputs by exact private context, while rechecking access, models, privacy, human confirmation and validation. Source/destination configuration belongs in the authenticated UI; secrets remain in purpose-bound encrypted vaults.

## Consequences

Strict FIFO may block behind a missing patient. Concurrent jobs may finish out of order. Disk quotas require operational retention; heap limits exclude native/validator memory. Kafka retention gaps and topic recreation require reconciliation. External destination writers and real CDR UUID/version behaviour require installation qualification. Synthetic acceptance and deferred security/load tests must be reported separately. See [operations](../INTEGRATION_ENGINE.md).
