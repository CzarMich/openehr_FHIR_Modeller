const integration = document.body.classList.contains("integration-page");
const navigation = document.querySelector(integration ? ".workflow-nav" : ".sidebar");
const content = document.querySelector(integration ? "#integration-content" : "#workspace-content");
const tabs = [...navigation.querySelectorAll('[role="tab"]')];
const shortLabels = {
    "tab-chat": "Chat",
    "tab-models": "Models",
    "tab-fhir": "FHIR",
    "tab-mappings": "Mappings",
    "tab-aql": "AQL",
    "tab-governance": "Review",
    "tab-accounts": "Accounts",
    "tab-help": "Help",
};
if (!integration)
    for (const tab of tabs) {
        tab.setAttribute("aria-label", tab.textContent.trim());
        tab.dataset.shortLabel = shortLabels[tab.id] || tab.textContent.trim();
    }
const key = "modeller.workspace.layout.v1";
const defaults = { theme: "light", left: 236, right: 272, navigation: true, inspector: true };
let saved = {};
try {
    saved = JSON.parse(localStorage.getItem(key) || "{}");
} catch {
    /* Preferences never block the workspace. */
}
const state = { ...defaults, ...saved };
state.theme = state.theme === "dark" ? "dark" : "light";
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);
state.left = clamp(state.left, 200, 340, defaults.left);
state.right = clamp(state.right, 240, 400, defaults.right);
state.navigation = state.navigation !== false;
state.inspector = state.inspector !== false;
document.body.classList.add("application-workspace");
if (!navigation.id) navigation.id = "application-navigation";
if (integration) {
    const desktop = matchMedia("(min-width: 1101px)");
    const orientation = () =>
        navigation
            .querySelector('[role="tablist"]')
            .setAttribute("aria-orientation", desktop.matches ? "vertical" : "horizontal");
    desktop.addEventListener("change", orientation);
    orientation();
} else {
    const conversations = document.getElementById("conversations");
    if (conversations) conversations.tabIndex = 0;
}
const menu = document.createElement("nav");
menu.className = "application-menu";
menu.setAttribute("aria-label", "Application menu");
menu.innerHTML = `<details><summary>Project</summary><div class="application-menu-popup" data-project-menu></div></details>
<details><summary>Workspace</summary><div class="application-menu-popup" data-workspace-menu></div></details>
<details><summary>View</summary><div class="application-menu-popup">
<button type="button" data-shell-action="navigation">Navigation pane</button>
<button type="button" data-shell-action="inspector" class="inspector-menu-action">Context pane</button>
<div class="application-menu-label">Appearance</div>
<button type="button" data-shell-theme="light">Light theme</button><button type="button" data-shell-theme="dark">Dark theme</button>
<hr><button type="button" data-shell-action="reset">Reset workspace layout</button></div></details>
<details><summary>Help</summary><div class="application-menu-popup"><a href="/chat/#help">User guide</a><button type="button" data-shell-action="leticia">Show Leticia</button></div></details>
<span class="application-menu-location">${integration ? "Integration" : "Modelling"}</span>`;
if (integration) document.querySelector(".platform-header").after(menu);
else content.prepend(menu);
const pane = document.createElement("aside");
pane.id = "application-context";
pane.className = "application-inspector";
pane.setAttribute("aria-label", "Workspace context");
pane.innerHTML = `<header class="application-pane-heading"><span>Context</span><button type="button" aria-label="Hide context pane" title="Hide context pane">×</button></header>
<div class="application-inspector-content" tabindex="0"><div class="application-context-label">Current workspace</div><p class="application-context-title" data-context-title></p><p data-context-description></p>
<dl><dt>Project</dt><dd data-context-project>No project selected</dd></dl>
<div class="application-context-label">Go to</div><div class="application-context-links"></div>
<div class="application-context-policy"><strong>Clinical data boundary</strong><p>Source databases are read-only. Exact models and executable mappings require human confirmation.</p></div></div>`;
pane.querySelector("header button").onclick = () => {
    state.inspector = false;
    apply();
    menu.querySelector("summary").focus();
};
function action(label, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.onclick = () => {
        closeMenus();
        callback();
    };
    return button;
}
function select(tab) {
    if (!tab || tab.hidden) return;
    tab.click();
    tab.focus({ preventScroll: true });
    updateContext();
}
const projectMenu = menu.querySelector("[data-project-menu]");
projectMenu.append(
    action(integration ? "Choose project" : "Open model repository", () =>
        select(tabs.find((tab) => tab.id === (integration ? "tab-project" : "tab-models"))),
    ),
);
projectMenu.append(
    action("Create project", () => {
        if (integration) {
            select(tabs[0]);
            const details = document.querySelector("#project-step details");
            details.open = true;
            document.getElementById("project-id").focus();
        } else document.getElementById("new-project").click();
    }),
);
if (!integration)
    projectMenu.append(
        action("New conversation", () => {
            select(tabs.find((tab) => tab.id === "tab-chat"));
            document.getElementById("new-chat").click();
        }),
    );
