# Browser chat

Open `/chat/`, sign in to the modelling workspace, and open the **Chat settings** gear, then **AI connections**.
Use a private provider connection or a shared connection explicitly granted by the platform owner. Choose **Codex**, **Claude** or **Copilot Studio** before
starting a conversation; a conversation keeps that provider when reopened.

**Sign in** stays at the top right while signed out, including in Help, Models and
Governance. It reappears when a session expires; returning to the page and periodic
checks refresh the session state without reloading your unsent message.
The header is the primary sign-in control; the chat welcome area and composer do
not repeat sign-in prompts. Built-in account forms open in the workspace.

- **Codex:** select **Connect Codex**, open the displayed sign-in link and enter the
  one-time code. Complete sign-in with your ChatGPT account. Device-code access must
  be enabled for that account or organisation.
- **Claude:** enter an Anthropic API key. Claude API usage is billed separately from
  a Claude subscription. Subscription sign-in is not offered in this application.
- **Copilot Studio:** follow **Help → Copilot Studio in this browser**, enter your organisation’s four connection settings, sign in with Microsoft and run **Test workspace tools**. See [browser setup and boundaries](COPILOT_BROWSER.md).
- **Disconnect** removes that connection from the modelling service and stops its
  active responses. To revoke access at the provider too, use that provider's account
  settings. Signing out of the workspace leaves the saved connection available for
  your next sign-in.

