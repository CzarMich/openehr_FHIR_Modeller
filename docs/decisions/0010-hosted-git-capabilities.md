# ADR-0010: Hosted Git capabilities beside generic Git storage

Status: Accepted. Requirements: REQ-F12, REQ-N11.

## Context

The platform already stores native model files using Git and must add hosted repository metadata and review requests without duplicating storage logic or coupling modelling services to a provider SDK. Native OIDC partitions repository access by authenticated tenant.

## Decision

Keep `GitModelRepository` as the storage implementation for `git`, `github` and `gitlab`. Inject an optional domain `HostedRepositoryProvider`, implemented by bounded HTTPS GitHub/GitLab adapters. `Application/RepositoryService` owns transport-independent operations and write authorization; MCP is a thin presentation adapter. Derive provider repository identifiers from the tenant-scoped remote. Discover only that configured repository. Account-wide discovery could expose repositories through a service token shared across tenants.

Create draft reviews and reuse existing open requests without changing their state. Never equate hosted approval/merge state with authenticated clinical approval. Preserve generic offline Git. Use administrator-pinned origins, TLS verification, no redirects, encoded path segments and redacted upstream errors. Provider tokens and SSH transport credentials remain separate deployment concerns.

## Consequences

Existing storage contracts, revision checks and native layouts remain intact. GitHub/GitLab-specific behavior is limited to hosting capabilities and their API tests. A deployment chooses its active branch; creating a branch does not silently move other users' workspace. Full OAuth installation management, webhooks, merges and release automation are separate capabilities. The live GitHub test uses a disposable synthetic draft; GitLab live acceptance requires credentials and is recorded separately from contract tests.