function workspaceMenu() {
    const list = menu.querySelector("[data-workspace-menu]");
    list.replaceChildren();
    for (const tab of tabs.filter((item) => !item.hidden))
        list.append(action(tab.textContent.trim(), () => select(tab)));
    const other = document.createElement("a");
    other.href = integration ? "/chat/" : "/chat/integration/";
    other.textContent = integration ? "Open modelling workspace" : "Open integration workspace";
    list.append(other);
}
function closeMenus() {
    menu.querySelectorAll("details").forEach((details) => (details.open = false));
}
for (const details of menu.querySelectorAll("details"))
    details.addEventListener("toggle", () => {
        if (!details.open) return;
        for (const other of menu.querySelectorAll("details")) if (other !== details) other.open = false;
        workspaceMenu();
        const buttons = projectMenu.querySelectorAll("button");
        if (!integration) {
            buttons[1].disabled = document.getElementById("new-project").disabled;
            buttons[2].disabled = document.getElementById("new-chat").disabled;
        }
    });
menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        const open = menu.querySelector("details[open]");
        closeMenus();
        open?.querySelector("summary").focus();
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const open = event.target.closest("details[open]");
    if (!open) return;
    const items = [...open.querySelectorAll("button:not(:disabled), a")];
    const index = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index + items.length - 1) % items.length;
    event.preventDefault();
    items[next]?.focus();
});
document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target)) closeMenus();
});
menu.querySelectorAll("[data-shell-theme]").forEach(
    (button) =>
        (button.onclick = () => {
            state.theme = button.dataset.shellTheme;
            apply();
        }),
);
menu.querySelector('[data-shell-action="navigation"]').onclick = () => {
    state.navigation = !state.navigation;
    apply();
};
menu.querySelector('[data-shell-action="inspector"]').onclick = () => {
    state.inspector = !state.inspector;
    apply();
};
menu.querySelector('[data-shell-action="reset"]').onclick = () => {
    Object.assign(state, defaults, { theme: state.theme });
    apply();
};
menu.querySelector('[data-shell-action="leticia"]').onclick = () => {
    closeMenus();
    const restore = document.getElementById("michael-restore");
    if (restore && !restore.hidden) restore.click();
    else {
        const character = document.querySelector(".michael-character");
        const panel = document.getElementById("michael-panel");
        if (panel?.hidden) character?.click();
        character?.focus();
    }
};
function splitter(side, target) {
    const bar = document.createElement("div");
    bar.className = `application-splitter application-splitter-${side}`;
    bar.tabIndex = 0;
    bar.setAttribute("role", "separator");
    bar.setAttribute("aria-label", side === "left" ? "Resize navigation pane" : "Resize context pane");
    bar.setAttribute("aria-orientation", "vertical");
    bar.setAttribute("aria-controls", target.id);
    bar.setAttribute("aria-valuemin", side === "left" ? "200" : "240");
    bar.setAttribute("aria-valuemax", side === "left" ? "340" : "400");
    function resize(value) {
        state[side] = clamp(value, side === "left" ? 200 : 240, side === "left" ? 340 : 400, defaults[side]);
        apply();
    }
    bar.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        resize(
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 999
                  : state[side] + (event.key === "ArrowRight" ? 16 : -16) * (side === "right" ? -1 : 1),
        );
    });
    bar.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const initial = state[side],
            start = event.clientX;
        bar.setPointerCapture(event.pointerId);
        document.body.classList.add("application-resizing");
        const move = (e) => resize(initial + (e.clientX - start) * (side === "right" ? -1 : 1));
        const end = () => {
            bar.removeEventListener("pointermove", move);
            document.body.classList.remove("application-resizing");
        };
        bar.addEventListener("pointermove", move);
        bar.addEventListener("lostpointercapture", end, { once: true });
    });
    return bar;
}
const leftSplitter = splitter("left", navigation),
    rightSplitter = splitter("right", pane);
