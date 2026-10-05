"use strict";
const $ = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll("[data-tab]")];
let session,
    projectsLoaded = false,
    artifacts = [],
    selected,
    loading = false;
const headings = {
    chat: "Clinical modelling",
    models: "Model repository",
    aql: "AQL workspace",
    governance: "Model governance",
    accounts: "Accounts and access",
    help: "Workspace help",
};
function activate(name, update = true) {
    if (!headings[name]) name = "chat";
    document.body.dataset.section = name;
    for (const tab of tabs) {
        const active = tab.dataset.tab === name;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        $("panel-" + tab.dataset.tab).hidden = !active;
    }
    $("section-title").textContent = headings[name];
    document.title = headings[name] + " · openEHR Modelling Assistant";
    if (update && location.hash !== "#" + name) history.pushState(null, "", "#" + name);
    $("sidebar").classList.remove("open");
    document.dispatchEvent(new CustomEvent("workspace:" + name));
    if (name === "models" && session?.authenticated && !projectsLoaded) run(loadProjects);
}
for (const tab of tabs) {
    tab.onclick = () => activate(tab.dataset.tab);
    tab.onkeydown = (event) => {
        const available = tabs.filter((item) => !item.hidden);
        const index = available.indexOf(tab);
        let next;
        if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (index + 1) % available.length;
        else if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (index + available.length - 1) % available.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = available.length - 1;
        else return;
        event.preventDefault();
        available[next].focus();
        activate(available[next].dataset.tab);
    };
}
function navigateHash(initial = false) {
    const name = location.hash.slice(1);
    const topic = name.startsWith("help-") ? $(name) : null;
    if (topic && $("panel-help").contains(topic)) {
        activate("help", false);
        topic.focus();
        topic.scrollIntoView({ block: "start" });
    } else if (headings[name] || !name || initial) activate(name, false);
}
window.addEventListener("hashchange", () => navigateHash());
$("share-help").addEventListener("click", () => $("share-dialog").close());

function status(message) {
    $("model-notice").textContent = message;
    $("model-notice").hidden = !message;
}
async function get(path) {
    const response = await fetch("/chat/api/models/" + path, { signal: AbortSignal.timeout(22000) });
    const data = await response.json();
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    if (!response.ok) throw new Error(data.error || "The repository is unavailable. Please retry.");
    return data;
}
async function run(action) {
    if (loading) return;
    loading = true;
    $("panel-models").setAttribute("aria-busy", "true");
    $("refresh-models").disabled = true;
    $("model-project").disabled = true;
    status("Loading from the model repository…");
    try {
        await action();
        status("");
    } catch (error) {
        status(
            error.name === "TimeoutError" ? "The repository took too long to respond. Please retry." : error.message,
        );
    } finally {
        loading = false;
        $("panel-models").setAttribute("aria-busy", "false");
        $("refresh-models").disabled = !session?.authenticated;
        $("model-project").disabled = !session?.authenticated;
    }
}
async function loadProjects() {
    const result = await get("projects");
    const current = $("model-project").value;
    $("model-project").replaceChildren(new Option("Select a project", ""));
    for (const project of result.projects)
        $("model-project").append(new Option(project.name || project.id, project.id));
    projectsLoaded = true;
    if (result.projects.some((p) => p.id === current)) $("model-project").value = current;
    else if (result.projects.length) $("model-project").value = result.projects[0].id;
    if ($("model-project").value) await loadProject();
    else {
        artifacts = [];
        renderList();
    }
}
async function loadProject() {
    selected = null;
    $("model-detail").hidden = true;
    const project = $("model-project").value;
    if (!project) {
        artifacts = [];
        renderList();
        return;
    }
    const result = await get("project?project=" + encodeURIComponent(project));
    artifacts = result.artifacts;
    renderList();
    document.dispatchEvent(new CustomEvent("workspace:project", { detail: { project } }));
}
function renderList() {
    const query = $("model-filter").value.trim().toLowerCase();
    const items = artifacts.filter((item) => item.path.toLowerCase().includes(query));
    $("model-list").replaceChildren();
    $("model-count").textContent = String(items.length);
    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = artifacts.length
            ? "No models match this filter."
            : "This project has no artifacts yet. Use chat to discover models and prepare a draft.";
        $("model-list").append(empty);
    }
    for (const item of items) {
        const button = document.createElement("button");
        button.className = "artifact-item";
        button.setAttribute("aria-pressed", String(selected?.path === item.path));
        const name = document.createElement("strong"),
            type = document.createElement("span");
        name.textContent = item.path.split("/").at(-1);
        type.textContent = item.path.split("/")[0] + " · " + (item.status || "DRAFT");
        button.append(name, type);
        button.title = item.path;
        button.onclick = () =>
            run(async () => {
                selected = await get(
                    "artifact?project=" +
                        encodeURIComponent($("model-project").value) +
                        "&path=" +
                        encodeURIComponent(item.path) +
                        "&revision=" +
                        encodeURIComponent(item.revision),
                );
                $("model-detail").hidden = false;
                $("model-title").textContent = selected.path;
                $("model-state").textContent = selected.status;
                $("model-revision").textContent = "Revision " + selected.revision + " · SHA-256 " + selected.sha256;
                $("model-source").textContent =
                    selected.content_encoding === "base64"
                        ? "Original binary file · " +
                          selected.size_bytes +
                          " bytes. Download to inspect in a compatible application."
                        : selected.content;
                $("model-metadata").textContent = JSON.stringify(selected.metadata, null, 2);
                renderList();
                $("model-detail").setAttribute("tabindex", "-1");
                $("model-detail").focus({ preventScroll: true });
            });
        $("model-list").append(button);
    }
}
$("refresh-models").onclick = () => run(loadProjects);
$("model-project").onchange = () => run(loadProject);
$("model-filter").oninput = renderList;
$("discuss-model").onclick = () => {
    if (!selected) return;
    activate("chat");
    document.dispatchEvent(
        new CustomEvent("workspace:discuss", {
            detail: {
                prompt:
                    "Help me review " +
                    selected.path +
                    " in project " +
                    $("model-project").value +
                    ", exact revision " +
                    selected.revision +
                    ". Retrieve the source and explain the modelling decisions and any unresolved validation findings. Keep changes as drafts.",
            },
        }),
    );
};
$("download-model").onclick = () => {
    if (!selected) return;
    const bytes =
        selected.content_encoding === "base64"
            ? Uint8Array.from(atob(selected.content_base64), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(selected.content);
    const link = document.createElement("a"),
        url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    link.href = url;
    link.download = selected.path.split("/").at(-1);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
};
$("review-model").onclick = () => activate("governance");
$("query-model").onclick = () => {
    if (!selected || typeof selected.content !== "string") return;
    activate("aql");
    document.dispatchEvent(new CustomEvent("workspace:query-model", { detail: selected }));
};
function updateSession(value) {
    session = value;
    $("refresh-models").disabled = !session.authenticated;
    $("model-project").disabled = !session.authenticated;
    if (session.authenticated && document.body.dataset.section === "models" && !projectsLoaded) run(loadProjects);
}
document.addEventListener("workspace:session", (event) => updateSession(event.detail));
fetch("/chat/api/session")
    .then((r) => r.json())
    .then(updateSession)
    .catch(() => status("Sign-in status could not be loaded. Refresh to retry."));
navigateHash(true);
