# Patient data stays outside the modelling assistant

Connecting a CDR does **not** give the AI assistant access to its patient records. Query generation and validation operate on modelling artefacts. A person must press **Run query** in the authenticated AQL workspace to retrieve rows. This separation prevents model assistance from becoming a route for disclosing identifiable records to an AI provider.

## Enforced boundaries

| Route | What is allowed | Enforcement |
|---|---|---|
| Assistant tools | Inspect model fields, draft and validate AQL | Browser tool discovery omits execution/history/library reads; `WorkspaceTools.call` and `CdrClient.tool` reject attempts before network access |
| Direct MCP | Model operations | `CdrTools` returns `CDR_BROWSER_ONLY` for execution, history and saved-query reads, regardless of the requested query; even counts cannot be inferred through execution |
| Ask assistant in AQL | Model identifier, hash, field paths/types/labels and the new instruction | Dedicated `draftAql` session; exactly two tools, `model_paths` and `submit_aql`; server rejects extra fields; no chat history, existing query, parameter values, results or CDR connection details are supplied |
| Draft submission | Query text and null parameter placeholders; model identifier may populate `template_id` | Server validates against the same model before returning a draft to the sole editor; provider prose is never treated as an accepted query; no execution tool or automatic Run |
| Human Run query | Bounded result rows in the user's browser | Authenticated browser session, CSRF protection, purpose/body-bound signed assertions, replay protection and human-actor result guard |
| Saved queries/history | User's query text and execution metadata | AES-256-GCM storage keyed by verified tenant and user; library/history filtered by CDR environment; central connection definitions do not change the owner |
| Result storage | Current browser results view | Result rows and parameter values are not persisted in query history or copied to chat; sign-out/reload clears the view; copying/exporting requires a user action |
| Model cache | Exact repository archetypes, templates and manifests | Encrypted profile/connection/revision-bound cache; upstream access checked even on hits; no query results or clinical execution data cached |

The Codex provider runs with shell, local-file, web, external plugins, apps and subagent capabilities disabled; CDR credentials and signing secrets are absent from its environment. The Claude provider receives only explicitly offered tools. Remote CDR errors are reduced to fixed safe codes, so an error body cannot reflect clinical data or credentials into a tool response. The new drafting session offers a still smaller tool set than general modelling chat.

## Repeatable evidence

These checks use synthetic markers, never real patient records:

| Test | Evidence |
|---|---|
| `chat/test/cdr.test.mjs` | Execution, history and saved-query reads are rejected before CDR or shared MCP transport calls |
| `tests/Enterprise/CdrWorkspaceTest.php` | Direct MCP denial makes zero adapter calls; result/parameter markers never enter persisted state; two users and two tenants cannot read the same saved query; central CDR libraries and history remain environment-scoped |
| `chat/test/aql-drafting.test.mjs` | Only two drafting tools are available; attempts to execute/read data are denied; extra query/result/history fields and patient-specific parameter values are rejected; unvalidated prose is not accepted |
| `chat/test/security.test.mjs` | Draft endpoint rejects unauthenticated and missing-CSRF requests, keeps the signed-in identity, rejects result injection and creates no chat transcript |
| `chat/test/browser.spec.mjs` | A synthetic existing-query literal, parameter and returned result are absent from the assistant draft request; the accepted query appears directly in the AQL editor |
| `chat/test/codex.test.mjs` | Provider runtime tool restrictions and controlled dynamic-tool dispatch |
| `tests/Enterprise/CdrApiTest.php`, `scripts/test-cdr-container.sh` | Signed request purpose/body/identity and replay checks; TLS, bounded execution, cancellation and redacted transport errors |

Run `make ci`, `npm --prefix chat test`, `npm --prefix chat run test:browser`, and `scripts/test-cdr-container.sh`. CI runs these checks on pull requests. The release-specific form, cache and privacy acceptance record is in [workbench evidence](evidence/workbench-go-live.json).

## Scope and limits

This is an enforced boundary around **connected CDR access**, not a promise to detect every patient identifier in arbitrary text. A user can deliberately put patient information in a chat, attachment, modelling artefact or drafting instruction; that content can be sent to the connected provider. The UI explains this distinction and asks users to keep modelling inputs free of identifiable patient information. Browser exports and copies leave the workspace under the user's control.

Saved query literals and names can themselves identify people. That is why AI reads of the entire saved-query library are blocked, even though query results are not stored. Prefer named parameters. Saved queries are encrypted but remain readable by their owning user; old unassigned queries are preserved rather than attached to an arbitrary central server.

These tests substantiate the implemented data flow. They are not an external security certification, a clinical approval or a guarantee against a compromised user browser/server. Deployment access control, provider account policy and organisational data handling remain separate responsibilities.
