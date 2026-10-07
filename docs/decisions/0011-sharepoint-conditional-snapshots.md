# ADR-0011: Conditional SharePoint project snapshots

Status: Accepted. Requirements: REQ-F12, REQ-N11.

## Context

SharePoint must implement the same logical repository contract without assuming an undocumented compare-and-swap guarantee on file-content PUT. Microsoft Graph explicitly documents ETag-conditional updates for list fields and uniqueness constraints for indexed columns. A drive item's writable description is limited to OneDrive Personal and is unsuitable as a SharePoint pointer.

## Decision

Extract the existing filesystem revision/history rules into `SnapshotRepository`, over a `SnapshotStore` transaction boundary. Preserve filesystem locks, atomic rename and the existing file layout. The SharePoint store uploads a new immutable candidate file, then conditionally changes one project pointer row using `If-Match`. A unique indexed project key protects concurrent creation. Read the exact referenced file, verify folder/project identity and its SHA-256 digest, and preserve historical artifact revisions and deletion tombstones.

Keep outbound OAuth credentials behind `AccessTokenProvider`. Pin Graph and token origins in deployment configuration. Follow a content-download redirect only to an explicitly configured HTTPS host, without Graph credentials or cookies. Bound pagination to the original collection path and origin. Map OIDC platform tenants to distinct lists and folders before repository construction.

## Consequences

Model services share storage-independent revision semantics. Native SharePoint document versions are not substituted for application artifact revisions. Uploads and pointer updates cannot form one Graph transaction; failed candidates may remain orphaned, and ambiguous outcomes require rereading. Never delete candidates automatically after a timeout. Dedicated resource permissions, site retention and tested backups remain deployment responsibilities.

Snapshots include retained history, so project size and traversal are explicitly bounded; there is no silent truncation or claim of unlimited enterprise capacity. Large-library indexing and incremental storage remain performance-phase work. The integration fixture exercises strict TLS, OAuth, real MCP calls and credential-free redirects, but live Microsoft tenant acceptance requires external credentials. The repository option is implemented independently of that acceptance gate.
