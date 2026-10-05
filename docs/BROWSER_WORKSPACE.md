# Browser modelling workspace

Open the deployment's main URL to use a single workspace with **Chat**, **Models**, **Governance** and **Help** tabs. No additional browser window, embedded iframe or model-provider account is required for navigation and review. Conversational chat uses the configured optional provider adapter. All tabs share the verified browser identity and one sign-out action.

The interface uses an openEHR blue, white and slate palette with system sans-serif typography, responsive layouts, visible keyboard focus, labelled forms and status messages. Tabs support arrow keys, Home and End, skipping unavailable tabs; the skip link goes directly to the workspace. Mobile navigation keeps the tabs accessible. Motion respects the browser's reduced-motion preference.

## Built-in user guide

**Help** and **User guide** open the same guide inside the workspace, including before sign-in. Plain-language steps cover getting started, document uploads and extraction limits, personal CKMs and Git repositories, confirmed saves, model review, sharing and common problems. Contextual links beside connections, uploads and sharing open the relevant topic. Topic links such as `/chat/#help-files` can be bookmarked; switching to Help preserves the current conversation and unsent message. Users do not need GitHub to read the guide.

## Work with models

The Models tab lists projects in the deployment's configured repository and filters their artifacts by name or category. Selecting an artifact retrieves the listed exact revision, shows its source as text, and displays its revision, content hash and metadata. Source markup is never executed as HTML.

**Discuss in chat** keeps the selected revision and prepares a message in the existing conversation. Review the message before sending it. **Open governance** selects the same project for review. Switching tabs retains the conversation, draft message and selected model in memory; normal conversation history remains available after reload. Source changes are refreshed explicitly. If a listed revision disappears, refresh the list rather than silently replacing it with a newer model.

Model browsing uses fixed read-only repository operations over MCP. The browser cannot choose an arbitrary tool, endpoint, tenant or repository credential. Requests require the existing session, have bounded concurrency/deadlines, and return summaries for project lists. This deployment's repository can be shared across its authorized browser users, as in chat; this UI does not introduce per-project membership or native identity administration. Governance separately enforces each signed user's assigned review roles.

## Review and decide

Governance shows exact source, validation evidence and immutable audit history. A decision requires an explicit confirmation containing the revision and observed audit sequence. A stale source, stale decision sequence or changed validation evidence must be reviewed again. Clinical approval requires the installed qualified validation and an independent authorized human. Tab switching never turns chat/tool output into approval.

The former `/chat/` and `/chat/reviews` links remain compatible; the review URL opens the Governance tab. The MCP endpoint remains `/mcp`. Backend configuration remains documented in [browser chat](BROWSER_CHAT.md), [review deployment](REVIEW_DEPLOYMENT.md) and [storage/caching](POSTGRES_AND_CACHE.md).

## Verification

Run `npm --prefix chat test`, `npm --prefix chat run check:format`, and `npm --prefix chat run test:browser`. Automated axe checks cover detected WCAG A/AA violations in the primary desktop views; they supplement, rather than replace, manual accessibility review. Browser fixtures cover the common identity, exact-revision model browsing, escaping, chat/selection preservation, draft-write and review confirmations, mobile layout, keyboard tabs and recoverable repository errors. `scripts/test-review-workspace-container.sh` verifies the provider-independent production image and anonymous-access rejection. Screenshots and traces belong with test evidence rather than the user guide.

With the native engine configured, ask chat to validate an ADL 2 template or compile it into OPT 2. The `template_compile` call computes an output; saving a repository build through `template_compile_project` asks for confirmation of the exact input revisions. [Formats and build evidence](OPT_COMPILATION.md).

The Models tab reads immutable originals alongside ordinary model revisions. Text is displayed safely; binary originals show a byte count and can be downloaded using **Download source**. Downloads preserve original bytes and filenames in the same workspace. Chat supports [source uploads, personal CKMs and repositories, and revocable sharing](BROWSER_CHAT.md#personal-workspace). These chat sources are separate from the enterprise [manual model-import tools](MODEL_IMPORTS.md); native model editing remains separate work.
