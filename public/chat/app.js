"use strict";
const $ = (id) => document.getElementById(id);
let session = null,
    current = null,
    running = false,
    controller = null;
let workspaceLoaded = false,
    uploading = false,
    repositorySaving = false,
    repositoryDraft = "",
    folderDraft = "",
    destinationDefaults = { repository: null, folder: "" },
    newChatDestination = { repository: null, folder: "" },
    uploadQueue = [],
    sharedView = false,
    personalConnections = [],
    chatProjects = [],
    projectDraft = "",
    projectSaving = false,
    editingProject = null,
    movingConversation = null,
    movePreview = null;
const expandedProjects = new Set();
const toolLabels = {
    request_user_choice: "Your modelling choice",
    attachment_read: "Read source file",
    personal_connections: "Personal connections",
    personal_ckm_search: "Search personal CKM",
    personal_ckm_get: "Retrieve personal CKM model",
    personal_repository_get: "Read personal repository",
    personal_repository_list: "Browse personal repository",
    personal_repository_save: "Save to personal repository",
    model_traceability_save: "Save requirements traceability",
    model_traceability_get: "Requirements and evidence graph",
    model_traceability_explain: "Explain model element",
    model_traceability_requirement: "Requirement coverage trail",
    governance_prepare: "Prepare model review",
    governance_validate: "Record validation evidence",
    governance_request_review: "Request human review",
    governance_reopen_draft: "Reopen draft",
    governance_get: "Model review and audit",
    governance_list: "Project reviews",
    ckm_sources: "CKM sources",
    ckm_federated_search: "Search configured CKMs",
    ckm_archetype_search: "Archetype search",
    ckm_archetype_get: "Archetype retrieval",
    guide_get: "Modelling guide",
    guide_search: "Guide search",
    model_repository_info: "Repository details",
    model_repository_branches: "Repository branches",
    model_repository_diff: "Git revision comparison",
    model_branch_create: "Create branch",
    model_review_request: "Request draft review",
    model_review_get: "Review details",
    model_projects: "Model projects",
    model_project_get: "Project details",
    model_artifact_get: "Model artifact",
    model_artifact_save: "Save draft",
    template_compile_project: "Compile and save OPT draft",
    model_project_create: "Create project",
    model_validate: "Structural checks",
    model_qa: "Document quality checks",
    model_project_qa: "Project model quality and evidence",
    terminology_binding_plan_save: "Save draft binding plan",
    terminology_binding_plan: "Plan terminology bindings",
    terminology_binding_plan_get: "Read binding plan",
    model_terminology_inspect: "Inspect model terminology",
    terminology_catalogue_save: "Save draft terminology",
    terminology_catalogue_search: "Project terminology search",
    terminology_catalogue_get: "Terminology record",
    terminology_catalogue_lookup: "Project code lookup",
    terminology_catalogue_validate: "Terminology validation",
    terminology_catalogue_expand: "Value set members",
    terminology_catalogue_translate: "Mapping candidates",
};
function notice(message) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message || $("chat-settings-dialog").open;
    $("settings-notice").textContent = message || "";
    $("settings-notice").hidden = !message;
}
async function api(path, { method = "GET", data } = {}) {
    const response = await fetch("/chat/" + path, {
        method,
        headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.status === 401) await loadSession();
    return responseJson(response);
}
async function responseJson(response, upload = false) {
    let result;
    try {
        result = await response.json();
    } catch {
        // Proxies and HTTP request timeouts can return an empty or HTML response.
    }
    if (!response.ok || !result || typeof result !== "object" || Array.isArray(result)) {
        const messages = {
            401: "Your session expired. Sign in again, then retry.",
            408: upload
                ? "The upload timed out. Please try adding the file again."
                : "The request timed out. Please try again.",
            413: upload
                ? "The server rejected the file size. Files can be up to 10 MiB; a smaller file may help."
                : "The request is too large. Please send less content at once.",
            429: "The server is busy. Please try again shortly.",
            502: "The server connection was interrupted. Please try again shortly.",
            503: "The server is temporarily unavailable. Please try again shortly.",
            504: "The server took too long to respond. Please try again shortly.",
        };
        throw new Error(
            (typeof result?.error === "string" && result.error) ||
                messages[response.status] ||
                (upload
                    ? "The upload response was incomplete. Reopen this chat to check whether the file was added before trying again."
                    : "The server returned an incomplete response. Please try again."),
        );
    }
    return result;
}
function destinationChanged() {
    const saved = current || newChatDestination;
    return repositoryDraft !== (saved.repository || "") || folderDraft !== (saved.folder || "");
}
function controls() {
    const ready = workspaceLoaded && !!session?.authenticated && session.enabled && !sharedView;
    const busy = running || uploading || repositorySaving || projectSaving;
    const unsavedRepository = destinationChanged();
    const connected = session?.providers?.some((p) => p.id === $("chat-provider").value && p.connected);
    $("chat-provider").disabled = busy || sharedView || !!current?.messages?.length || !!current?.attachments?.length;
    $("sign-out").disabled = uploading || repositorySaving || projectSaving;
    document
        .querySelectorAll(".conversation-row button, .project-actions button")
        .forEach((button) => (button.disabled = busy));
    $("message").disabled = !ready || running;
    $("send").disabled = !ready || !connected || busy || unsavedRepository || !$("message").value.trim();
    $("new-chat").disabled = !ready || busy;
    $("new-project").disabled = !ready || busy;
    $("save-chat-project").disabled = !ready || busy;
    $("confirm-move-chat").disabled = !ready || busy;
    $("move-chat-project").disabled = busy;
    $("move-chat-paths").disabled = busy;
    $("refresh-move-preview").disabled = busy;
    $("move-chat-form").setAttribute("aria-busy", String(projectSaving));
    $("move-chat-progress").hidden = !projectSaving;
    renderProjectContext();
    if (sharedView) $("new-chat").disabled = false;
    $("upload-files").disabled = !ready || busy || unsavedRepository;
    $("attach-files").disabled = !ready || busy || unsavedRepository;
    $("save-destination").disabled = !ready || busy;
    $("repository-folder").disabled = !ready || busy;
    $("use-project-folder").disabled = !ready || busy;
    $("save-repository-selection").disabled = !ready || busy || !unsavedRepository;
    $("share-chat").disabled = !ready || busy || !current?.messages?.length;
    $("share-chat").hidden = !ready || !current?.messages?.length;
    document.querySelectorAll(".attachment-remove").forEach((button) => (button.disabled = busy));
    $("stop").hidden = !running;
    document
        .querySelectorAll(".suggestion")
        .forEach((button) => (button.disabled = !ready || !connected || busy || unsavedRepository));
    renderDestinationStatus();
    $("chat-form").setAttribute("aria-busy", String(busy));
    $("activity").dataset.working = String(busy);
    if (projectSaving) $("activity").textContent = "Organising your chats…";
    else if (repositorySaving) $("activity").textContent = "Saving your repository selection…";
    else if (uploading) $("activity").textContent = "Uploading and reading your files…";
    else if (!running) {
        $("activity").textContent = "";
        $("activity").dataset.waiting = "false";
    } else if (!$("activity").textContent) $("activity").textContent = "Working on your request…";
    $("composer-hint").textContent = running
        ? "Working with your modelling tools…"
        : ready
          ? connected
              ? "Enter to send · Shift + Enter for a new line"
              : "Open the settings gear to connect your assistant"
          : "Describe what you want to model";
}
function chatSettings(expanded) {
    if (expanded) $("chat-settings-dialog").showModal();
    else $("chat-settings-dialog").close();
    $("notice").hidden = expanded || !$("notice").textContent;
}
$("chat-settings-dialog").addEventListener("close", () => {
    $("notice").hidden = !$("notice").textContent;
});
$("toggle-chat-settings").onclick = () => chatSettings(true);
$("close-chat-settings").onclick = () => chatSettings(false);
$("chat-settings-dialog").addEventListener("click", (event) => {
    if (event.target.closest('a[href^="#help"]')) chatSettings(false);
    if (event.target === $("chat-settings-dialog")) {
        const bounds = event.target.getBoundingClientRect();
        if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
        )
            chatSettings(false);
    }
});
async function loadSession() {
    session = await api("api/session");
    $("sign-out").hidden = !session.authenticated;
    $("sign-in").hidden = !!session.authenticated;
    $("sign-in").href = session.identityEnabled ? "#chat" : "/chat/auth/login";
    $("user-name").textContent = session.user?.name || "";
    $("copilot-url").value = session.mcpConnection?.url || location.origin + "/mcp";
    $("copilot-header").value = session.mcpConnection?.header || "X-API-Key";
    $("copilot-key-controls").hidden =
        !session.identityEnabled || !session.user?.roles?.includes("modelling-administrator");
    $("copilot-key").value = "";
    $("copilot-key-field").hidden = true;
    if (!session.authenticated || !session.access?.permissions?.includes("manage-global-providers"))
        providerScope = "personal";
    displayedProviders =
        providerScope === "global" ? (await api("api/providers?scope=global")).providers : session.providers;
    renderProviders();
    controls();
    document.dispatchEvent(new CustomEvent("workspace:session", { detail: session }));
    if (!session.enabled && !session.reviewEnabled && !session.identityEnabled)
        notice("Browser chat is not configured on this deployment.");
}
let sessionRefresh;
let lastInteraction = Date.now();
for (const event of ["pointerdown", "keydown", "input"])
    document.addEventListener(
        event,
        () => {
            lastInteraction = Date.now();
        },
        { passive: true },
    );
