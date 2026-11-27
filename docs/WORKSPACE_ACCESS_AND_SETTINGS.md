# Shared channel groups, teams and UI configuration

This document records the required product design and acceptance gates for shared operations. It is not a claim that all sharing/settings controls are already delivered. The current private file runtime isolates jobs/channels by owner; shared access must be implemented and tested without silently widening that boundary.

The working product name is **openEHR Modeller**, with clinical discovery, mapping and integration as its scope. Visible branding can change without renaming persistent namespaces, repository URLs, identity issuers, signing/encryption keys or existing accounts.

## Channel groups and ownership

A channel group is a named operational collection, for example laboratory interfaces, hospital admissions or a programme's outbound FHIR feeds. It contains channel assignments and has explicit owners. A verified modeller who creates a group can add registered users or approved teams to view or monitor it. Group membership is an access grant, not a clinical approval or source/destination credential grant.

Teams are reusable groups of registered people. Their membership managers and changes must be visible and audited. Attaching a team to a channel group deliberately delegates the corresponding access to its current members. Cross-organisation or cross-tenant sharing must remain blocked unless a separately verified organisation policy explicitly permits it.

| Permission | Intended access |
|---|---|
| View | Channel definitions, mapping version/reference and approved non-patient metadata. Actual model content still requires its own project/model permission. |
| Monitor | Health, run status, counts, checkpoints and safe redacted error codes. No credentials, record bodies, private filenames, exports or quarantine content. |
| Edit | Draft channel settings and mapping proposals within the user's project rights. Changes still require the normal exact-version confirmations. |
| Operate | Explicit start/pause/stop/retry actions for authorised channels using confirmed mappings and approved connections. Does not grant editing or clinical approval. |
| Manage group | Membership and channel organisation within delegated authority. Prevent removal of the last owner and provide audited ownership transfer/recovery. |
| Patient-level results | A separate sensitive-data permission and sharing decision. View/monitor membership never implies this access. Existing private results stay private by default. |

Keep view/monitor sharing easy. More powerful grants require the corresponding project, operational and connection permissions. A group owner cannot create a clinical approver by editing membership, approve their own model, disable source read-only enforcement, or grant destination delivery merely by sharing a channel.

Enforce every permission on the server. Recheck membership on each read or action; hiding a button is not access control. Avoid durable bearer links for clinical monitoring. Revocation must stop subsequent access, and active monitoring streams must reauthorise or close. Audit who changed access, the affected resource, before/after grants, sequence and time without logging patient records or secrets.

## Existing channels and private data

Do not automatically move or expose existing owner-private jobs, uploaded sources, exports or quarantine during the sharing upgrade. The owner explicitly attaches a channel to a group and chooses the allowed monitoring scope. Shared monitoring must return an allowlisted summary rather than the full private report.

Source and destination credentials remain separately authorised. Shared operation requires an explicit connection-use policy; a monitor never receives a credential. Channel assignments continue to pin exact confirmed mapping/model versions. Sharing does not cause channels to adopt new drafts or reinterpret user narratives.

Removing a channel from a group and stopping a channel are different operations and must be clearly labelled. Recovery, interruption, retry and unknown delivery outcomes remain visible and auditable. Changing settings must not silently resume a paused channel or rerun a clinical delivery.

## UI-first configuration after installation

Routine product administration belongs in the authenticated UI. Users should not need SSH, JSON files, environment edits or pod restarts to configure normal modelling and integration work once the platform and required drivers are installed.

The administration workspace should provide:

- Source connections, including explicit database/platform/API type, profile testing, read-only verification and connector qualification status.
- Terminology server connections, version/policy choices and permitted disclosure of codes/reference information.
- Authorised FHIR destinations, supported operations, credential-use grants, rate/retry policy and validation requirements.
- Projects, FHIR releases/packages, supplied openEHR templates/StructureDefinitions, narrative-guided mappings and exact-version confirmation.
- Channel groups, teams, membership, ownership and operational permissions.
- Private job/channel monitoring, safe failure summaries and separately authorised results/reconciliation.
- Identity/account administration, personal/provider connections, access reviews and audit history.
- Retention, storage limits, operational concurrency and appearance within operator-approved limits.

Use structured forms with sensible defaults and an optional advanced view. Explain unavailable connectors and failed checks beside the relevant control. Do not add decorative controls that cannot perform the advertised operation. Never offer a clinical database write toggle, TLS-verification bypass, arbitrary SQL execution or arbitrary executable-driver upload.

Secrets are submitted over authenticated HTTPS and stored encrypted/protected by the server. Subsequent reads return only safe metadata and secret-presence indicators. Credential replacement, test, revocation and audit are separate actions; raw secrets must not appear in logs, model artifacts, MCP results, URLs or browser storage.

Persist settings in the platform's own protected store, never a clinical/source database. Apply validated versions atomically with concurrency checks. Running jobs use an explicit configuration snapshot; connection revocation or a material policy change must prevent unauthorised future work. Preserve a recovery path for administrators without exposing a general bypass.

Initial installation still establishes the server, HTTPS/trust, protected root keys, initial owner and approved driver/runtime capabilities. Those installation trust boundaries do not justify leaving routine connection and channel configuration in backend files. Existing file/environment setup instructions describe staging/current implementation until the corresponding UI setting becomes authoritative; they must not be presented as the final user workflow.

## Acceptance before release

Test at least two users plus an unauthorised user, team membership changes, revocation, ownership transfer, cross-tenant denial, project rights, safe monitor summaries, patient-data denial and separate operational permissions. Verify server-side denials directly, not only through hidden UI buttons.

Test configuration persistence/restart, concurrent edits, failed validation, secret redaction/encryption and changes while a channel is active. Browser tests must cover the full path from choosing a source through confirmed mapping, channel grouping, member access, monitoring and controlled destination delivery. Verify that account identity, old private data, confirmation evidence and persistent volumes survive the upgrade.

See [architecture](ARCHITECTURE.md), [security/privacy](SECURITY.md), [source jobs](SOURCE_CONNECTORS.md), [read-only source policy](CLINICAL_DATA_READ_ONLY.md), [identity](IDENTITY_AND_ACCESS.md) and [integration operations](INTEGRATION_ENGINE.md).
