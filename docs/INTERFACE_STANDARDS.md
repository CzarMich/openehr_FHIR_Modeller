# Interface standards

openEHR Modeller uses a shared visual contract across the modelling workspace and the integration workspace. Modelling includes chat, models, FHIR, AQL, governance, help and role-gated accounts. Integration keeps the project → exact models → mapping and confirmation → private source → run/channel workflow visible, followed by monitoring and shared access.

## Navigation and operation

Use the **Modelling** and **Integration** workspace links to switch workspaces. The selected workspace has a visible background and an `aria-current="page"` marker. Integration has direct links to each workflow section; these navigate without submitting forms or changing approvals. On narrow screens, these links wrap above the content. Keyboard users can skip to the main content.

Primary blue buttons identify the main action within a section. Secondary outlined buttons inspect, refresh, cancel or navigate existing work. Revocation and ownership transfers have labelled red outlined controls. Colours supplement the action text; a visual style never establishes permission or confirmation. Model inspection, explicit acknowledgement and a human comment remain required for exact mapping confirmation. Mapping confirmation, clinical approval and authorised delivery remain separate decisions.

Routine supported settings stay in their existing protected UI. A connection shown in a catalogue is not necessarily executable or installation-qualified. This interface update does not add source drivers, general profile forms or new permissions.

## Shared implementation

[`design-system.css`](../public/chat/design-system.css) owns the colour, font, spacing, border, radius and control tokens and the shared workspace switcher. It loads after layout-specific styles on both pages. Keep workspace layouts in their existing stylesheets; use shared `--ui-*` variables for new visuals. The browser server explicitly serves the shared asset. Do not introduce a separate component framework or build tool for these native HTML/JavaScript views.

Use semantic labels, headings, links for navigation and buttons for actions. Keep form controls and standalone navigation links at least 44 pixels high, preserve visible keyboard focus and avoid conveying status solely by colour. Code/model content retains a monospace font. The main canvas, cards and editable fields have distinct backgrounds. Existing dynamic status text remains a polite live region. Respect reduced motion and keep the optional Leticia guide dismissible. When Leticia is hidden, a **Show Leticia** button stays in the bottom-right corner on both workspaces, including after a reload. The button restores her tips and keyboard focus. Use plain sentences in interface guidance rather than dash-heavy asides.

Do not send patient data, credentials or private job results into chat to render interface guidance. Shared monitoring continues to exclude private rows and operational rights.

## Verification

Run `npm --prefix chat run test:browser`. The browser suite checks desktop and phone layouts, keyboard navigation, shared control styles, real asset serving, WCAG AA automated checks and the existing exact-model confirmation and channel sharing workflows using synthetic fixtures. Automated checks supplement manual review; they are not accessibility certification. Use the [testing guide](testing.md) for release gates.
