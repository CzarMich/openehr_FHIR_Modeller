# ADR-0023: Immutable original bytes and protected import receipts

Status: Accepted

## Context

Externally supplied model files can contain proprietary extensions, unknown fields, differing encodings or invalid syntax. Re-serialization destroys source evidence. Git sidecar metadata is editable by other repository clients and cannot establish an authenticated importer. Storage and audit databases are independent systems.

## Decision

Add an `OriginalRepository` port beside the existing model contract. Store a create-only `originals/<id>/<filename>` namespace with native raw Git blobs or byte-preserving snapshot envelopes. Normal draft saves/deletes cannot mutate originals. Binary data has an explicit base64 response envelope; text-only modelling services reject it explicitly.

Use a bounded content-marker inspector, keeping declared type and unverified source claims separate from parsing and conformance. Proprietary Designer JSON is preserved without claiming a conversion. Never infer external origin from a filename. The import application service takes its principal from the verified transport, not tool input.

Record an idempotent import intent in the existing protected audit ledger, save the original, then record its exact revision/hash in a storage receipt. Retry can complete a failed receipt after verifying source bytes. There is no distributed-transaction claim. Source metadata is a navigation aid; the ledger is authoritative. Provenance reads verify pinned and current original revisions.

Filter audit subject queries by first-event type before pagination using backend-specific JSON extraction within the shared store. This requires no migration or historical event rewriting. Governance accepts only registration streams. Import receipts cannot act as clinical approval or validation evidence.

## Consequences

Persistent imports require the enabled audit backend and model-write permission; read-only classification remains available independently. The shared API-key/browser MCP principal remains a service identity. Hosted external-tool automation, working-copy derivation, semantic comparison, retrospective migration and release synchronisation remain separate capabilities.

Application-level immutability does not prevent an independently authorized Git client or root storage administrator from editing files. Exact-revision/hash verification detects ordinary external tampering; branch protection and repository/ledger backups remain operational controls.

Verification: original repository contracts across filesystem/Git/SharePoint, raw Git byte checks, interrupted-receipt recovery, forged-claim and namespace negatives, SQLite/PostgreSQL stream filtering, actual MCP acceptance and binary browser downloads. See [manual imports](../MODEL_IMPORTS.md).
