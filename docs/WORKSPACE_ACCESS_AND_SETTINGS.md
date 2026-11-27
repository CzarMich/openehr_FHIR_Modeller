# Shared channel groups, teams and UI configuration

This document distinguishes implemented shared monitoring from remaining product requirements. The feature branch provides browser-managed channel groups, reusable teams, view/monitor grants, immediate membership rechecks, revision conflicts and access history. Private processing jobs/channels remain owner-isolated. Shared editing, operation, patient-level results and general source/destination configuration forms are not delivered by this change. Production availability requires a release and deployment.

The working product name is **openEHR Modeller**, with clinical discovery, mapping and integration as its scope. Visible branding can change without renaming persistent namespaces, repository URLs, identity issuers, signing/encryption keys or existing accounts.

## Using the implemented group controls

In **Integration workspace → Shared channel groups**, select **Load / refresh groups**. A signed-in modeller can create a named channel group and a reusable team. Local active users appear in the sharing directory; federated users register their verified identity by opening the groups list. Sharing remains inside the verified identity issuer/organisation boundary. Use operational names without patient identifiers: shared names, project identifiers, mapping references and counts can themselves be sensitive metadata.

The group owner selects an owned channel and explicitly attaches it, then chooses **View** or **View and monitor** for each person or owned team and saves the grants. View returns the channel name, project, pinned mapping reference, mode and revision. Monitor adds allowlisted status, counts and a failure indicator. It does not expose the private filename, source/destination connection identifiers, free-text failure, record bodies, exports, quarantine, credentials or complete job reports. Monitor users have no start/pause or edit controls and gain no approval authority. Refresh retrieves current summaries; no patient-bearing monitoring stream or public bearer link is created.

Team membership is editable separately. A team grant deliberately follows its current members; removing a member or grant takes effect on the next read. If team ownership transfers, the group owner retains the ability to inspect/revoke its existing team grant. Group grants cannot appoint clinical approvers or bypass exact-version model/mapping confirmation.

Owners can inspect **Show access history** and transfer group/team ownership to another registered person. Every object always has one explicit owner; transferring removes the former owner's management rights. **Detach all channel assignments before transferring a channel group.** Private channel ownership is not transferred by group membership. Detaching removes sharing only and leaves the channel and private processing data intact. Shared editing/operation and private channel ownership transfer need separate authorisation and are pending.

Access metadata is stored in the platform's private `channel-access` directory outside model repositories and source databases. Atomic updates use a filesystem lock, current object revision, purpose-separated HMAC signatures and the existing protected review keyring. Key rotation requires retaining verification keys for stored records until re-signed; this feature does not request a new user key. Audit records retain membership/assignment before and after changes without job records or credentials. A persistent lock after an interrupted write requires operator recovery; automatic lock breaking and automatic audit deletion are not enabled. The store currently caps users at 2,000, groups/teams at 128 each per organisation, grants/members/assignments at 200/200/128, and audit history at 10,000 changes. Reaching a cap fails explicitly rather than silently dropping history or grants. A larger production governance store and a documented archival UI remain release work.

Signed-in humans use the browser session and CSRF protection. General MCP credentials cannot administer group membership. Browser writes require the configured fresh review-session age; viewing uses the ordinary session lifetime. Local authentication timestamps use Unix seconds in request-bound review assertions, matching federated authentication and the C# verifier.

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