function refreshSession() {
    if (!sessionRefresh)
        sessionRefresh = loadSession()
            .catch(() => {})
            .finally(() => {
                sessionRefresh = null;
            });
    return sessionRefresh;
}
document.addEventListener("workspace:session-expired", refreshSession);
window.addEventListener("focus", () => {
    if (session?.authenticated) refreshSession();
});
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && session?.authenticated) refreshSession();
});
setInterval(async () => {
    if (document.hidden || !session?.authenticated) return;
    if (running || Date.now() - lastInteraction < 120000) {
        try {
            await api("auth/keepalive", { method: "POST", data: {} });
        } catch (error) {
            if (!session?.authenticated)
                notice("Your session expired. Sign in again; saved work remains in this conversation.");
        }
    }
    refreshSession();
}, 60000);
$("sign-in").onclick = (event) => {
    event.preventDefault();
    document.dispatchEvent(new Event("workspace:open-account"));
};
$("copilot-copy-url").onclick = () =>
    navigator.clipboard
        .writeText($("copilot-url").value)
        .then(() => ($("copilot-mcp-status").textContent = "Server address copied."))
        .catch(() => {
            $("copilot-url").select();
            $("copilot-mcp-status").textContent = "Copy the selected address.";
        });
$("copilot-show-key").onclick = async () => {
    try {
        const result = await api("api/identity/mcp-connection", { method: "POST", data: {} });
        $("copilot-key").value = result.key;
        $("copilot-key-field").hidden = false;
        $("copilot-mcp-status").textContent =
            "Use this workspace connection key only in your trusted Copilot Studio connection.";
    } catch (error) {
        $("copilot-mcp-status").textContent = error.message;
    }
};
$("copilot-copy-key").onclick = () =>
    navigator.clipboard
        .writeText($("copilot-key").value)
        .then(() => ($("copilot-mcp-status").textContent = "Connection key copied. Paste it into Copilot Studio."))
        .catch(() => {
            $("copilot-key").select();
            $("copilot-mcp-status").textContent = "Copy the selected key.";
        });
$("copilot-hide-key").onclick = () => {
    $("copilot-key").value = "";
    $("copilot-key-field").hidden = true;
    $("copilot-mcp-status").textContent = "Connection key hidden.";
};
for (const [button, field] of [
    ["copy-copilot-tool", "copilot-tool-definition"],
    ["copy-copilot-instructions", "copilot-agent-instructions"],
])
    $(button).onclick = () =>
        navigator.clipboard
            .writeText($(field).value)
            .then(() => {
                $("copilot-setup-status").textContent =
                    "Copied. Paste it into your Copilot Studio agent and publish the changes.";
            })
            .catch(() => {
                $(field).select();
                $("copilot-setup-status").textContent = "Copy the selected text.";
            });
