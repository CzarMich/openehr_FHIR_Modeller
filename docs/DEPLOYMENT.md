# Deployment

Application images are built on hosted CI and deployed by immutable digest. The application is C#/.NET 10 over internal HTTP 9000, the browser backend uses Node on 8350, and private standards engines retain their own ports/runtime. The root Dockerfile includes independent application, ingress, development and inspector targets. Never assume a checkout's capabilities identify the currently deployed images.

For the existing environments follow [Dev delivery](FHIR_DEV_DELIVERY.md) and [production promotion/rollback](FHIR_PRODUCTION_DELIVERY.md). Production workloads run in the existing RKE2 namespace on `hygeoniq-prod`; `amcdr-vps` remains the public HTTPS edge. Do not restore an application deployment onto the edge host or build on either shared host.

## Upgrade invariants

- Promote the exact successful Dev image cohort; retain rollback digests and runtime evidence.
- Match ingress/upstreams, HTTP probes and any runtime mounts to the new application image atomically.
- Preserve PVC identities, filesystem/Git model revisions, audit bytes/hash chains, private browser/processing stores and source originals.
- Preserve stable identity issuer strings, users, subject/tenant derivation, MFA/session encryption keys and protected review keys. Display branding is independent of identity.
- Keep source credentials, application storage and destination authorisation separate. No source database migration/write is permitted.
- Verify health, MCP, human confirmation, private processing and destination permissions after deployment. A running pod alone does not establish clinical correctness.

The [configuration guide](CONFIGURATION.md) describes current installation controls; [settings/UI requirements](WORKSPACE_ACCESS_AND_SETTINGS.md) identify pending routine configuration forms. Operator files/environment remain staging/installation mechanisms where a form has not yet been implemented. Do not claim all configuration is UI-managed until those controls are verified.

Keep HTTPS trust verification enabled and credentials in protected mounts/stores. SDK compilation/tests may run in the pinned Dev container; application-image builds belong on hosted runners. Functional permission, read-only and integrity checks remain part of release verification. The user's deferred vulnerability/attack scans must be reported as deferred, not passed.
