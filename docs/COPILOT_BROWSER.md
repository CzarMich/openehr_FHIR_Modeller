# Copilot Studio in the browser

The platform supports two Microsoft integration routes:

| Route | Where you work | Connection |
|---|---|---|
| Copilot Studio uses modelling tools | Your published Microsoft-channel agent | Remote MCP; see [Microsoft agent integration](MICROSOFT_AGENT_INTEGRATION.md) |
| Copilot Studio supplies browser replies | This workspace's Chat and AQL editor | Microsoft user sign-in, published-agent API and a workspace client tool |

The second route keeps uploads, project organisation, personal repositories, exact-change confirmations, version history and model-based AQL drafting in this UI. It connects a **published Copilot Studio agent**, not GitHub Copilot or a generic Microsoft Copilot account. An organisation must provide agent access, the required Copilot Studio capacity/licensing and an approved Entra application. No Microsoft model dependency is added to the PHP MCP core.

## Setup in the UI

**Help → Copilot Studio in this browser** contains the full instructions before sign-in, a copyable client-tool definition and copyable agent instructions. Users do not need GitHub to set up the connection.

### Administrator: Microsoft access

1. Register a single-tenant Entra application. Record its Directory (tenant) ID and Application (client) ID.
2. Add the **Power Platform API → delegated CopilotStudio.Copilots.Invoke** permission and grant the consent required by the tenant.
3. Enable **Authentication → Advanced settings → Allow public client flows** for device-code sign-in. This integration does not require a client secret or redirect URI. Conditional Access and tenant restrictions still apply; never disable organisation safeguards to circumvent a blocked flow.
4. Share the published agent with the intended users. Copy its **Settings → Advanced → Metadata → Environment ID** and **Schema name**.

The browser connection currently supports the commercial Microsoft cloud. Tenant policies that disallow device-code sign-in require an organisation-approved arrangement; this implementation does not silently fall back to application-wide credentials or anonymous access.

### Agent maker: browser tool

Create a dedicated browser agent with Topics, generative orchestration and Microsoft authentication. Open **Topics → System → Conversation Start → … → Open code editor**. Paste the complete topic from the in-app guide and save it. Its `SetVariable` action registers `OpenEhrWorkspace` through Microsoft’s `System.ClientPluginActions` mechanism. The adapter emits the start event before sending the workspace conversation:

- Inputs: `operation`, `tool`, `argumentsJson` (strings).
- Operations: `list` returns this session's available tools; `describe` returns one tool's input schema; `call` executes that tool with a JSON object encoded in `argumentsJson`.
- Outputs: `resultJson` (string) and `succeeded` (boolean).

Add the guide's agent instructions and **publish**. Use `request_user_choice` for clickable choices. Enable the agent's file-upload capability and a compatible image-capable model for PNG/JPG interpretation. The workspace sends only its prepared, metadata-free images. PDFs, spreadsheets and other extracted sources remain available through the profile-scoped `attachment_read` tool.

Do not attach patient-data knowledge sources or CDR connectors to the browser agent. Keep direct MCP and other external action connectors on a separately configured Microsoft-channel agent. Such connectors execute outside this application's controls; a browser cannot approve or constrain actions taken directly by Microsoft's agent configuration. The browser agent should use `OpenEhrWorkspace` for workspace actions. The existing [MCP onboarding route](MICROSOFT_AGENT_INTEGRATION.md) remains available for Microsoft-hosted channels.

### User: connect and verify

1. Sign in to the workspace. Open **Chat settings (gear) → My AI connections → Copilot Studio**.
2. Enter the tenant ID, application ID, environment ID and agent schema name.
3. Select **Connect Copilot Studio**, open the displayed Microsoft sign-in link and enter the displayed code. Complete Microsoft sign-in with the authorised organisation account.
4. Wait for **Connected**. The server verifies access to the published agent before storing the connection.
5. Select **Test workspace tools**. The test must execute a synthetic client tool and report **Published agent and workspace tools verified**. An agent merely claiming success does not pass.
6. Choose **Copilot Studio** in the assistant selector and start a new conversation. Existing conversations keep their original assistant. The same selection can draft AQL directly into the AQL editor.

If the tool test fails, check the exact client action name, its input/output fields, instructions and publication. If sign-in fails, check tenant/app IDs, delegated permission, consent, public-client settings, agent sharing and tenant policies. Disconnect before changing the connected agent. A connected account can be disconnected from the same settings panel.

## Security and operating boundaries

- MSAL acquires delegated user tokens; its cache is encrypted using the existing provider store, bound to the verified workspace identity and provider. No tokens, refresh tokens or client credentials enter chat, browser storage, assistant inputs or tool output. Status exposes only the four non-secret connection settings.
- Each turn resolves only that user's connection. Token refresh is serialised per profile; disconnect cancels pending sign-in and active work and prevents late refresh from restoring deleted credentials. Microsoft account consent/revocation remains managed in Microsoft.
- Only fixed Microsoft identity endpoints and SDK-derived commercial Power Platform endpoints are used. User input cannot supply an arbitrary authority, token endpoint or agent URL. Redirects and automatic POST replay are refused. Diagnostic output is suppressed; responses and activity counts are bounded.
- The Agents SDK runs in a private worker because its streaming API does not accept a caller's AbortSignal. Stop, provider disconnection and turn timeout terminate that worker, closing upstream streams. Already completed external operations cannot be undone by cancellation.
- Native client-tool events route through the current turn's allowlisted tools. Arbitrary prose is never executed. Duplicate events cannot repeat a write; distinct events can share a parent reply ID. Personal-repository ownership, selected destinations, optimistic concurrency and exact-change confirmations use the same code as the other browser providers.
- AQL drafting gets only model metadata/paths and its isolated instruction set. Its two tools are `model_paths` and `submit_aql`; the assistant cannot execute CDR queries, retrieve results, saved queries or query history. The connection test exposes a single synthetic tool and no MCP/CDR access.
- Each turn starts a fresh Microsoft conversation with bounded workspace text history, source-tool results and prepared images. These inputs are sent to Microsoft under the organisation's agent and retention policies. Deleting a local chat does not claim to erase Microsoft's retained data. Model labels, uploaded sources and user text remain untrusted inputs; users must not paste patient results into prompts.
- Text replies and workspace choices are supported. Arbitrary Adaptive Cards, connector OAuth cards and sovereign-cloud endpoints are not rendered/supported by this adapter. An unsupported card-only response fails explicitly with guidance.

## Verification

`chat/test/copilot.test.mjs` exercises real SDK SSE parsing with an isolated transport fixture, event/reply correlation, duplicate suppression, input bounds, worker cancellation, prepared images, encrypted account isolation, token refresh and failed/disconnected sign-in. `security.test.mjs` covers authenticated/CSRF-protected routes and the actual-tool requirement for the connection test. `aql-drafting.test.mjs` exercises Copilot's model-only draft path and rejected CDR access. `browser.spec.mjs` covers settings, Microsoft code display, connection testing, assistant selection and in-app guidance.

These are synthetic integration tests, not a claim of acceptance in a customer Microsoft tenant. Real tenant acceptance is the UI sign-in and tool test above; it requires that organisation's application, published agent and user consent.

## Microsoft references

Reviewed 2026-10-03: [custom browser/native agent integration](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-integrate-web-or-native-app-m365-agents-sdk), [client tools and event responses](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-send-event-activities#using-client-tools), [Agents SDK source](https://github.com/microsoft/Agents-for-js/tree/main/packages/agents-copilotstudio-client), [MSAL device-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-acquire-token-device-code-flow). Dependencies are pinned in `chat/package-lock.json`.