for (const section of ["chat", "models", "governance", "accounts"]) {
    document.addEventListener("workspace:" + section, () => {
        $("copilot-key").value = "";
        $("copilot-key-field").hidden = true;
        $("copilot-mcp-status").textContent = "";
    });
}
function renderProjectContext() {
    const project = chatProjects.find((item) => item.id === projectDraft);
    $("chat-project-context").textContent = project ? "Chat project: " + project.name : "";
    $("chat-project-context").hidden = !project || sharedView;
}
async function projectAction(action, errorTarget) {
    if (running || uploading || repositorySaving || projectSaving) return;
    projectSaving = true;
    controls();
    try {
        await action();
        await list();
    } catch (error) {
        if (errorTarget) errorTarget.textContent = error.message;
        else notice(error.message);
    } finally {
        projectSaving = false;
        controls();
    }
}
function editProject(project = null) {
    editingProject = project;
    $("chat-project-dialog-title").textContent = project ? "Project settings" : "Create chat project";
    $("chat-project-input").value = project?.name || "";
    $("save-chat-project").textContent = project ? "Save project" : "Create project";
    $("chat-project-repository").replaceChildren(new Option("Enterprise repository", ""));
    for (const connection of personalConnections.filter((item) => item.kind !== "ckm"))
        $("chat-project-repository").add(new Option(connection.label + " · " + connection.branch, connection.id));
    const repository = project ? project.repository : destinationDefaults.repository;
    if (repository && !personalConnections.some((item) => item.id === repository))
        $("chat-project-repository").add(new Option("Unavailable saved connection", repository));
    $("chat-project-repository").value = repository || "";
    $("chat-project-folder").value = project?.folder || "";
    $("chat-project-folder").placeholder = project ? "Repository root" : "Use project name";
    $("chat-project-folder-hint").textContent = project
        ? "For personal repositories. An empty folder saves at the repository root."
        : "For personal repositories. Leave empty to use the project name.";
    $("chat-project-error").textContent = "";
    $("chat-project-dialog").showModal();
    $("chat-project-input").focus();
}
$("new-project").onclick = () => editProject();
$("cancel-chat-project").onclick = () => $("chat-project-dialog").close();
$("chat-project-form").onsubmit = (event) => {
    event.preventDefault();
    projectAction(async () => {
        const project = await api("api/projects" + (editingProject ? "/" + editingProject.id : ""), {
            method: editingProject ? "PUT" : "POST",
            data: {
                name: $("chat-project-input").value,
                repository: $("chat-project-repository").value || null,
                ...(editingProject || $("chat-project-folder").value ? { folder: $("chat-project-folder").value } : {}),
            },
        });
        chatProjects = [...chatProjects.filter((item) => item.id !== project.id), project];
        expandedProjects.add(project.id);
        if (!editingProject) {
            reset(project.id);
            $("tab-chat").click();
        }
        $("chat-project-dialog").close();
    }, $("chat-project-error"));
};
$("cancel-move-chat").onclick = () => $("move-chat-dialog").close();
function clearMovePreview() {
    movePreview = null;
    $("move-chat-preview").replaceChildren();
    $("move-chat-preview").hidden = true;
    $("move-chat-error").textContent = "";
    $("confirm-move-chat").textContent = "Move chat";
    $("refresh-move-preview").hidden = true;
}
$("refresh-move-preview").onclick = clearMovePreview;
$("move-chat-project").onchange = clearMovePreview;
$("move-chat-paths").oninput = clearMovePreview;
$("move-chat-form").onsubmit = (event) => {
    event.preventDefault();
    projectAction(async () => {
        const base = "api/conversations/" + movingConversation.id;
        if (!movePreview) {
            movePreview = await api(base + "/move-preview", {
                method: "POST",
                data: {
                    project: $("move-chat-project").value || null,
                    paths: $("move-chat-paths")
                        .value.split("\n")
                        .map((path) => path.trim())
                        .filter(Boolean),
                },
            });
            if (movePreview.moves.length) {
                const preview = $("move-chat-preview"),
                    intro = document.createElement("p"),
                    list = document.createElement("ul");
                intro.textContent =
                    "Move " +
                    movePreview.moves.length +
                    " artefact(s) in " +
                    movePreview.destination.url +
                    " · " +
                    movePreview.destination.branch +
                    ":";
                for (const move of movePreview.moves) {
                    const item = document.createElement("li");
                    item.textContent = move.from + " → " + move.to + (move.retainSource ? " (keep shared source)" : "");
                    list.append(item);
                }
                preview.replaceChildren(intro, list);
                preview.hidden = false;
                $("confirm-move-chat").textContent = "Move chat and artefacts";
                $("refresh-move-preview").hidden = false;
                return;
            }
        }
        const updated = await api(base + "/move", {
            method: "POST",
            data: { id: movePreview.id },
        });
        if (current?.id === updated.id) {
            current = updated;
            projectDraft = updated.project || "";
            repositoryDraft = updated.repository || "";
            folderDraft = updated.folder || "";
            renderDestinations();
        }
        if (updated.project) expandedProjects.add(updated.project);
        $("move-chat-dialog").close();
    }, $("move-chat-error"));
};
function conversationRow(c) {
    const row = document.createElement("div");
    row.className = "conversation-row" + (current?.id === c.id ? " selected" : "");
    const button = document.createElement("button");
    button.textContent = c.title;
    button.title = c.title;
    button.onclick = () => open(c.id).catch((e) => notice(e.message));
    const move = document.createElement("button");
    move.className = "move-chat";
    move.textContent = "↪";
    move.title = "Move to a project";
    move.setAttribute("aria-label", "Move " + c.title + " to a project");
    move.onclick = () => {
        movingConversation = c;
        clearMovePreview();
        $("move-chat-paths").value = "";
        $("move-older-files").open = false;
        $("move-chat-project").replaceChildren(new Option("Unfiled chats", ""));
        for (const project of chatProjects) $("move-chat-project").add(new Option(project.name, project.id));
        $("move-chat-project").value = c.project || "";
        $("move-chat-error").textContent = "";
        $("move-chat-dialog").showModal();
    };
    const remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.textContent = "×";
    remove.title = "Delete conversation";
    remove.setAttribute("aria-label", "Delete " + c.title);
    remove.onclick = async () => {
        if (!confirm("Delete this conversation, its messages and uploaded files?")) return;
        try {
            await api("api/conversations/" + c.id, { method: "DELETE" });
            if (current?.id === c.id) reset(projectDraft);
            await list();
        } catch (e) {
            notice(e.message);
        }
    };
    row.append(button, move, remove);
    return row;
}
async function list() {
    const result = await api("api/conversations");
    chatProjects = result.projects || [];
    destinationDefaults = result.destination || { repository: null, folder: "" };
    $("conversations").replaceChildren();
    for (const project of chatProjects) {
        const group = document.createElement("details"),
            summary = document.createElement("summary");
        group.className = "chat-project";
        group.dataset.project = project.id;
        const chats = result.conversations.filter((c) => c.project === project.id);
        summary.textContent = project.name + " (" + chats.length + ")";
        summary.title = project.name;
        group.append(summary);
        group.open = expandedProjects.has(project.id);
        group.ontoggle = () => (group.open ? expandedProjects.add(project.id) : expandedProjects.delete(project.id));
        const actions = document.createElement("div");
        actions.className = "project-actions";
        for (const [label, text, action] of [
            [
                "New chat in " + project.name,
                "+ Chat",
                () => {
                    reset(project.id);
                    $("tab-chat").click();
                    list().catch((e) => notice(e.message));
                    $("sidebar").classList.remove("open");
                    $("message").focus();
                },
            ],
            ["Settings for " + project.name, "Settings", () => editProject(project)],
            [
                "Delete project " + project.name,
                "Delete",
                () => {
                    if (!confirm("Delete this project? Its conversations will be kept in Unfiled chats.")) return;
                    projectAction(async () => {
                        await api("api/projects/" + project.id, { method: "DELETE" });
                        if (projectDraft === project.id) projectDraft = "";
                        if (current?.project === project.id) current.project = null;
                        expandedProjects.delete(project.id);
                    });
                },
            ],
        ]) {
            const button = document.createElement("button");
            button.textContent = text;
            button.setAttribute("aria-label", label);
            button.onclick = action;
            actions.append(button);
        }
        group.append(actions);
        for (const c of chats) group.append(conversationRow(c));
        if (!chats.length) {
            const empty = document.createElement("p");
            empty.className = "empty-list";
            empty.textContent = "No conversations yet.";
            group.append(empty);
        }
        $("conversations").append(group);
    }
    const unfiled = result.conversations.filter((c) => !chatProjects.some((project) => project.id === c.project));
    if (chatProjects.length && unfiled.length) {
        const heading = document.createElement("p");
        heading.className = "unfiled-heading";
        heading.textContent = "Unfiled chats";
        $("conversations").append(heading);
    }
    for (const c of unfiled) $("conversations").append(conversationRow(c));
    if (!result.conversations.length && !chatProjects.length) {
        const p = document.createElement("p");
        p.className = "empty-list";
        p.textContent = "Your conversations will appear here.";
        $("conversations").append(p);
    }
    controls();
}
function reset(project = "") {
    current = null;
    projectDraft = project;
    newChatDestination = chatProjects.find((item) => item.id === project) || destinationDefaults;
    repositoryDraft = newChatDestination.repository || "";
    folderDraft = newChatDestination.folder || "";
    renderDestinations();
    sharedView = false;
    uploadQueue = [];
    $("attachment-list").replaceChildren();
    $("conversation-file-list").replaceChildren();
    $("conversation-files").hidden = true;
    $("upload-status").textContent = "";
    $("thread").replaceChildren();
    $("thread").hidden = true;
    $("welcome").hidden = false;
    $("activity").textContent = "";
    notice("");
    controls();
}
function format(container, text) {
    container.replaceChildren();
    const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
    for (const part of parts) {
        if (part.startsWith("```")) {
            const pre = document.createElement("pre"),
                code = document.createElement("code");
            code.textContent = part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
            pre.append(code);
            container.append(pre);
        } else {
            const span = document.createElement("span");
            const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
            let position = 0;
            for (const match of part.matchAll(pattern)) {
                span.append(document.createTextNode(part.slice(position, match.index)));
                const value = match[0];
                let element;
                if (value.startsWith("`")) {
                    element = document.createElement("code");
                    element.textContent = value.slice(1, -1);
                } else if (value.startsWith("**")) {
                    element = document.createElement("strong");
                    element.textContent = value.slice(2, -2);
                } else {
                    const link = value.match(/^\[(.*?)\]\((.*?)\)$/);
                    element = document.createElement("a");
                    element.textContent = link[1];
                    element.href = link[2];
                    element.target = "_blank";
                    element.rel = "noopener noreferrer";
                }
                span.append(element);
                position = match.index + value.length;
            }
            span.append(document.createTextNode(part.slice(position)));
            container.append(span);
        }
    }
}
function bubble(message) {
    const article = document.createElement("article");
    article.className = "message " + message.role;
    const title = document.createElement("div");
    title.className = "message-header";
    title.textContent = message.role === "user" ? (sharedView ? "Participant" : "You") : "Modelling Assistant";
    const content = document.createElement("div");
    content.className = "message-content";
    format(content, message.content || "");
    const tools = document.createElement("div");
    tools.className = "tool-list";
    for (const tool of message.tools || []) toolChip(tools, tool);
    article.append(title, tools, content);
    if (message.attachments?.length && !sharedView) {
        const files = document.createElement("div");
        files.className = "attachment-list message-attachments";
        files.setAttribute("aria-label", "Attached files");
        for (const item of message.attachments) files.append(attachmentCard(item, false));
        article.insertBefore(files, content);
    }
    if (message.role === "assistant") {
        const copy = document.createElement("button");
        copy.className = "copy-button";
        copy.textContent = "Copy response";
        copy.onclick = () =>
            navigator.clipboard
                .writeText(content.textContent)
                .then(() => {
                    copy.textContent = "Copied";
                })
                .catch(() => notice("Copy is unavailable in this browser."));
        const actions = document.createElement("div");
        actions.className = "message-actions";
        actions.append(copy);
        article.append(actions);
        if (message.error && !sharedView && message === current?.messages?.at(-1)) {
            const resume = document.createElement("button");
            resume.type = "button";
            resume.className = "resume-button";
            resume.textContent = "Continue from saved progress";
            resume.disabled = running || !!current?.running;
            resume.onclick = () =>
                send(
                    "Continue the unfinished task from saved progress. Inspect retained drafts and completed modelling evidence first. Reuse the correct draft instead of rebuilding it; check current repository contents before retrying any save.",
                ).catch((error) => notice(error.message));
            actions.prepend(resume);
        }
    }
    $("thread").append(article);
    return { article, content, tools, text: message.content || "" };
}
function toolChip(container, tool) {
    let chip = Array.from(container.children).find((node) => node.dataset.id === tool.id);
    if (!chip) {
        chip = document.createElement("span");
        chip.className = "tool-chip";
        chip.dataset.id = tool.id;
        container.append(chip);
    }
    chip.dataset.status = tool.status;
    chip.textContent =
        (tool.status === "completed" ? "✓ " : tool.status === "failed" ? "! " : "◌ ") +
        (toolLabels[tool.name] || tool.name.replaceAll("_", " "));
}
async function open(id) {
    if (running || uploading || repositorySaving || projectSaving) return;
    current = await api("api/conversations/" + id);
    repositoryDraft = current.repository || "";
    folderDraft = current.folder || "";
    projectDraft = current.project || "";
    if (projectDraft) expandedProjects.add(projectDraft);
    sharedView = false;
    renderAttachments();
    renderDestinations();
    $("chat-provider").value = current.provider || "codex";
    controls();
    $("welcome").hidden = true;
    $("thread").hidden = false;
    $("thread").replaceChildren();
    for (const m of current.messages) bubble(m);
    $("thread").scrollTop = $("thread").scrollHeight;
    $("sidebar").classList.remove("open");
    await list();
    if (current.running) {
        notice("Reconnected to the running response. Completed work is being saved.");
        followResponse(id);
    } else notice("");
}
async function followResponse(id) {
    running = true;
    controls();
    let previous = "";
    try {
        while (current?.id === id && session?.authenticated) {
            const snapshot = await api("api/conversations/" + id);
            const fingerprint = JSON.stringify([snapshot.messages, snapshot.pending, snapshot.running]);
            current = snapshot;
            if (fingerprint !== previous) {
                previous = fingerprint;
                $("thread").replaceChildren();
                let target;
                for (const message of current.messages) target = bubble(message);
                if (target && current.pending?.type === "approval") approval(current.pending, target);
                if (target && current.pending?.type === "choice") choiceCard(current.pending, target);
                renderAttachments();
            }
            $("activity").dataset.waiting = String(!!current.pending);
            $("activity").textContent = current.pending
                ? "Waiting for your response"
                : current.running
                  ? "Working; progress is saved…"
                  : "";
            if (!current.running) break;
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    } catch (error) {
        notice("Connection unavailable. Reopen this conversation to recover saved progress.");
    } finally {
        running = false;
        controls();
        if (current?.id === id && !current.running) await open(id);
    }
}
function approval(event, target) {
    const card = document.createElement("section");
    card.className = "approval";
    const h = document.createElement("h3");
    h.textContent = toolLabels[event.tool] || "Review this model change";
    const p = document.createElement("p");
    p.textContent =
        "Confirm the exact repository action below before it is executed. This does not approve a model for clinical use.";
    const files = event.arguments?.package?.files;
    if (files) {
        p.textContent =
            "Save this template with its archetypes and dependency manifest in one commit. Identical files are reused. This remains a draft requiring clinical review.";
        const list = document.createElement("ul");
        list.className = "package-files";
        for (const file of files) {
            const item = document.createElement("li");
            item.textContent = file.path + (file.changed ? " · save" : " · already present");
            list.append(item);
        }
        card.append(list);
    }
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(event.arguments, null, 2);
    const yes = document.createElement("button");
    yes.textContent = ["model_review_request", "governance_request_review"].includes(event.tool)
        ? "Confirm review request"
        : event.tool === "model_branch_create"
          ? "Confirm branch creation"
          : "Confirm save";
    const no = document.createElement("button");
    no.className = "decline";
    no.textContent = "Cancel change";
    const decide = async (approved) => {
        yes.disabled = true;
        no.disabled = true;
        try {
            await api("api/conversations/" + current.id + "/approval", {
                method: "POST",
                data: { id: event.id, approved },
            });
            card.replaceChildren();
            const text = document.createElement("p");
            text.textContent = approved ? "Change confirmed. Applying the repository action…" : "Change cancelled.";
            card.append(text);
        } catch (e) {
            notice(e.message);
        }
    };
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    card.prepend(h, p);
    card.append(pre, yes, no);
    target.article.append(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function choiceCard(event, target) {
    const card = document.createElement("section"),
        heading = document.createElement("h3"),
        options = document.createElement("div");
    card.className = "choice-card";
    card.dataset.choiceId = event.id;
    heading.id = "choice-" + event.id;
    heading.textContent = event.question;
    card.setAttribute("role", "group");
    card.setAttribute("aria-labelledby", heading.id);
    options.className = "choice-options";
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const custom = document.createElement("details"),
        summary = document.createElement("summary"),
        text = document.createElement("textarea");
    summary.textContent = "Write another answer";
    text.setAttribute("aria-label", "Your own answer");
    text.maxLength = 2000;
    custom.append(summary, text);
    const answer = async (selected = [], cancelled = false) => {
        error.hidden = true;
        const inputs = [...card.querySelectorAll("button, input, textarea")];
        inputs.forEach((input) => (input.disabled = true));
        try {
            await api("api/conversations/" + current.id + "/choice", {
                method: "POST",
                data: { id: event.id, selected, text: text.value, cancelled },
            });
        } catch (failure) {
            error.textContent = failure.message;
            error.hidden = false;
            inputs.forEach((input) => (input.disabled = false));
        }
    };
    for (const option of event.options) {
        if (event.multiple) {
            const label = document.createElement("label"),
                input = document.createElement("input");
            input.type = "checkbox";
            input.value = option;
            label.append(input, document.createTextNode(option));
            options.append(label);
        } else {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = option;
            button.onclick = () => answer([option]);
            options.append(button);
        }
    }
    const submit = document.createElement("button"),
        skip = document.createElement("button");
    submit.type = skip.type = "button";
    submit.textContent = event.multiple ? "Use selected options" : "Use my answer";
    submit.onclick = () => answer([...options.querySelectorAll("input:checked")].map((input) => input.value));
    skip.textContent = "Skip question";
    skip.onclick = () => answer([], true);
    if (!event.multiple) custom.append(submit);
    card.append(heading, options, custom);
    if (event.multiple) card.append(submit);
    card.append(skip, error);
    target.article.append(card);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
function completeChoice(event) {
    const card = [...document.querySelectorAll(".choice-card")].find((card) => card.dataset.choiceId === event.id);
    if (!card) return;
    const heading = document.createElement("h3"),
        result = document.createElement("p");
    heading.id = "choice-" + event.id;
    heading.textContent = event.answer.question;
    result.textContent = event.answer.cancelled
        ? "Question skipped."
        : "Your answer: " + [...event.answer.selected, event.answer.text].filter(Boolean).join("; ");
    card.replaceChildren(heading, result);
}
async function send(text) {
    if (running || uploading || repositorySaving || projectSaving || sharedView || !text.trim()) return;
    if (destinationChanged()) {
        notice("Press Save repository selection before sending your message.");
        return;
    }
    notice("");
    if (!session?.providers?.some((p) => p.id === $("chat-provider").value && p.connected)) {
        chatSettings(true);
        $("provider-settings").open = true;
        notice("Connect your provider account before sending a message.");
        return;
    }
    await ensureConversation();
    $("welcome").hidden = true;
    $("thread").hidden = false;
    $("message").value = "";
    const message = { role: "user", content: text, attachments: pendingAttachments() };
    current.messages.push(message);
    bubble(message);
    renderAttachments();
    const target = bubble({ role: "assistant", content: "" });
    $("thread").scrollTop = $("thread").scrollHeight;
    running = true;
    chatSettings(false);
    controls();
    await list();
    controller = new AbortController();
    let sendError;
    try {
        const response = await fetch("/chat/api/conversations/" + current.id + "/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
            body: JSON.stringify({
                content: text,
                repository: current.repository || null,
                folder: current.folder || "",
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            if (response.status === 401) await refreshSession();
            $("message").value = text;
            await responseJson(response);
        }
        const reader = response.body.getReader(),
            decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                for (const line of frame.split("\n")) {
                    if (!line.startsWith("data: ")) continue;
                    const event = JSON.parse(line.slice(6));
                    if (event.type === "delta") {
                        const thread = $("thread");
                        const follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
                        target.text += event.text;
                        format(target.content, target.text);
                        if (follow) thread.scrollTop = thread.scrollHeight;
                    } else if (event.type === "status") $("activity").textContent = event.text;
                    else if (event.type === "choice") {
                        choiceCard(event, target);
                        $("activity").textContent = event.multiple
                            ? "Choose one or more options to continue"
                            : "Choose an option to continue";
                        $("activity").dataset.waiting = "true";
                    } else if (event.type === "choice_result") {
                        completeChoice(event);
                        $("activity").dataset.waiting = "false";
                        $("activity").textContent = "Continuing with your answer…";
                    } else if (event.type === "tool") {
                        toolChip(target.tools, event);
                        if (event.artifact && event.status === "completed") {
                            current.artifacts = (current.artifacts || []).filter(
                                (item) =>
                                    item.repository !== event.artifact.repository || item.path !== event.artifact.path,
                            );
                            current.artifacts.push(event.artifact);
                            renderArtifacts();
                        }
                        $("activity").dataset.waiting = "false";
                        $("activity").textContent =
                            event.status === "running"
                                ? "Using " + (toolLabels[event.name] || event.name.replaceAll("_", " ")) + "…"
                                : "Preparing the response…";
                    } else if (event.type === "approval") {
                        approval(event, target);
                        $("activity").textContent = "Waiting for your confirmation";
                        $("activity").dataset.waiting = "true";
                    } else if (event.type === "error") {
                        notice(event.message);
                    } else if (event.type === "done") $("activity").textContent = "";
                }
            }
        }
    } catch (error) {
        if (error.name !== "AbortError") sendError = error.message;
    } finally {
        running = false;
        controller = null;
        $("activity").textContent = "";
        controls();
        await open(current.id);
        if (sendError) notice(sendError);
        $("message").focus();
    }
}
$("chat-form").onsubmit = (event) => {
    event.preventDefault();
    send($("message").value).catch((e) => notice(e.message));
};
$("message").oninput = controls;
$("message").onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        $("chat-form").requestSubmit();
    }
};
$("new-chat").onclick = () => {
    reset(projectDraft);
    $("tab-chat").click();
    list().catch((e) => notice(e.message));
    $("message").focus();
};
$("stop").onclick = async () => {
    try {
        await api("api/conversations/" + current.id + "/stop", { method: "POST" });
    } catch (e) {
        notice(e.message);
    }
};
$("sign-out").onclick = async () => {
    try {
        if (running) await api("api/conversations/" + current.id + "/stop", { method: "POST" });
        await api("auth/logout", { method: "POST" });
        location.reload();
    } catch (e) {
        notice(e.message);
    }
};
$("toggle-sidebar").onclick = () => {
    const expanded = $("sidebar").classList.toggle("open");
    $("toggle-sidebar").setAttribute("aria-expanded", String(expanded));
};
document
    .querySelectorAll(".suggestion")
    .forEach((button) => (button.onclick = () => send(button.dataset.prompt).catch((e) => notice(e.message))));
let providerScope = "personal";
let displayedProviders = [];
const scopedProviderPath = (name) => "api/providers/" + name + (providerScope === "global" ? "?scope=global" : "");
let providerPoll;
let providerSession;
function renderProviders() {
    const owner = session?.authenticated ? session.csrf : null;
    if (providerSession !== owner) {
        providerSession = owner;
        for (const field of ["tenant", "client", "environment", "schema"]) $("copilot-" + field).value = "";
        $("copilot-code").textContent = "";
        $("copilot-test-status").textContent = "";
    }
    $("provider-bar").hidden = !session?.authenticated || !session.enabled;
    $("toggle-chat-settings").hidden = !session?.authenticated || (!session.enabled && !session.cdrEnabled);
    $("share-chat").hidden = $("provider-bar").hidden;
    if ($("toggle-chat-settings").hidden) chatSettings(false);
    $("provider-scope-control").hidden = !session?.access?.permissions?.includes("manage-global-providers");
    $("repository-scope-control").hidden = !session?.access?.permissions?.includes("manage-global-repositories");
    $("provider-scope").value = providerScope;
    $("codex-shared-key-field").hidden = providerScope !== "global";
    for (const provider of displayedProviders || session?.providers || []) {
        const personal =
            providerScope === "global" ? provider.connected : (provider.personalConnected ?? provider.connected);
        $(provider.id + "-status").textContent = provider.connected
            ? providerScope === "personal" && provider.scope === "global"
                ? "Shared connection available"
                : "Connected"
            : provider.signingIn
              ? "Waiting for sign-in…"
              : "Not connected";
        $("connect-" + provider.id).disabled = personal || provider.signingIn;
        $("disconnect-" + provider.id).hidden = !personal && !provider.signingIn;
        if (provider.id === "copilot") {
            if (provider.error) $("copilot-status").textContent = provider.error;
            $("test-copilot").hidden = !provider.connected;
            const fields = {
                tenant: "tenantId",
                client: "clientId",
                environment: "environmentId",
                schema: "schemaName",
            };
            for (const [id, key] of Object.entries(fields)) {
                $("copilot-" + id).disabled = personal || provider.signingIn;
                if (provider.settings) $("copilot-" + id).value = provider.settings[key];
            }
        }
    }
    for (const name of ["codex", "copilot"])
        if (!displayedProviders?.some((p) => p.id === name && p.signingIn)) $(name + "-device").hidden = true;
    if (!displayedProviders?.some((p) => p.signingIn)) {
        clearTimeout(providerPoll);
        $("codex-device").hidden = true;
    }
}
function pollProviders() {
    clearTimeout(providerPoll);
    providerPoll = setTimeout(async () => {
        try {
            await loadSession();
            if (displayedProviders.some((p) => p.signingIn)) pollProviders();
        } catch (error) {
            notice(error.message);
        }
    }, 3000);
}
$("chat-provider").onchange = () => {
    if (!current?.messages?.length) current = null;
    controls();
};
$("connect-codex").onclick = async () => {
    $("connect-codex").disabled = true;
    try {
        const result = await api(scopedProviderPath("codex"), {
            method: "POST",
            data: providerScope === "global" ? { apiKey: $("codex-shared-key").value } : {},
        });
        await loadSession();
        $("codex-shared-key").value = "";
        if (result.success) {
            notice("Shared Codex connection saved.");
            return;
        }
        $("codex-verification").href = result.verificationUrl;
        $("codex-code").textContent = result.userCode;
        $("codex-device").hidden = false;
        pollProviders();
    } catch (error) {
        notice(error.message);
        $("connect-codex").disabled = false;
    }
};
$("claude-connection").onsubmit = async (event) => {
    event.preventDefault();
    const apiKey = $("claude-key").value.trim();
    $("claude-key").value = "";
    try {
        await api(scopedProviderPath("claude"), { method: "POST", data: { apiKey } });
        await loadSession();
    } catch (error) {
        notice(error.message);
    }
};
$("copilot-connection").onsubmit = async (event) => {
    event.preventDefault();
    $("connect-copilot").disabled = true;
    $("copilot-test-status").textContent = "";
    try {
        const data = {
            tenantId: $("copilot-tenant").value.trim(),
            clientId: $("copilot-client").value.trim(),
            environmentId: $("copilot-environment").value.trim(),
            schemaName: $("copilot-schema").value.trim(),
        };
        const result = await api(scopedProviderPath("copilot"), { method: "POST", data });
        await loadSession();
        $("copilot-verification").href = result.verificationUrl;
        $("copilot-code").textContent = result.userCode;
        $("copilot-device").hidden = false;
        pollProviders();
    } catch (error) {
        notice(error.message);
        $("connect-copilot").disabled = false;
    }
};
$("test-copilot").onclick = async () => {
    $("test-copilot").disabled = true;
    $("copilot-test-status").textContent = "Checking the agent and workspace tools…";
    try {
        const result = await api(scopedProviderPath("copilot/test"), { method: "POST", data: {} });
        $("copilot-test-status").textContent = result.message;
    } catch (error) {
        $("copilot-test-status").textContent = error.message;
    } finally {
        $("test-copilot").disabled = false;
    }
};
for (const name of ["codex", "claude", "copilot"])
    $("disconnect-" + name).onclick = async () => {
        try {
            await api(scopedProviderPath(name), { method: "DELETE" });
            await loadSession();
        } catch (error) {
            notice(error.message);
        }
    };
loadSession()
    .then(async () => {
        if (session.authenticated && session.enabled) {
            await loadConnections();
            await list();
            workspaceLoaded = true;
            if (!current) reset();
            controls();
            if (!location.hash.startsWith("#share=") && sessionStorage.getItem("pending-share"))
                location.hash = sessionStorage.getItem("pending-share");
            sessionStorage.removeItem("pending-share");
            if (location.hash.startsWith("#share=")) await showShared();
        } else if (location.hash.startsWith("#share=")) {
            sessionStorage.setItem("pending-share", location.hash);
        }
    })
    .catch(() => notice("The chat service is currently unavailable. Please try again shortly."));

document.addEventListener("workspace:discuss", (event) => {
    $("message").value = event.detail.prompt;
    controls();
    $("message").focus();
});

async function ensureConversation() {
    if (!current) {
        current = await api("api/conversations", {
            method: "POST",
            data: {
                provider: $("chat-provider").value,
                repository: repositoryDraft || null,
                project: projectDraft || null,
                folder: folderDraft,
            },
        });
        renderDestinations();
    }
    return current;
}
function renderDestinations() {
    const selected = repositoryDraft;
    $("save-destination").replaceChildren(new Option("Enterprise repository", ""));
    for (const connection of personalConnections.filter((c) => c.kind !== "ckm"))
        $("save-destination").add(new Option(connection.label + " · " + connection.branch, connection.id));
    if (selected && !personalConnections.some((c) => c.id === selected))
        $("save-destination").add(new Option("Saved personal repository (load My sources to view)", selected));
    $("save-destination").value = selected || "";
    $("repository-folder").value = folderDraft;
    renderDestinationStatus();
    renderArtifacts();
}
function renderDestinationStatus() {
    const selected = repositoryDraft;
    const repository = personalConnections.find((item) => item.id === selected);
    $("repository-folder-control").hidden = !selected;
    $("use-project-folder").hidden = !chatProjects.some((item) => item.id === projectDraft);
    $("save-destination-status").textContent = repositorySaving
        ? "Saving repository choice…"
        : destinationChanged()
          ? "Not active yet. Press Save repository selection."
          : repository
            ? "Active: " +
              repository.url +
              " · " +
              repository.branch +
              " · " +
              (folderDraft ? folderDraft + "/" : "Repository root")
            : selected
              ? "Repository unavailable. Choose another destination."
              : "Your organisation's configured repository";
    $("repository-token-status").hidden =
        !repository || (repository.authenticated && !repository.lastWriteError && session?.allowWrites !== false);
    $("repository-token-status").textContent =
        repository && session?.allowWrites === false
            ? "Repository writes are disabled on this installation. Contact your workspace administrator."
            : repository && !repository.authenticated
              ? "Read-only connection. Use Update access in My sources and repositories to add a token for saving files."
              : repository?.lastWriteError?.message || "";
}
async function loadConnections() {
    const data = await api("api/connections");
    $("enterprise-ckm-status").hidden = !data.enterpriseUnavailable;
    personalConnections = data.personal;
    $("connection-list").replaceChildren();
    for (const item of [...data.enterprise, ...data.personal, ...(data.managed || [])]) {
        const row = document.createElement("div"),
            text = document.createElement("span");
        row.setAttribute("role", "listitem");
        text.textContent =
            item.label +
            " · " +
            (item.scope === "enterprise" ? "Enterprise" : item.scope === "global" ? "Shared" : "Personal") +
            " · " +
            item.url +
            (item.branch ? " · " + item.branch : "");
        row.append(text);
        if (item.lastWriteError) {
            const failure = document.createElement("p");
            failure.textContent = "Last save failed: " + item.lastWriteError.message;
            row.append(failure);
        }
        if (
            item.scope !== "enterprise" &&
            (item.scope !== "global" || session?.access?.permissions?.includes("manage-global-repositories"))
        ) {
            if (item.kind !== "ckm") {
                const update = document.createElement("button");
                update.type = "button";
                update.textContent = "Update access for " + item.label;
                update.onclick = () => {
                    $("repository-scope").value = item.scope === "global" ? "global" : "personal";
                    $("connection-kind").value = item.kind;
                    $("connection-kind").dispatchEvent(new Event("change"));
                    $("connection-label").value = item.label;
                    $("connection-url").value = item.url;
                    $("connection-branch").value = item.branch;
                    $("connection-token").value = "";
                    $("connection-token").focus();
                };
                row.append(update);
            }
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "Remove " + item.label;
            remove.onclick = async () => {
                try {
                    await api("api/connections/" + item.id + (item.scope === "global" ? "?scope=global" : ""), {
                        method: "DELETE",
                    });
                    await loadConnections();
                } catch (e) {
                    notice(e.message);
                }
            };
            row.append(remove);
        }
        $("connection-list").append(row);
    }
    renderDestinations();
}
$("retry-enterprise-ckms").onclick = async () => {
    $("retry-enterprise-ckms").disabled = true;
    try {
        await loadConnections();
    } catch {
        $("enterprise-ckm-status").hidden = false;
    } finally {
        $("retry-enterprise-ckms").disabled = false;
    }
};
$("personal-settings").ontoggle = () => {
    if ($("personal-settings").open) loadConnections().catch((e) => notice(e.message));
};
$("connection-kind").onchange = () => {
    const isCkm = $("connection-kind").value === "ckm";
    $("repository-fields").hidden = isCkm;
    $("connection-url").placeholder = isCkm
        ? "https://models.example.org/ckm/rest/"
        : "https://github.com/owner/models";
};
$("personal-connection").onsubmit = async (event) => {
    event.preventDefault();
    const data = {
        kind: $("connection-kind").value,
        label: $("connection-label").value,
        url: $("connection-url").value,
        ...($("connection-token").value ? { token: $("connection-token").value } : {}),
    };
    if (data.kind !== "ckm") data.branch = $("connection-branch").value;
    $("connection-token").value = "";
    try {
        const result = await api(
            "api/connections" + ($("repository-scope").value === "global" ? "?scope=global" : ""),
            { method: "POST", data },
        );
        await loadConnections();
        notice(
            result.updated
                ? "Repository access updated. Your saved selection is unchanged."
                : result.duplicate
                  ? "This connection is already available. No duplicate was added."
                  : result.connection.kind === "ckm"
                    ? "Connection saved."
                    : "Repository connection saved. Choose it under Save artifacts to and press Save repository selection to activate it.",
        );
    } catch (e) {
        notice(e.message);
    }
};
$("save-destination").onchange = async () => {
    repositoryDraft = $("save-destination").value;
    controls();
};
$("repository-folder").oninput = () => {
    folderDraft = $("repository-folder").value;
    controls();
};
$("use-project-folder").onclick = () => {
    folderDraft = chatProjects.find((item) => item.id === projectDraft)?.folder || "";
    $("repository-folder").value = folderDraft;
    controls();
};
$("save-repository-selection").onclick = async () => {
    repositorySaving = true;
    controls();
    try {
        if (!current) await ensureConversation();
        else
            current = await api("api/conversations/" + current.id + "/settings", {
                method: "PUT",
                data: { repository: repositoryDraft || null, folder: folderDraft },
            });
        await list();
    } catch (e) {
        notice(e.message);
    } finally {
        repositorySaving = false;
        repositoryDraft = current?.repository || "";
        folderDraft = current?.folder || "";
        renderDestinations();
        controls();
    }
};
function pendingAttachments() {
    const sent = new Set(
        (current?.messages || []).flatMap((message) => (message.attachments || []).map((item) => item.id)),
    );
    return (current?.attachments || []).filter((item) => !sent.has(item.id));
}
function fileSize(size) {
    return size >= 1024 * 1024
        ? (size / (1024 * 1024)).toFixed(1) + " MiB"
        : Math.max(1, Math.ceil(size / 1024)) + " KiB";
}
function attachmentCard(item, removable = true, queued = false) {
    const card = document.createElement("div");
    card.className = "attachment-card";
    card.dataset.status = item.status;
    const available = queued || current?.attachments?.some((file) => file.id === item.id);
    const url = available && !queued ? "/chat/api/conversations/" + current.id + "/attachments/" + item.id : null;
    if (item.image && url) {
        const preview = document.createElement("button"),
            image = document.createElement("img");
        preview.type = "button";
        preview.className = "attachment-thumbnail";
        preview.setAttribute("aria-label", "Preview " + item.name);
        image.src = url + "/preview";
        image.alt = "";
        image.loading = "lazy";
        preview.append(image);
        preview.onclick = () => {
            $("attachment-preview-title").textContent = item.name;
            $("attachment-preview-image").src = image.src;
            $("attachment-preview-image").alt = "Preview of " + item.name;
            $("attachment-preview-note").textContent = item.note;
            $("attachment-preview-download").href = url;
            $("attachment-preview-download").download = item.name;
            $("attachment-preview").showModal();
        };
        card.append(preview);
    } else {
        const icon = document.createElement("span");
        icon.className = "attachment-file-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML =
            '<svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>';
        card.append(icon);
    }
    const description = document.createElement("div"),
        name = document.createElement(url ? "a" : "span"),
        info = document.createElement("span");
    description.className = "attachment-description";
    name.className = "attachment-name";
    name.textContent = item.name;
    name.title = item.name;
    if (url) {
        name.href = url;
        name.download = item.name;
    }
    const statuses = {
        ready: "Text ready",
        image: "Image ready",
        partial: "Partly read",
        no_text: "No text found",
        unsupported: "Original only",
        failed: "Needs attention",
        uploading: "Uploading…",
        queued: "Waiting…",
    };
    info.className = "attachment-status";
    info.textContent =
        fileSize(item.size) + " · " + (available ? statuses[item.status] || item.status : "Removed from chat");
    description.append(name, info);
    if (item.note && !["ready", "image"].includes(item.status)) {
        const note = document.createElement("span");
        note.className = "attachment-note";
        note.textContent = item.note;
        description.append(note);
    }
    card.title = item.note || item.name;
    card.append(description);
    if (removable) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.textContent = "×";
        remove.setAttribute("aria-label", "Remove " + item.name);
        remove.disabled = running || uploading;
        remove.onclick = async () => {
            try {
                if (queued) uploadQueue = uploadQueue.filter((entry) => entry !== item);
                else {
                    const result = await api("api/conversations/" + current.id + "/attachments/" + item.id, {
                        method: "DELETE",
                    });
                    current.attachments = result.attachments;
                    renderThread();
                }
                renderAttachments();
            } catch (error) {
                notice(error.message);
            }
        };
        card.append(remove);
    }
    return card;
}
function renderThread() {
    $("thread").replaceChildren();
    for (const message of current?.messages || []) bubble(message);
}
function renderAttachments() {
    renderArtifacts();
    $("attachment-list").replaceChildren();
    const pending = pendingAttachments();
    for (const item of pending) $("attachment-list").append(attachmentCard(item));
    for (const item of uploadQueue) $("attachment-list").append(attachmentCard(item, true, true));
    const sent = (current?.attachments || []).filter((item) => !pending.includes(item));
    $("conversation-files").hidden = !sent.length || sharedView;
    $("conversation-files-title").textContent = "Files in this chat (" + sent.length + ")";
    $("conversation-file-list").replaceChildren();
    for (const item of sent) $("conversation-file-list").append(attachmentCard(item));
}
function renderArtifacts() {
    const artifacts = sharedView ? [] : current?.artifacts || [];
    const recovered = sharedView ? [] : current?.recovery?.drafts || [];
    $("conversation-artifacts").hidden = !artifacts.length && !recovered.length;
    $("conversation-artifacts-title").textContent = recovered.length
        ? "Artefacts and recovered drafts"
        : "Saved artefacts (" + artifacts.length + ")";
    const list = $("conversation-artifact-list");
    list.replaceChildren();
    for (const draft of recovered) {
        const item = document.createElement("li"),
            link = document.createElement("a");
        link.textContent =
            "Download draft: " + draft.name + " · " + draft.sha256.slice(0, 8) + " (not proof of a Git save)";
        link.href = "/chat/api/conversations/" + current.id + "/drafts/" + draft.id;
        item.append(link);
        list.append(item);
    }
    const copyButton = (label, value) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.onclick = async () => {
            try {
                await navigator.clipboard.writeText(value);
                button.textContent = "Copied";
            } catch {
                notice(
                    "Copy is unavailable in this browser. Select the file path or open the file to copy its address.",
                );
            }
        };
        return button;
    };
    for (const artifact of [...artifacts].sort((a, b) => a.path.localeCompare(b.path))) {
        const item = document.createElement("li"),
            path = document.createElement("code"),
            actions = document.createElement("div");
        const repo =
            personalConnections.find(
                (connection) => connection.id === artifact.repository && connection.kind !== "ckm",
            ) || artifact.destination;
        path.textContent = artifact.path;
        item.append(path);
        actions.className = "artifact-actions";
        actions.append(copyButton("Copy path", artifact.path));
        if (repo) {
            const url = (ref) =>
                repo.url +
                (repo.kind === "github" ? "/blob/" : "/-/blob/") +
                encodeURIComponent(ref) +
                "/" +
                artifact.path.split("/").map(encodeURIComponent).join("/");
            const link = document.createElement("a");
            link.textContent = "Open file";
            link.href = url(repo.branch);
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            const destination = document.createElement("small");
            destination.textContent = (repo.label || repo.url) + " · " + repo.branch;
            item.append(destination);
            actions.prepend(link);
            actions.append(copyButton("Copy link", link.href));
            const history = document.createElement("a");
            history.textContent = "Version history";
            history.href =
                repo.url +
                (repo.kind === "github" ? "/commits/" : "/-/commits/") +
                encodeURIComponent(repo.branch) +
                "/" +
                artifact.path.split("/").map(encodeURIComponent).join("/");
            history.target = "_blank";
            history.rel = "noopener noreferrer";
            actions.append(history);
            if (/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) {
                const fingerprint = document.createElement("small");
                fingerprint.textContent = "Saved SHA-256: " + artifact.sha256.slice(0, 12);
                fingerprint.title = artifact.sha256;
                item.append(fingerprint);
            }
            if (/^[a-f0-9]{40,64}$/.test(artifact.commit || "")) {
                const version = document.createElement("a");
                version.textContent = "Saved version";
                version.href = url(artifact.commit);
                version.target = "_blank";
                version.rel = "noopener noreferrer";
                actions.append(version, copyButton("Copy version link", version.href));
            }
        } else {
            const unavailable = document.createElement("small");
            unavailable.textContent =
                "The repository address is unavailable for this older entry. Its saved path is shown above.";
            item.append(unavailable);
        }
        item.append(actions);
        list.append(item);
    }
}
async function uploadFiles(files) {
    if (
        !files.length ||
        running ||
        uploading ||
        repositorySaving ||
        projectSaving ||
        destinationChanged() ||
        sharedView ||
        !session?.authenticated ||
        !session.enabled
    )
        return;
    uploading = true;
    uploadQueue = files.map((file) => ({ file, name: file.name, size: file.size, status: "queued" }));
    controls();
    renderAttachments();
    let added = 0;
    try {
        await ensureConversation();
        for (const entry of [...uploadQueue]) {
            entry.status = "uploading";
            $("upload-status").textContent = "Adding " + entry.name + "… You can keep writing your message.";
            renderAttachments();
            try {
                if (entry.size > 10 * 1024 * 1024) throw new Error("This file exceeds the 10 MiB limit.");
                if (!entry.size) throw new Error("This file is empty.");
                const existing = current.attachments || [];
                if (
                    existing.length >= 10 ||
                    existing.reduce((sum, item) => sum + item.size, 0) + entry.size > 30 * 1024 * 1024
                )
                    throw new Error("A chat supports 10 files and 30 MiB in total. Remove a file or start a new chat.");
                const response = await fetch("/chat/api/conversations/" + current.id + "/attachments", {
                    method: "POST",
                    headers: {
                        "X-CSRF-Token": session.csrf,
                        "X-File-Name": encodeURIComponent(entry.name),
                        "Content-Type": "application/octet-stream",
                    },
                    body: entry.file,
                });
                if (response.status === 401) await refreshSession();
                const item = await responseJson(response, true);
                current.attachments = [...existing, item];
                uploadQueue = uploadQueue.filter((item) => item !== entry);
                added++;
            } catch (error) {
                entry.status = "failed";
                entry.note = error.message;
                delete entry.file;
            }
            renderAttachments();
        }
        $("upload-status").textContent =
            added +
            (added === 1 ? " file added." : " files added.") +
            (uploadQueue.length ? " Some files need attention." : " Ready to send with your instructions.");
        await list();
    } catch (error) {
        uploadQueue = uploadQueue.map(({ file, ...item }) => ({ ...item, status: "failed", note: error.message }));
        $("upload-status").textContent = "Files could not be added. Check the message on each card.";
    } finally {
        uploading = false;
        controls();
        renderAttachments();
    }
}
$("attach-files").onclick = () => $("upload-files").click();
$("upload-files").onchange = () => {
    const files = Array.from($("upload-files").files);
    $("upload-files").value = "";
    uploadFiles(files);
};
$("close-attachment-preview").onclick = () => $("attachment-preview").close();
$("attachment-preview").addEventListener("close", () => $("attachment-preview-image").removeAttribute("src"));
let dragDepth = 0;
const composer = $("chat-form");
const fileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
composer.addEventListener("dragenter", (event) => {
    if (fileDrag(event)) {
        event.preventDefault();
        dragDepth++;
        composer.classList.add("drag-over");
    }
});
composer.addEventListener("dragover", (event) => {
    if (fileDrag(event)) event.preventDefault();
});
composer.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
        dragDepth = 0;
        composer.classList.remove("drag-over");
    }
});
composer.addEventListener("drop", (event) => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    composer.classList.remove("drag-over");
    uploadFiles(Array.from(event.dataTransfer.files));
});
$("message").addEventListener("paste", (event) => {
    const images = Array.from(event.clipboardData?.files || []).filter((file) =>
        ["image/png", "image/jpeg"].includes(file.type),
    );
    if (images.length) {
        event.preventDefault();
        uploadFiles(images);
    }
});
$("share-chat").onclick = () => {
    $("share-url").value = "";
    $("share-status").textContent = current.share
        ? "An existing link expires on " +
          new Date(current.share.expiresAt).toLocaleString() +
          ". Creating another link revokes it."
        : "No active link.";
    $("revoke-share").disabled = !current.share;
    $("share-dialog").showModal();
};
$("close-share").onclick = () => $("share-dialog").close();
$("create-share").onclick = async () => {
    try {
        const result = await api("api/conversations/" + current.id + "/share", { method: "POST", data: {} });
        $("share-url").value = location.origin + "/chat/#share=" + result.token;
        $("share-status").textContent =
            "Snapshot created. Copy the link above. It expires on " + new Date(result.expiresAt).toLocaleString() + ".";
        current.share = result;
        $("revoke-share").disabled = false;
        $("share-url").select();
    } catch (e) {
        $("share-status").textContent = e.message;
    }
};
$("revoke-share").onclick = async () => {
    try {
        await api("api/conversations/" + current.id + "/share", { method: "DELETE" });
        delete current.share;
        $("share-url").value = "";
        $("share-status").textContent = "Link revoked.";
        $("revoke-share").disabled = true;
    } catch (e) {
        $("share-status").textContent = e.message;
    }
};
async function showShared() {
    if (
        running ||
        uploading ||
        repositorySaving ||
        projectSaving ||
        !session?.authenticated ||
        !location.hash.startsWith("#share=")
    )
        return;
    try {
        const snapshot = await api("api/shares/" + encodeURIComponent(location.hash.slice(7)));
        reset();
        sharedView = true;
        $("welcome").hidden = true;
        $("thread").hidden = false;
        for (const message of snapshot.messages) bubble(message);
        notice("Shared snapshot: " + snapshot.title + ". Read-only; later messages and original files are not shared.");
        controls();
    } catch (e) {
        notice(e.message);
    }
}
window.addEventListener("hashchange", () => showShared());

$("provider-scope").onchange = async () => {
    providerScope = $("provider-scope").value;
    $("claude-key").value = "";
    $("codex-shared-key").value = "";
    for (const key of ["tenant", "client", "environment", "schema"]) $("copilot-" + key).value = "";
    try {
        await loadSession();
    } catch (error) {
        notice(error.message);
    }
};