if (integration) {
    const layout = document.querySelector(".integration-layout");
    navigation.after(leftSplitter);
    layout.append(rightSplitter, pane);
    const heading = document.querySelector(".page-heading");
    content.prepend(heading);
    pane.querySelector(".application-inspector-content").append(document.querySelector(".policy-note"));
} else {
    navigation.append(leftSplitter);
    pane.prepend(rightSplitter);
    document.querySelector(".workspace").append(pane);
}
function apply() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.setProperty("--application-left", `${state.navigation ? state.left : 0}px`);
    document.documentElement.style.setProperty("--application-right", `${state.inspector ? state.right : 0}px`);
    document.body.classList.toggle("application-nav-hidden", !state.navigation);
    document.body.classList.toggle("application-context-hidden", !state.inspector);
    navigation.hidden = !state.navigation;
    pane.hidden = !state.inspector;
    leftSplitter.hidden = !state.navigation;
    rightSplitter.hidden = !state.inspector;
    leftSplitter.setAttribute("aria-valuenow", String(state.left));
    rightSplitter.setAttribute("aria-valuenow", String(state.right));
    menu.querySelector('[data-shell-action="navigation"]').setAttribute("aria-pressed", String(state.navigation));
    menu.querySelector('[data-shell-action="inspector"]').setAttribute("aria-pressed", String(state.inspector));
    menu.querySelectorAll("[data-shell-theme]").forEach((button) =>
        button.setAttribute("aria-pressed", String(button.dataset.shellTheme === state.theme)),
    );
    try {
        localStorage.setItem(key, JSON.stringify(state));
    } catch {
        /* Storage is optional. */
    }
}
const descriptions = integration
    ? {
          "tab-project": "Select a project to work with its pinned models, mappings and channels.",
          "tab-models": "Provide exact source contracts and target models, including versions and provenance.",
          "tab-mapping": "Define the independent mapping route and preserve the user's narrative and assumptions.",
          "tab-vendor": "Configure a read-only source, discover its actual schema and confirm a bounded read plan.",
          "tab-source": "Choose private input and verify its patient identity and source contract.",
          "tab-run": "Confirm the exact mapping and assign it to a channel before processing.",
          "tab-monitor": "Inspect job state, dependency holds and destination receipts before retrying.",
          "tab-sharing": "Manage the people and groups allowed to view or monitor channels.",
      }
    : {
          "tab-chat": "Model with small, relevant context. Real patient data stays outside provider conversations.",
          "tab-models": "Browse existing projects and versions before creating or changing a model.",
          "tab-fhir": "Work with the exact FHIR release and supplied StructureDefinitions.",
          "tab-mappings": "Prepare a mapping between the supplied source and target definitions.",
          "tab-aql": "Use the actual template and approved CDR connection to prepare bounded queries.",
          "tab-governance": "Review evidence and make a human decision for the exact model revision.",
          "tab-accounts": "Manage authorised users, roles and access with the existing account controls.",
          "tab-help": "Find workspace instructions, clinical boundaries and guidance from Leticia.",
      };
function updateContext() {
    const current = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0];
    pane.querySelector("[data-context-title]").textContent = current.textContent.trim();
    pane.querySelector("[data-context-description]").textContent = descriptions[current.id] || "";
    const project = document.getElementById(integration ? "project" : "model-project");
    pane.querySelector("[data-context-project]").textContent = project?.value
        ? project.selectedOptions[0]?.textContent || project.value
        : "No project selected";
}
const links = pane.querySelector(".application-context-links");
for (const id of integration
    ? ["tab-project", "tab-run", "tab-monitor"]
    : ["tab-models", "tab-governance", "tab-help"]) {
    const tab = tabs.find((item) => item.id === id);
    if (tab) links.append(action(tab.textContent.trim(), () => select(tab)));
}
new MutationObserver(updateContext).observe(navigation, {
    attributes: true,
    subtree: true,
    attributeFilter: ["aria-selected"],
});
const project = document.getElementById(integration ? "project" : "model-project");
project?.addEventListener("change", updateContext);
if (project) new MutationObserver(updateContext).observe(project, { childList: true, subtree: true });
apply();
workspaceMenu();
updateContext();