Codex uses its [official app-server device flow](https://learn.chatgpt.com/docs/app-server).
Anthropic requires approval to offer Claude subscription sign-in in third-party
applications; its [supported integration](https://code.claude.com/docs/en/agent-sdk/overview)
uses API credentials. External Claude and Codex clients can independently use the
[same MCP endpoint](MCP_CLIENTS.md).

## Conversations

Ask to find an archetype, inspect a project, explain guidance, review a draft or plan
a template. For example: “List the CKM sources and find a blood pressure archetype.”
Replies stream into the conversation; activity badges show modelling-tool calls.
An animated progress ring shows when files are being read, a repository selection
is being saved, or the assistant is working. It pauses when your answer is needed.

Modelling questions can appear as clickable choices. Select one answer, or tick
several boxes and press **Use selected options** when multiple answers apply.
**Write another answer** lets you add your own wording; **Skip question** continues
without a selection. Submitted answers are saved in your conversation. Choosing an
option does not approve a repository write or a model for clinical use.
Questions expire after two minutes or when the response is explicitly stopped;
the assistant receives a skipped answer, never an assumed selection.
On phones, **Chat settings** opens AI connections, sources, the repository destination
and sharing controls. These fold away while the assistant replies.

Enter sends a message; Shift+Enter adds a line. **New conversation** starts another
topic or lets you select a different provider. Conversations are private to the
signed-in identity; the model repository can be shared with other authorised users.
Use **Project instructions** for persistent requirements and choose **Context for next message** to continue, start fresh or request independent review. Context is budgeted and reconstructed from project state; [task execution](TASK_EXECUTION.md) explains authority, recovery and limits.

Model writes require **Confirm save** for the exact proposed change. Cancelling or
stopping a response prevents further calls; a completed write stays in repository
history. Saving a draft does not approve or release a model. The **Models** and
**Governance** tabs work without a provider connection. See the
[workspace guide](BROWSER_WORKSPACE.md).

### Organise chats into projects

Use **Create project** in the sidebar to make a private folder (for example, Kidney
care). New conversations then belong to that project. Open a project's heading to
see its chats; **+ Chat** starts another conversation there. Use a chat's **Move to
a project** arrow to move an existing conversation or return it to **Unfiled chats**.
Projects can be renamed. **Delete** deletes only the folder: its conversations and
files stay available as unfiled chats. On phones, **Toggle conversations** opens
the sidebar controls. Empty folders stay available for later work.

Use **× (Delete conversation)** beside a chat to delete its messages and uploaded
files after confirmation. Other chats and the containing project are kept.

Chat projects organise history within your profile. Moving a chat into a project adopts
that project's repository and folder. Review the file moves, then press **Move chat and
artefacts** to commit them. Messages, provider connections and uploaded originals remain
in the workspace. Existing saved artefacts move together in one commit within the same
personal repository and branch; a different repository, an existing destination file or
changed source revision blocks the move. Future saves use the project's folder.
**Unfiled chats** keeps the current repository location. For older chats whose save paths
were not recorded, use **Include older saved artefacts** and enter each repository path.
The preview never infers paths from the assistant's prose. Up to 200 recorded artefacts can move at once (up to 50 older paths may be included explicitly). Shared package archetypes are copied so templates remaining in the source folder retain their dependencies. The **Models** tab continues to show repository modelling projects.

OET and ADL template saves include exact archetype inputs under `archetypes/` and a project-relative hash manifest under `data/json/template-packages/`, committed atomically with the template. Native compilation of those exact bytes must pass before confirmation. Stable current paths are versioned by default: changed content replaces the current file in a new Git commit, while identical content is reused. Exact Git blob pins keep older templates bound to their own archetype bytes, even when a shared current file changes. See [artefact versions](ARTEFACT_VERSIONING.md). Browser turns retain up to sixteen exact build input sets, encrypted and private to the profile and conversation, for thirty days (16 MiB cache; 64 dependencies and 6 MiB inputs per package). Changed or uncached templates require explicit dependency contents. The manifest records compilation scope and limitations; saving does not establish clinical approval. Import an OET together with its archetypes into other modelling tools.
Limits are 40 chat projects and the existing 100 conversations per profile. Chat
retention still applies inside projects. Project instructions, task records and archived drafts/packages outlive individual chats; [project-state retention](TASK_EXECUTION.md#persistence-and-privacy) is separate from chat retention.


Move previews expire after ten minutes and require a separate, owner-authenticated confirmation.
GitHub uses a [tree/commit](https://docs.github.com/en/rest/git/trees) followed by a
[non-forced branch update](https://docs.github.com/en/rest/git/refs); GitLab uses a
[batch commit](https://docs.gitlab.com/api/commits/) with exact file revisions. The chat destination updates only after the repository commit succeeds.
A persisted GitHub commit receipt lets a retry recover a lost response without committing again.

## Personal workspace

### Personal sources and repositories

Open the **Chat settings** gear in the top bar, then **My sources and repositories**, to add a CKM REST base URL or a GitHub/GitLab
repository URL. Connections and optional personal tokens belong only to your signed-in
profile; tokens are encrypted and never exposed to the assistant. An enterprise CKM
with the same normalized URL is reused without storing another connection. If the
enterprise catalogue is unavailable, retry before adding a CKM. Existing private
connections and repository setup remain usable independently.

Personal CKMs support the compatible CKM REST API with anonymous or bearer-token
access; enterprise CKMs retain their configured authentication methods. Ask the
assistant to search your personal CKMs or to browse/read a connected repository.
Searches return a bounded candidate window and preserve the source URL and CID.

Choose **Save artifacts to**, then press **Save repository selection** before requesting a save.
The choice remains inactive until confirmed by that button. The selected repository and
branch are saved with the conversation, including when it is first created. The URL,
branch and folder appear below the selector. Sending waits while a changed choice is saved;
if another tab changes the destination, the next message is rejected with its draft
text preserved and the current selection refreshed. **Enterprise repository** retains the existing
modelling workflow. A personal destination offers confirmed commits through
`personal_repository_save`, while enterprise write tools are omitted for that turn.
The personal save tool remains discoverable when writes are enabled; `personal_connections`
reports the exact selected destination, folder and any local setup blocker. Selecting a
repository and supplying a token are required before its write can proceed; hosted token
permissions are enforced by the Git provider. Safe, actionable tool errors reach both assistants
without forwarding raw provider failures. Old chat claims do not override current readiness.

Enter **Repository folder**, such as `AKI` or `Clinical/AKI`, or choose **Use project folder**,
then save the selection. The profile remembers the last saved destination for new unfiled chats.
Projects have a default repository and folder; creation derives the folder from the project name
unless a path is supplied. **Settings** changes defaults for future chats. Saving a destination
inside a project updates its defaults too; existing chats retain their own destinations until explicitly moved.
Renaming or deleting a project does not move or delete repository files. Destination metadata
is private to the owner and persists across restarts. Legacy projects gain a suggested folder;
existing conversations continue to use their original repository-root paths.

Within the selected folder, model types have separate locations: `archetypes/` for ADL
archetypes, `templates/oet/` for OETs, `templates/opt/` for OPTs, and `templates/adl/`
for `.adlt` templates. Moving a chat applies this structure to its saved artefacts.
Other supported outputs also have their own folders:

| File type | Folder under the selected project folder |
|---|---|
| AQL query | `queries/` |
| JSON (for example, web templates, terminology or example data) | `data/json/` |
| XML other than named OET/OPT files | `data/xml/` |
| CSV tables | `data/csv/` |
| Markdown notes and reports | `documents/markdown/` |
| Plain text | `documents/text/` |
| YAML/YML configuration | `config/yaml/` |

Purpose subfolders such as `requirements/`, `terminology/` and `validation/` are
preserved inside the file-type folder. These are possible outputs, not files
created for every task. Uploaded source documents keep their existing private
storage; these rules organise generated personal-repository artefacts.

**Saved artefacts** above the composer lists files from confirmed personal saves.
Open a file or use **Copy path** and **Copy link** for references. **Saved version**
and **Copy version link** appear when the provider returns a commit receipt; **Version history** opens the file history and the saved SHA-256 identifies its bytes. Those version
links identify the exact saved version. Current paths and links refresh after a
project move. Moving files preserves their contents: existing links embedded
inside documents are not rewritten. Use the current saved-file paths when
creating new supporting references. New save receipts retain the repository address and branch, so file links remain
available after disconnecting a provider connection. Credentials are never stored
in artefact references. Older entries without an address still show their saved path.

Personal saves require a full repository-relative path inside the selected folder, checked
before confirmation and again before writing. Traversal, hidden directories and writes to a
different destination are rejected. Sending also checks the saved folder so another tab cannot
silently retarget a request. The first successful file commit creates parent folders; no empty
folder or placeholder commit is needed. Successful saves return a file link and the GitHub commit
reference when the provider supplies it. In-app Help includes these steps and an AKI path example.

Confirmations display the destination, branch, path, full content and prior revision.
Existing files require their current revision; concurrent modifications fail without
overwriting them. Personal commits remain drafts and do not enter the enterprise
governance ledger. The **Models** and **Governance** tabs still browse enterprise data.

GitHub.com and GitLab (including self-hosted HTTPS installations) are supported;
arbitrary SSH remotes and other Git hosting APIs are not personal connectors. Create
the target repository and branch first. Use a repository-scoped token with GitHub
Contents write permission or GitLab API write access; SSO and branch protections
still apply. Public repositories can be read without a token. **Update access** fills
the connection form without revealing its token; **Save connection** replaces a supplied
repository token while retaining the connection ID and conversation selections.
Leaving the token empty preserves existing access. Add a separate connection for a different branch.
Enterprise CKM requests initialize MCP before calling tools; a discovery outage appears
only inside source settings, with a retry button. API contracts:
[GitHub contents](https://docs.github.com/en/rest/repos/contents),
[GitLab repository files](https://docs.gitlab.com/api/repository_files/).

### Source uploads

Select **+ (Add files and images)** inside the composer, drop files onto it, or paste a PNG/JPG image. File cards show upload progress, extraction status and image thumbnails. Typing remains available during uploads; sending waits until they finish. Select a thumbnail for a larger preview or × to remove a pending file. Sent attachments appear with their message and can be managed under **Files in this chat**. The original remains downloadable.

The chat service allows up to two minutes to receive a file on slower connections, with the same 10 MiB file limit. An interrupted connection shows a retry message. If the response was incomplete, reopen the conversation and check its files before uploading again. Your unsent instructions stay in the message box. Any additional proxy must also allow the intended upload duration.

The assistant receives source names, hashes and extraction status. It reads extracted text in bounded chunks through `attachment_read`. PNG/JPG images are supplied as actual image inputs to the selected provider connection (Copilot Studio also requires an image-capable published agent) on each subsequent turn while attached, including after reload. Images are not persisted as base64 in messages or shared snapshots. Cite/check the original publication, page, sheet or image when reviewing derived requirements; extraction and visual interpretation do not establish clinical validity.

PDF with selectable text, Excel XLS/XLSX/XLSB, ODS, DOCX, UTF-8/UTF-16 text, CSV, XML, JSON and other text formats are supported. Every format can be attached and downloaded as its original bytes. Unsupported binaries, scanned PDFs and damaged/password-protected documents report missing extraction. For a scanned publication, provide a text version or attach the relevant pages as PNG/JPG images. Images uploaded before vision support must be reattached. Formulas, macros, scripts and external document references are not executed.

Select several PDFs and spreadsheets together in the file picker. Each file is read
separately; check each card's status. Password-protected PDFs need an unlocked copy.
If a PDF cannot be read, export it again or attach the relevant pages as images.

Limits: 10 MiB per file, 10 files and 30 MiB per conversation. Extraction has a 20-second deadline and a 192 MiB JavaScript heap, with up to 240,000 text characters, 200 PDF pages, 30 sheets and 5,001 rows per sheet. A reached text limit reports partial extraction. Tool reads return 12,000 characters plus the next offset. The larger proxy limit applies only to upload endpoints.

PNG/JPG inputs are signature-checked and fully decoded in the isolated worker, limited to 20 million pixels and a single frame. A metadata-free, orientation-corrected JPEG copy is prepared at up to 2048 pixels per side and 2 MiB; larger or invalid inputs report failure and are not sent as images. Previews use an owner-authenticated endpoint with no caching. The same prepared bytes reach the provider: Codex uses explicit [`localImage` turn input](https://learn.chatgpt.com/docs/app-server#turns) with private temporary files removed on completion/cancellation; Claude uses [base64 image content blocks](https://platform.claude.com/docs/en/build-with-claude/vision). Layout, small print and visual details can be lost; users should crop unclear regions and verify against the unchanged original. Image-based diagnosis is outside the modelling workflow.

Originals, extracted text and prepared images belong to the conversation and are removed on file/chat deletion or its 30-day retention expiry. Removing a file excludes it from future image inputs but does not erase excerpts already quoted in messages or sent to a provider. Uploads are source evidence, separate from the immutable model-import/governance API.

### Sharing conversations

**Share chat** creates a snapshot of the current messages. Anyone authenticated in
the same workspace with its unguessable link can read it for seven days. Later
messages, uploaded originals, connection credentials and tool arguments are excluded;
source text already quoted in messages remains visible. Review messages before
creating a link. The viewer cannot continue or edit the owner's chat. **Revoke link**,
creating a replacement link, deleting the chat, or retention expiry invalidates access.
Signing out does not revoke an existing link.

**Help → Connect Copilot Studio** provides the server address, authentication header
and setup steps without leaving the workspace for GitHub documentation. A native
workspace administrator can explicitly retrieve and copy the configured MCP connection
key after sign-in and MFA. Retrieval is CSRF-protected, not cached and recorded in the
identity audit; ordinary users and model tools cannot retrieve it. The field is masked
and can be cleared. This is the deployment's existing MCP key, not a separately scoped
personal credential; rotating it is an administrator deployment operation.
Copilot Studio uses the [Microsoft MCP integration](MICROSOFT_AGENT_INTEGRATION.md).
An enterprise subscription alone does not configure the connection; tenant policy
and acceptance testing still apply. For Copilot Studio replies in this browser, use the separate [browser provider connection](COPILOT_BROWSER.md), available in the assistant selector alongside Codex and Claude.

## Deployment

1. Copy `.env.chat.example` to a protected file outside Git and set
   `MODELLING_CHAT_ENV_FILE` to that path.
2. Configure [OIDC or native workspace identity](IDENTITY_AND_ACCESS.md). For OIDC,
   register the exact callback `https://<host>/chat/auth/callback` with PKCE S256.
3. Set `CHAT_MCP_URL` and its service credential. Allow the internal hostname in
   `MCP_ALLOWED_HOSTS` when using Docker-internal HTTP.
4. Generate a separate encryption key with `openssl rand -hex 32` and store it as
   `CHAT_PROVIDER_ENCRYPTION_KEY`. Back it up separately from `chat-data`.
5. Set `MODELLING_BROWSER_TARGET=chat` and `CHAT_ENABLED=true`, then rebuild with
   `docker compose up -d --build --wait`.
6. Sign in, connect a personal provider and request a read-only tool call. A healthy
   container does not prove that an account can generate a reply.

The default `reviews` image supports model browsing and human review without the
Codex executable. The `chat` image adds the pinned Codex runtime. Claude uses the
pinned Anthropic SDK. The PHP MCP service remains independent of both.

The development override `deploy/compose.chat-dev.yml` adds the private CA and
identity routing. It needs `MODELLING_CHAT_ENV_FILE` and `MODELLING_CA_FILE`.
Certificate verification stays enabled.

### Migrating the shared-account deployment

Set the new encryption key before rebuilding an enabled chat service. The service
no longer reads `/run/secrets/codex-auth.json` or the shared `chat-codex` volume.
Existing conversations and model data remain intact; each user must connect their
own provider before continuing. Old conversations belong to Codex. The old credential
volume is left untouched by the upgrade and can be retired separately after migration.

## Continue after an interruption

A response continues on the server when its browser stream closes. Reopen the conversation to follow progress and recover any pending confirmation or choice. Use **Stop response** to stop deliberately. A server restart, provider failure or bounded time/tool limit leaves the latest saved message and completed modelling work available; select **Continue from saved progress** to start a new turn from that evidence.

Generated OET drafts, compiled outputs and proposed personal-repository file contents are retained privately before Git publication. **Artefacts and recovered drafts** offers downloads. The assistant sees a metadata inventory and can read historical tool results with `workspace_checkpoint_read`, or save exact bytes using `personal_repository_save` with `draftId`. It must still check the selected repository and current revision and obtain exact-change confirmation. Retention is not proof of a successful Git save. Failed or uncertain writes are never automatically replayed; read the current destination before retrying. Drafts produced before this feature may not be recoverable if their bytes were never retained.

Checkpoints use identity-and-conversation-bound AES-256-GCM storage, separate from message-only shared snapshots. They retain up to 16 drafts (2 MiB each), 40 successful modelling evidence records and 16 MiB total, with a 30-day lifetime; older evidence is evicted first. Deleting a chat removes its conversation checkpoints and dependency cache. Exact project drafts/packages and deterministic validation reports are also archived with project task records and remain available to other chats in that project; see [task persistence](TASK_EXECUTION.md#persistence-and-privacy). Only an explicit modelling/source-read allowlist enters evidence retention. CDR execution, patient results, credentials and live repository-read state never enter this recovery context. Tool results are historical, untrusted evidence, not instructions or current validation claims. Source uploads remain under their existing attachment limits.

Active users renew the workspace's one-hour inactivity expiry through a same-origin, CSRF-protected keepalive; an idle open tab does not renew it. Reauthentication is required after at most eight hours. Organisation sessions persist encrypted across service restarts, using the provider encryption key; local sessions already persist in the identity store. Logout and session revocation remain effective. Renewal does not change the original authentication timestamp used by CDR and governance freshness checks. Those operations may still require a fresh sign-in. Keep the chat volume and encryption keys stable across deployments.

The server saves partial responses every two seconds and after tool events. In-flight provider reasoning cannot be checkpointed; recovery reuses completed evidence and draft bytes in a new provider turn. Logs distinguish time limits, tool limits, user stops and provider/tool failures without recording prompts, credentials or patient data.

## Configuration

Configurable context/history/result budgets and session rotation settings are documented in [task execution configuration](TASK_EXECUTION.md#configuration-and-telemetry).

| Variable | Default | Purpose |
|---|---|---|
| `CHAT_ENABLED` | `false` | Enable authenticated chat |
| `CHAT_PUBLIC_URL` | `http://localhost:8350` | Exact origin; HTTPS except loopback development |
| `CHAT_OIDC_ISSUER`, `CHAT_OIDC_CLIENT_ID`, `CHAT_OIDC_CLIENT_SECRET` | empty | Workspace OIDC client |
| `CHAT_ALLOWED_GROUPS` | empty | Optional signed group allowlist |
| `CHAT_LOCAL_IDENTITY_ENABLED` | `false` | Enable native accounts; see [identity configuration](IDENTITY_AND_ACCESS.md) |
| `CHAT_SIGNUP_ENABLED` | `true` | Permit native self-registration after owner MFA setup; owner can close registration in Accounts |
| `CHAT_LOCAL_IDENTITY_ISSUER` | `<origin>/identity/local` | Stable native identity issuer |
| `CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY` | empty | Separate native TOTP encryption key |
| `CHAT_PROVIDER_ENCRYPTION_KEY` | empty | Required 32-byte hex key for personal provider credentials |
| `CHAT_MCP_URL` | `http://ingress:8343/mcp` | Fixed MCP endpoint |
| `CHAT_MCP_API_KEY`, `CHAT_MCP_API_KEY_HEADER` | empty, `X-API-Key` | Server-side MCP credential |
| `CHAT_ALLOW_WRITES` | `false` | Enable confirmed writes; enterprise saves also require MCP write permission |
| `CHAT_MODEL` | `gpt-6-sol` | Codex model |
| `CHAT_CLAUDE_MODEL` | `claude-sonnet-5-5` | Claude model available to the user's API account |
| `CHAT_TURN_TIMEOUT_SECONDS` | `1200` | Active turn work budget, bounded to 30–1800 seconds; browser confirmation/choice waits are excluded |
| `CHAT_DATA_DIR` | `/data/chat` | Private identity, conversations and encrypted connections |
| `CHAT_CODEX_WORK_DIR`, `CHAT_CODEX_BINARY` | `/workspace`, `codex` | Isolated working directory and executable |
| `CHAT_PORT` | `8350` | Internal HTTP port |
| `CHAT_PERSONAL_ALLOWED_HOSTS` | empty | Comma-separated exact internal HTTPS hostnames allowed for personal CKM/GitLab connections |

Review settings are documented in [review deployment](REVIEW_DEPLOYMENT.md).

## Privacy and limits

The selected provider receives bounded task context, relevant recent turns and selected tool results. Providers never receive the MCP service key. Credentials are encrypted using AES-256-GCM and bound to the
verified workspace identity and provider. They are never returned by status endpoints.
Codex receives a private temporary credential directory per operation, removed after
the process exits. Refreshed credentials cannot restore a disconnected account.
Shared provider fallback requires a current native-owner grant; public signup and ordinary administrator roles do not grant it.

Personal connection secrets use the same encryption key in a separate store and
authenticated namespace. Public HTTPS destinations are resolved and checked at the
socket boundary; local, private, link-local and reserved addresses are denied unless
an administrator lists the exact host in `CHAT_PERSONAL_ALLOWED_HOSTS`. Redirects are
never followed. Enterprise service credentials are never reused for personal URLs.
Each response is bounded to 4 MiB, with 20 connections per profile. Do not allow
metadata or administrative hosts. TLS verification remains enabled.

The browser and provider use the same tool allowlist, call limits and write-confirmation
path. Native shell, files, external plugins and agent delegation are disabled in Codex;
Claude receives only the declared modelling tools. The container has no Docker socket,
source checkout or model-storage mount.

Sessions use HttpOnly, SameSite cookies with Secure on HTTPS. Mutations require
same-origin requests and a session CSRF token. Limits include 100 conversations per
user, 80 messages per conversation, 8,000 characters per message, 64 tool calls per
turn and three simultaneous turns. A user can run one Codex turn at a time to avoid
refresh-token races. Up to three device sign-ins can run at once, each for ten minutes.

Conversation files expire after 30 days without activity. Backups have their own
retention. Protect `chat-data` and the encryption keys; restore them together.
This file-backed browser service supports one instance, not multiple replicas.

## Verification

```sh
npm ci --prefix chat
npm --prefix chat test
npm --prefix chat run check:format
npm --prefix chat run test:browser
```

Tests cover provider isolation and encryption, cancellation, tool results and errors,
write confirmation, sessions, CSRF, history, mobile layout and accessibility. Provider
fixtures use no live accounts. Live acceptance requires each user's sign-in or API
key; a simulated reply is not provider acceptance.

## AQL workspace

The sidebar AQL workspace uses browser identity independently of any assistant-provider connection. Configure private CDRs through the top-bar gear. Query results stay in the results view and are not sent to chat. See [AQL/CDR workflow and configuration](CDR_WORKSPACE.md).

GitHub save failures distinguish token permissions, expired credentials, protected branches and rate limits. A confirmed token/branch refusal is shown beside the private connection and blocks repeated save proposals until **Update access → Save connection** acknowledges the repair. A repository owner's account permissions do not prove that a fine-grained token has **Contents: Read and write**. Updating an existing token's GitHub permissions does not require re-entering it; saving the connection with a blank token preserves the credential and clears the previous failure. Remote error bodies and credentials are never displayed.

Template packages also save immutable, hash-named compiled OPTs in `templates/opt/` and Web Template JSON in `data/json/web-templates/` when supplied by the compiler. The package manifest links their exact hashes to the OET and archetypes. Previous compiled outputs remain unchanged. Files are bounded to 2 MiB each; a complete package is at most 68 files. See [form compatibility](LEGACY_OPT_COMPILATION.md) and [CDR patient-data boundary](PATIENT_DATA_BOUNDARY.md).


### Native accounts and shared connections

Native workspaces support self-registration only after the original platform owner completes MFA setup. New accounts have the modeller role, private chats, private connections and mandatory MFA. The owner can close registration in **Accounts** or the operator can set `CHAT_SIGNUP_ENABLED=false`. OIDC accounts continue to be managed by the external identity provider.

**Accounts** distinguishes the original owner from other administrators. Only that owner can grant **Use shared AI connections and repositories**, **Manage shared AI connections**, and **Manage shared repositories and sources**. Grants are explicit and revoke affected sessions. Administrators cannot reset, disable or change the roles of the owner or delegated shared-connection users. Owner identity persists across upgrades; no username implicitly grants ownership.

In the settings gear, authorised managers choose **My profile** or **Shared workspace**. Shared Codex uses an OpenAI project API key; Claude uses an API key; Copilot Studio uses the existing published-agent connection flow. Personal connections take precedence, with shared fallback only for authorised users. Shared API keys permit concurrent isolated Codex runtimes without token-refresh races. Public self-registration does not grant use of shared paid providers. See [Codex authentication](https://learn.chatgpt.com/docs/auth) for API-key billing and account requirements.

Shared repositories use a dedicated encrypted connection namespace. They are visible only to authorised users; private repository and chat records remain identity-bound. Files committed to a shared repository are visible to people with access to that repository. Sharing credentials does not make another user's workspace history visible. Existing installation-configured MCP repositories and CKMs retain their deployment-level access policy.

Five failed native sign-ins lock password sign-in. The response gives failed/remaining attempts and the same generic error for unknown usernames. Locks survive restarts and are not cleared by changing IP. A successful sign-in before lockout clears failures. A saved one-time recovery code can reset the password and authenticator, revoke all sessions and unlock sign-in; MFA enrollment then issues ten fresh codes. Recovery attempts are rate-limited. Administrators may instead issue a one-time recovery link through **Accounts**; no email is sent. The owner must retain recovery codes (or use the documented operator recovery command if all factors are lost). These controls apply to native accounts; an organisation provider manages its own recovery.


### Scan an authenticator QR code

During owner setup, registration, invitation acceptance or account recovery, choose **Add account → Scan QR code** in your authenticator app. Scan the displayed code and enter the app’s six-digit code in the workspace. On the same phone, choose **Open authenticator app**. Expand **Can’t scan? Enter the key manually** if needed, then save the recovery codes after verification.

The server generates the PNG locally at `/chat/auth/mfa-qr`, using only the signed-in pending-enrollment session. No external QR service receives the secret, and no secret is included in the image URL. Responses use `Cache-Control: no-store` and `Cross-Origin-Resource-Policy: same-origin`; anonymous, revoked and completed-enrollment sessions cannot retrieve a setup QR. Leaving enrollment clears its secret and image from the page. Existing accounts keep their authenticator unchanged. HTTP tests independently decode the PNG and use its secret to complete MFA; browser tests cover mobile layout, manual fallback, image failure and clearing setup secrets.

### Account window

Choose **Sign in** at the top right to open the account window without leaving your current workspace view. Sign in with your workspace credentials or **Use organisation account** when available. Choose **Create an account** there if registration is enabled, or **Forgot password or locked out?** for recovery. On a new installation, **Set up the platform owner** opens the one-time owner setup. Invitations and recovery links open their matching step automatically. The window also contains authenticator QR setup and recovery codes; acknowledge saving those codes before continuing. Close the window or press Escape to return to your workspace.
