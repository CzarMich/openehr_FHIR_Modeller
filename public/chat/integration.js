const $ = (id) => document.getElementById(id);
// Tabs change presentation only. Hidden forms keep their values and review state.
const workflowTabs = [...document.querySelectorAll('[role="tab"]')];
function activateTab(tab, focus = false, updateHash = true) {
    for (const item of workflowTabs) {
        const active = item === tab;
        item.setAttribute("aria-selected", String(active));
        item.tabIndex = active ? 0 : -1;
        $(item.getAttribute("aria-controls")).hidden = !active;
    }
    if (updateHash) history.replaceState(null, "", "#" + tab.getAttribute("aria-controls"));
    if (focus) tab.focus({ preventScroll: true });
    tab.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function restoreTab() {
    const tab = workflowTabs.find((item) => "#" + item.getAttribute("aria-controls") === location.hash);
    if (tab) activateTab(tab, false, false);
}
for (const [index, tab] of workflowTabs.entries()) {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
        const next = ["ArrowRight", "ArrowDown"].includes(event.key)
            ? (index + 1) % workflowTabs.length
            : ["ArrowLeft", "ArrowUp"].includes(event.key)
              ? (index + workflowTabs.length - 1) % workflowTabs.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? workflowTabs.length - 1
                  : null;
        if (next === null) return;
        event.preventDefault();
        activateTab(workflowTabs[next], true);
    });
}
window.addEventListener("hashchange", restoreTab);
restoreTab();

let session,
    selected,
    privacyState,
    pending,
    busy = false;
const notice = (message) => {
    $("notice").textContent = message;
};
async function api(path, input, options = {}) {
    const response = await fetch("/chat/api/integration/" + path, {
        method: input === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "", ...options.headers },
        body: input === undefined ? undefined : options.raw ? input : JSON.stringify(input),
        signal: AbortSignal.timeout(660000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Integration operation failed.");
    return result;
}
const models = (target, input) => api("models?target=" + encodeURIComponent("/api/v1/integration/" + target), input);
const project = () => {
    if (!$("project").value) throw new Error("Choose a project first.");
    return $("project").value;
};
const pretty = (value) => JSON.stringify(value, null, 2);
function option(select, value, label) {
    const item = document.createElement("option");
    item.value = value;
    item.textContent = label;
    select.append(item);
}
function options(select, items, value, label) {
    const previous = select.value;
    select.replaceChildren();
    for (const item of items) option(select, value(item), label(item));
    if (items.some((item) => value(item) === previous)) select.value = previous;
}
function button(label, action) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = label;
    item.onclick = () => run(action);
    return item;
}
async function run(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button:not([role="tab"])').forEach((b) => (b.disabled = true));
    try {
        await action();
    } catch (error) {
        notice(error.message);
    } finally {
        busy = false;
        document.querySelectorAll('button:not([role="tab"])').forEach((b) => (b.disabled = false));
    }
}
function showReview(view) {
    selected = view;
    const clinical = JSON.parse(view.executionMapping).clinicalPolicy;
    if (clinical) {
        $("identity-domain").value = clinical.identityDomain;
        $("identity-destination").value = clinical.destinationId;
        $("identity-hold-days").value = clinical.holdDays || 30;
        $("identity-references").replaceChildren();
        for (const reference of clinical.references || []) addReference(reference);
    }
    $("review").replaceChildren();
    $("reviewed").checked = false;
    $("decision-comment").value = "";
    for (const item of view.items) {
        const details = document.createElement("details"),
            summary = document.createElement("summary"),
            pre = document.createElement("pre");
        summary.textContent =
            item.pin.standard + " · " + item.pin.id + " · " + item.pin.version + " · " + item.pin.origin;
        pre.textContent = pretty(item);
        details.append(summary, pre);
        $("review").append(details);
    }
    const rules = document.createElement("pre");
    rules.textContent = pretty({
        subject: view.subject,
        state: view.state,
        sequence: view.sequence,
        mapping: JSON.parse(view.executionMapping),
        reuseContext: view.reuseContext || null,
        clinicalApproval: view.clinicalApproval,
    });
    $("review").append(rules);
}
async function load() {
    const id = project();
    $("active-project").textContent = $("project").selectedOptions[0]?.textContent || id;
    const [provided, mappings, connections] = await Promise.all([
        models("projects/" + id + "/models"),
        models("projects/" + id + "/mappings"),
        api("connections?projectId=" + encodeURIComponent(id)),
    ]);
    $("models").replaceChildren();
    for (const model of provided.items) {
        const label = document.createElement("label"),
            check = document.createElement("input");
        check.type = "checkbox";
        check.value = model.key;
        check.dataset.model = "true";
        check.dataset.standard = model.standard;
        label.className = "item";
        label.append(
            check,
            document.createTextNode(
                model.standard +
                    " · " +
                    model.id +
                    " · " +
                    model.version +
                    " · " +
                    model.origin +
                    " · SHA256 " +
                    model.sha256,
            ),
        );
        $("models").append(label);
    }
    options(
        $("mapping"),
        mappings.items,
        (item) => item.subject,
        (item) => item.name + " " + item.version + " · " + item.state,
    );
    options(
        $("source"),
        connections.sources,
        (item) => item.id,
        (item) => item.displayName + " (" + item.format + ")",
    );
    options(
        $("destination"),
        connections.destinations,
        (item) => item.id,
        (item) => item.displayName,
    );
    $("review").replaceChildren();
    selected = null;
    notice("Project loaded. Clinical database policy: " + connections.clinicalDatabasePolicy + ".");
}
async function refresh() {
    const projects = await models("projects");
    options(
        $("project"),
        projects.items,
        (item) => item.id,
        (item) => item.name + " · " + item.fhirVersion,
    );
    if (projects.items.length) await load();
    else notice("Create a project or ask an authorised modeller to provide access.");
    await jobs();
}
async function files() {
    const items = await api(
        "files?projectId=" + encodeURIComponent(project()) + "&sourceId=" + encodeURIComponent($("source").value),
    );
    options(
        $("file"),
        items.items,
        (item) => item.name,
        (item) => item.name + " · " + item.size + " bytes",
    );
}
function input() {
    return {
        projectId: project(),
        subject: $("mapping").value,
        sourceId: $("source").value,
        file: $("file").value,
        mode: $("mode").value,
        destinationId: $("destination").value || null,
    };
}
function reviewOperation(kind, result) {
    pending = { kind, token: result.confirmation };
    $("confirmation-detail").textContent = pretty(result.summary);
    $("confirmation").hidden = false;
    activateTab(
        workflowTabs.find((tab) => tab.getAttribute("aria-controls") === "run-step"),
        true,
    );
    notice("Review the exact source, mapping and destination, then confirm.");
}
async function jobs() {
    const [jobs, channels] = await Promise.all([api("jobs"), api("channels")]);
    options(
        $("recovery-job"),
        jobs.items,
        (item) => item.id,
        (item) => item.id.slice(0, 12) + " · " + item.status,
    );
    $("jobs").replaceChildren();
    for (const job of jobs.items) {
        const row = document.createElement("div"),
            text = document.createElement("p");
        row.className = "item";
        text.textContent =
            job.id +
            " · " +
            job.status +
            " · Read " +
            (job.read || 0) +
            " · Rejected " +
            (job.rejected || 0) +
            " · Held " +
            (job.held || 0) +
            " · Emitted " +
            (job.emitted || 0);
        row.append(
            text,
            button("Report", async () => {
                $("report").textContent = pretty(await api("jobs/" + job.id + "/report"));
            }),
            button("Cancel", async () => {
                await api("jobs/" + job.id + "/cancel", {});
                await jobs();
            }),
            button("Resume / reconcile", async () => {
                await api("jobs/" + job.id + "/resume", {});
                await jobs();
            }),
        );
        for (const [kind, label] of [
            ["download", "Validated export"],
            ["quarantine", "Private quarantine"],
            ["original", "Received source"],
            ["patient-index", "Patient association index"],
        ]) {
            const link = document.createElement("a");
            link.href = "/chat/api/integration/jobs/" + job.id + "/" + kind;
            link.textContent = label;
            link.className = "download-link";
            row.append(link);
        }
        $("jobs").append(row);
    }
    $("channels").replaceChildren();
    for (const channel of channels.items) {
        const row = document.createElement("div"),
            text = document.createElement("pre");
        row.className = "item";
        text.textContent = pretty(channel);
        row.append(
            text,
            button("Start", async () => {
                await api("channels/" + channel.id + "/start", {});
                await jobs();
            }),
            button("Pause", async () => {
                await api("channels/" + channel.id + "/pause", {});
                await jobs();
            }),
        );
        $("channels").append(row);
    }
}
$("refresh").onclick = () => run(refresh);
$("project").onchange = () => run(load);
$("create-project").onclick = () =>
    run(async () => {
        await models("projects", {
            projectId: $("project-id").value,
            configuration: JSON.parse($("project-json").value),
        });
        await refresh();
    });
$("model-file").onchange = () =>
    run(async () => {
        const file = $("model-file").files[0];
        if (!file) return;
        if (file.size > 2097152) throw new Error("Model files must be within 2 MiB.");
        $("model-content").value = await file.text();
        if ($("model-standard").value === "FHIR") {
            const model = JSON.parse($("model-content").value);
            if (model.resourceType === "StructureDefinition") {
                const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode($("model-content").value));
                $("model-version").value =
                    model.version ||
                    "sha256-" + [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
            }
        }
    });
$("provide-model").onclick = () =>
    run(async () => {
        await models("projects/" + project() + "/models", {
            id: $("model-id").value,
            standard: $("model-standard").value,
            version: $("model-version").value,
            origin: $("model-origin").value,
            content: $("model-content").value,
            provenance: { source: $("model-provenance").value },
        });
        await load();
    });
$("prepare").onclick = () =>
    run(async () => {
        const view = await models("projects/" + project() + "/mappings", {
            modelKeys: [...document.querySelectorAll("[data-model]:checked")].map((e) => e.value),
            executionMapping: JSON.stringify(JSON.parse($("mapping-json").value)),
            ...($("save-for-reuse").checked ? { reuseContext: reuseContext() } : {}),
        });
        await load();
        $("mapping").value = view.subject;
        showReview(view);
        notice("Mapping prepared. Human review is required.");
    });
$("load-mapping").onclick = () =>
    run(async () => {
        showReview(await models("mappings/" + $("mapping").value));
    });
for (const [id, decision] of [
    ["confirm", "CONFIRMED"],
    ["revoke", "REVOKED"],
])
    $(id).onclick = () =>
        run(async () => {
            if (!selected || !$("reviewed").checked || !$("decision-comment").value.trim())
                throw new Error("Inspect the models and rules, tick the acknowledgement and enter a comment.");
            const view = await models("mappings/" + selected.subject + "/decisions", {
                decision,
                expectedSequence: selected.sequence,
                comment: $("decision-comment").value,
            });
            await load();
            $("mapping").value = view.subject;
            showReview(view);
            notice("Recorded " + decision + " for this exact mapping version.");
        });
$("upload").onclick = () =>
    run(async () => {
        const file = $("source-upload").files[0];
        if (!file || file.size > 16777216) throw new Error("Choose a private file within 16 MiB.");
        const item = await api("sources/upload", file, {
            raw: true,
            headers: {
                "Content-Type": "application/octet-stream",
                "X-Model-Project": project(),
                "X-Source-Format": $("source-format").value,
                "X-Source-Name": encodeURIComponent(file.name),
                "X-Source-Name-Encoding": "uri",
                "X-Source-Domain": encodeURIComponent($("source-domain").value),
            },
        });
        await load();
        $("source").value = item.id;
        await files();
        notice("Uploaded privately. No record values were sent to the model or chat.");
    });
$("files").onclick = () => run(files);
$("source").onchange = () => run(files);
$("inspect").onclick = () =>
    run(async () => {
        const contracts = [...document.querySelectorAll("[data-model]:checked")].filter(
            (input) => input.dataset.standard === "source-contract",
        );
        if (contracts.length > 1) throw new Error("Select one source contract to inspect its declared projection.");
        const inspection = await api("sources/inspect", {
            ...(contracts.length === 1 ? { sourceContractKey: contracts[0].value } : {}),
            projectId: project(),
            sourceId: $("source").value,
            file: $("file").value,
        });
        $("inspection").textContent = pretty(inspection);
        if (typeof inspection.schemaSha256 === "string") $("reuse-schema").value = inspection.schemaSha256;
    });
$("run-preview").onclick = () => run(async () => reviewOperation("jobs", await api("jobs/preview", input())));
$("channel-preview").onclick = () =>
    run(async () => {
        const value = input();
        delete value.file;
        reviewOperation(
            "channels",
            await api("channels/preview", {
                ...value,
                name: $("channel-name").value,
                pollSeconds: Number($("poll").value),
                failurePolicy: $("failure-policy").value,
            }),
        );
    });
$("commit").onclick = () =>
    run(async () => {
        if (!pending) return;
        const value = pending;
        pending = null;
        $("confirmation").hidden = true;
        await api(value.kind + (value.kind.startsWith("vendor-sources/") ? "-commit" : "/commit"), {
            confirmation: value.token,
        });
        if (value.kind.startsWith("vendor-sources/")) {
            await vendorList();
            await load();
        }
        $("confirmation-detail").textContent = "";
        if (value.kind === "patient-resolution") {
            $("resolve-patient-value").value = "";
            $("resolve-patient-comment").value = "";
        }
        if (value.kind === "relationship-resolution") {
            $("resolve-relation-value").value = "";
            $("resolve-relation-comment").value = "";
        }
        await jobs();
        notice("Operation confirmed. Review status in Jobs & monitoring.");
    });
$("dismiss").onclick = () => {
    pending = null;
    $("confirmation").hidden = true;
    $("confirmation-detail").textContent = "";
};
$("jobs-refresh").onclick = () => run(jobs);
run(async () => {
    const response = await fetch("/chat/api/session");
    session = await response.json();
    if (!session.authenticated) throw new Error("Sign in through the modelling workspace, then return here.");
    if (!session.integrationReady) throw new Error("The C# integration service is not enabled or ready.");
    await refresh();
});

let groupState,
    groupDirectory = [],
    groupChannels = [];
const currentGroup = () => groupState?.groups.find((item) => item.id === $("channel-group").value);
const currentTeam = () => groupState?.teams.find((item) => item.id === $("channel-team").value);
async function refreshGroups() {
    groupState = await api("channel-groups");
    const manages =
        groupState.canCreate ||
        [...groupState.groups, ...groupState.teams].some((item) => item.owner === groupState.self);
    groupDirectory = manages ? (await api("channel-groups/directory")).items : [];
    groupChannels = manages ? (await api("channels")).items : [];
    options(
        $("channel-group"),
        groupState.groups,
        (g) => g.id,
        (g) => g.name,
    );
    options(
        $("channel-team"),
        groupState.teams.filter((t) => t.owner === groupState.self),
        (t) => t.id,
        (t) => t.name,
    );
    options(
        $("group-owned-channel"),
        groupChannels,
        (c) => c.id,
        (c) => c.name,
    );
    for (const id of ["group-next-owner", "team-next-owner"])
        options(
            $(id),
            groupDirectory.filter((p) => p.id !== groupState.self),
            (p) => p.id,
            (p) => p.label,
        );
    $("group-management").hidden = !manages;
    $("team-management").hidden = !manages;
    $("group-create").hidden = !groupState.canCreate;
    $("team-create").hidden = !groupState.canCreate;
    $("group-name").disabled = !groupState.canCreate;
    $("team-name").disabled = !groupState.canCreate;
    $("group-access-history").textContent = "";
    renderGroup();
    renderTeam();
    notice("Groups refreshed. Membership changes take effect on the next request. Private results remain private.");
}
function renderGroup() {
    const group = currentGroup(),
        owner = group?.owner === groupState?.self;
    $("group-owner-controls").hidden = !owner;
    $("group-monitor").replaceChildren();
    $("group-grants").replaceChildren();
    if (!group) {
        $("group-monitor").textContent = "No shared channel groups are available to your account.";
        return;
    }
    for (const channel of group.channels) {
        const row = document.createElement("div"),
            detail = document.createElement("pre");
        row.className = "item";
        detail.textContent = pretty(channel);
        row.append(detail);
        if (owner)
            row.append(
                button("Remove from group", async () => {
                    await api("channel-groups", {
                        kind: "group",
                        action: "detach",
                        id: group.id,
                        expectedRevision: group.revision,
                        reference: channel.reference,
                    });
                    await refreshGroups();
                }),
            );
        $("group-monitor").append(row);
    }
    if (!owner) return;
    const candidates = [
        ...groupDirectory.map((p) => ({ ...p, kind: "user" })),
        ...groupState.teams
            .filter((t) => t.owner === groupState.self || group.grants?.some((g) => g.kind === "team" && g.id === t.id))
            .map((t) => ({ id: t.id, label: "Team: " + t.name, kind: "team" })),
    ];
    for (const candidate of candidates) {
        const label = document.createElement("label"),
            select = document.createElement("select");
        label.append(document.createTextNode(candidate.label + " "));
        option(select, "", "No access");
        option(select, "view", "View");
        option(select, "monitor", "View and monitor");
        const previous = group.grants?.find((g) => g.kind === candidate.kind && g.id === candidate.id);
        select.value = previous?.permissions.includes("monitor") ? "monitor" : previous ? "view" : "";
        select.dataset.principal = candidate.id;
        select.dataset.kind = candidate.kind;
        label.append(select);
        $("group-grants").append(label);
    }
}
function renderTeam() {
    $("team-members").replaceChildren();
    const team = currentTeam();
    $("team-save-members").disabled = !team;
    $("team-transfer").disabled = !team;
    if (!team) return;
    for (const person of groupDirectory) {
        const label = document.createElement("label"),
            check = document.createElement("input");
        check.type = "checkbox";
        check.value = person.id;
        check.checked = team.members.includes(person.id);
        label.append(check, document.createTextNode(person.label));
        $("team-members").append(label);
    }
}
$("groups-refresh").onclick = () => run(refreshGroups);
$("channel-group").onchange = renderGroup;
$("channel-team").onchange = renderTeam;
for (const kind of ["group", "team"]) {
    $(kind + "-create").onclick = () =>
        run(async () => {
            await api("channel-groups", { kind, action: "create", name: $(kind + "-name").value });
            $(kind + "-name").value = "";
            await refreshGroups();
        });
    $(kind + "-transfer").onclick = () =>
        run(async () => {
            const item = kind === "group" ? currentGroup() : currentTeam();
            if (!item) throw new Error("Choose a group or team first.");
            const newOwner = $(kind + "-next-owner").value;
            if (!newOwner) throw new Error("Choose the new owner first.");
            if (!window.confirm("Transfer ownership? Your management access will end immediately.")) return;
            await api("channel-groups", {
                kind,
                action: "transfer",
                id: item.id,
                expectedRevision: item.revision,
                newOwner,
            });
            await refreshGroups();
        });
}
$("group-attach").onclick = () =>
    run(async () => {
        const group = currentGroup();
        if (!group) throw new Error("Choose a group first.");
        if (
            !window.confirm(
                "Share this channel's operational metadata with the selected group's members? Private records and results remain private.",
            )
        )
            return;
        await api("channel-groups", {
            kind: "group",
            action: "attach",
            id: group.id,
            expectedRevision: group.revision,
            channelId: $("group-owned-channel").value,
        });
        await refreshGroups();
    });
$("group-save-grants").onclick = () =>
    run(async () => {
        const group = currentGroup();
        if (!group) throw new Error("Choose a group first.");
        const grants = [...$("group-grants").querySelectorAll("select")]
            .filter((select) => select.value)
            .map((select) => ({
                kind: select.dataset.kind,
                id: select.dataset.principal,
                permissions: [select.value],
            }));
        await api("channel-groups", {
            kind: "group",
            action: "grants",
            id: group.id,
            expectedRevision: group.revision,
            grants,
        });
        await refreshGroups();
    });
$("team-save-members").onclick = () =>
    run(async () => {
        const team = currentTeam();
        if (!team) throw new Error("Choose a team first.");
        const members = [...$("team-members").querySelectorAll("input:checked")].map((check) => check.value);
        await api("channel-groups", {
            kind: "team",
            action: "members",
            id: team.id,
            expectedRevision: team.revision,
            members,
        });
        await refreshGroups();
    });
$("group-audit").onclick = () =>
    run(async () => {
        const group = currentGroup();
        if (!group) throw new Error("Choose a group first.");
        $("group-access-history").textContent = pretty(await api("channel-groups/" + group.id + "/audit"));
    });

function reuseContext() {
    const context = {
        sourceSystem: $("reuse-source-system").value.trim(),
        sourceSemanticsVersion: $("reuse-semantics").value.trim(),
        purpose: $("reuse-purpose").value.trim(),
        terminologyPins: JSON.parse($("reuse-terminology").value),
    };
    if (
        !context.sourceSystem ||
        !context.sourceSemanticsVersion ||
        !context.purpose ||
        !Array.isArray(context.terminologyPins)
    )
        throw new Error("Provide the verified source identity, meaning version, intended use and terminology pins.");
    return context;
}
$("find-reuse").onclick = () =>
    run(async () => {
        const requirements = $("reuse-narrative")
            .value.trim()
            .split(/\n\s*\n/)
            .filter(Boolean)
            .map((text, index) => ({ id: "USER-" + (index + 1), originalText: text, basis: "user-instruction" }));
        if (!requirements.length) throw new Error("Provide the original user instructions for the work to reuse.");
        const result = await api("mapping-reuse", {
            projectId: project(),
            query: {
                context: reuseContext(),
                sourceSchemaSha256: $("reuse-schema").value.trim(),
                requirements,
                modelKeys: [...document.querySelectorAll("[data-model]:checked")].map((check) => check.value),
                direction: $("reuse-direction").value,
            },
        });
        $("reuse-results").replaceChildren();
        for (const item of result.items) {
            const row = document.createElement("div"),
                label = document.createElement("p");
            row.className = "item";
            label.textContent =
                item.name +
                " " +
                item.version +
                " · " +
                (item.eligibleForReuse
                    ? "Exact context; currently confirmed"
                    : "Existing draft requires human confirmation");
            row.append(
                label,
                button("Inspect saved mapping", async () => {
                    const view = await models("mappings/" + item.subject);
                    $("mapping-json").value = view.executionMapping;
                    $("mapping").value = item.subject;
                    showReview(view);
                    notice(
                        "Loaded saved work without AI generation. Processing still checks confirmation, source, validation and destination permissions.",
                    );
                }),
            );
            $("reuse-results").append(row);
        }
        if (!result.items.length)
            $("reuse-results").textContent =
                "No exact context match. Existing mappings without a confirmed reuse context remain available in the mapping list for manual inspection; no new AI request was made.";
        notice(
            "Reuse lookup made " +
                result.providerCalls +
                " provider calls." +
                (result.complete ? "" : " Search limit reached; narrow the project or inspect saved mappings."),
        );
    });

function privacyTarget() {
    const destination = $("identity-destination").value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(destination))
        throw new Error("Enter the stable destination identifier.");
    return "projects/" + project() + "/destinations/" + destination + "/privacy";
}
function privacyDisplay(value) {
    privacyState = { ...value, projectId: project(), destinationId: $("identity-destination").value.trim() };
    $("pseudonymise").checked = value.pseudonymisePatientIdentifiers;
    $("pseudonym-system").value = value.pseudonymSystem || "";
    $("privacy-reviewed").checked = false;
    $("privacy-status").textContent =
        "Destination identity policy revision " + value.revision + ". Patient prerequisite remains mandatory.";
}
$("privacy-load").onclick = () => run(async () => privacyDisplay(await models(privacyTarget())));
$("privacy-save").onclick = () =>
    run(async () => {
        if (
            !privacyState ||
            privacyState.projectId !== project() ||
            privacyState.destinationId !== $("identity-destination").value.trim() ||
            !$("privacy-reviewed").checked
        )
            throw new Error("Load the destination settings and acknowledge your review first.");
        privacyDisplay(
            await models(privacyTarget(), {
                expectedRevision: privacyState.revision,
                pseudonymisePatientIdentifiers: $("pseudonymise").checked,
                pseudonymSystem: $("pseudonymise").checked ? $("pseudonym-system").value.trim() : null,
            }),
        );
        notice("Destination settings saved. Apply the revision to a new mapping draft and obtain human confirmation.");
    });
function addReference(value = {}) {
    const row = document.createElement("tr");
    for (const [key, label] of [
        ["role", "Source role"],
        ["targetType", "Target type"],
        ["path", "Output path"],
    ]) {
        const cell = document.createElement("td"),
            input = document.createElement("input");
        input.dataset.field = key;
        input.setAttribute("aria-label", label);
        input.value = value[key] || "";
        cell.append(input);
        row.append(cell);
    }
    const modeCell = document.createElement("td"),
        mode = document.createElement("select");
    mode.dataset.field = "mode";
    mode.setAttribute("aria-label", "Reference mode");
    for (const [key, label] of [
        ["logical", "Logical identifier"],
        ["literal", "Verified literal"],
        ["resolve-literal", "Resolve to literal"],
    ])
        option(mode, key, label);
    mode.value = value.mode || "resolve-literal";
    modeCell.append(mode);
    row.append(modeCell);
    const requiredCell = document.createElement("td"),
        required = document.createElement("input");
    required.type = "checkbox";
    required.dataset.field = "requireDestination";
    required.checked = value.requireDestination !== false;
    required.setAttribute("aria-label", "Require verified destination resource");
    requiredCell.append(required);
    row.append(requiredCell);
    const action = document.createElement("td");
    action.append(button("Remove relationship", () => row.remove()));
    row.append(action);
    $("identity-references").append(row);
}
$("reference-add").onclick = () => addReference();
$("identity-apply").onclick = () =>
    run(async () => {
        if (
            !privacyState ||
            privacyState.projectId !== project() ||
            privacyState.destinationId !== $("identity-destination").value.trim() ||
            privacyState.pseudonymisePatientIdentifiers !== $("pseudonymise").checked ||
            (privacyState.pseudonymSystem || "") !== $("pseudonym-system").value.trim()
        )
            throw new Error("Load and save the current destination settings before applying them.");
        const definition = JSON.parse($("mapping-json").value),
            source = [...document.querySelectorAll("[data-model]:checked")].filter(
                (input) => input.dataset.standard === "source-contract",
            );
        if (source.length !== 1) throw new Error("Select exactly one supplied source contract in Models.");
        const references = [...$("identity-references").children].map((row) =>
            Object.fromEntries(
                [...row.querySelectorAll("[data-field]")].map((input) => [
                    input.dataset.field,
                    input.type === "checkbox" ? input.checked : input.value.trim(),
                ]),
            ),
        );
        definition.sourceProfileKey = source[0].value;
        definition.clinicalPolicy = {
            schemaVersion: 1,
            identityDomain: $("identity-domain").value.trim(),
            destinationId: privacyState.destinationId,
            privacyPolicyRevision: privacyState.revision,
            pseudonymisePatientIdentifiers: privacyState.pseudonymisePatientIdentifiers,
            pseudonymSystem: privacyState.pseudonymSystem,
            references,
            publications: definition.clinicalPolicy?.publications || [],
            holdDays: Number($("identity-hold-days").value),
        };
        $("mapping-json").value = pretty(definition);
        notice(
            "Identity settings applied to the draft. Increment the mapping version, prepare and confirm its exact models and rules.",
        );
    });
$("source-trust-review").onclick = () =>
    run(async () => {
        const result = await api("source-trust/preview", {
            projectId: project(),
            subject: $("mapping").value,
            sourceId: $("source").value,
            comment: $("source-trust-comment").value,
        });
        reviewOperation("source-trust", result);
        activateTab($("tab-run"));
    });

$("recovery-report-load").onclick = () =>
    run(async () => {
        const job = $("recovery-job").value;
        if (!/^[a-f0-9]{64}$/.test(job)) throw new Error("Choose a private job.");
        $("recovery-report").textContent = pretty(await api("jobs/" + job + "/report"));
    });
$("resolve-patient-preview").onclick = () =>
    run(async () => {
        const result = await api("patient-resolution/preview", {
            jobId: $("recovery-job").value,
            record: Number($("recovery-record").value),
            patientSystem: $("resolve-patient-system").value,
            patientValue: $("resolve-patient-value").value,
            comment: $("resolve-patient-comment").value,
        });
        reviewOperation("patient-resolution", result);
        activateTab($("tab-run"));
    });
$("recovery-preview").onclick = () =>
    run(async () => {
        const result = await api("recovery/preview", {
            jobId: $("recovery-job").value,
            record: Number($("recovery-record").value),
            action: $("recovery-action").value,
            comment: $("recovery-comment").value,
        });
        reviewOperation("recovery", result);
        activateTab($("tab-run"));
    });

$("resolve-relation-preview").onclick = () =>
    run(async () => {
        const result = await api("relationship-resolution/preview", {
            jobId: $("recovery-job").value,
            record: Number($("recovery-record").value),
            role: $("resolve-relation-role").value,
            identifierSystem: $("resolve-relation-system").value,
            identifierValue: $("resolve-relation-value").value,
            comment: $("resolve-relation-comment").value,
        });
        reviewOperation("relationship-resolution", result);
        activateTab($("tab-run"));
    });

// Vendor credentials never enter model requests, saved mapping JSON or review summaries.
let vendorConnections = [];
async function vendorList() {
    const response = await api("vendor-sources?projectId=" + encodeURIComponent(project()));
    vendorConnections = response.items;
    options(
        $("vendor-connector"),
        response.connectors,
        (item) => item.id,
        (item) => item.label,
    );
    options(
        $("vendor-connection"),
        vendorConnections,
        (item) => item.id,
        (item) => item.displayName + " · " + item.connector + " · " + (item.enabled ? "enabled" : "disabled"),
    );
    vendorShow();
    vendorKind();
}
function vendorShow() {
    const item = vendorConnections.find((item) => item.id === $("vendor-connection").value);
    $("vendor-status").textContent = pretty(item || { notice: "Configure a source connection." });
    $("vendor-agent-metadata").checked = !!item?.allowAgentMetadata;
}
function vendorKind() {
    const connector = $("vendor-connector").value,
        apiSource = ["epic-fhir", "fhir-api", "sap-bw", "clinical-rest-api"].includes(connector);
    $("vendor-database").hidden = apiSource;
    $("vendor-api").hidden = !apiSource;
    $("vendor-hana-driver").hidden = connector !== "sap-hana";
    for (const id of ["vendor-records-pointer", "vendor-next-pointer"])
        $(id).closest("label").hidden = connector !== "clinical-rest-api";
    $("vendor-analytics").closest("label").hidden = connector !== "sap-bw";
    $("vendor-fhir-release").closest("label").hidden = !["epic-fhir", "fhir-api"].includes(connector);
    vendorAuth();
}
function vendorInput() {
    const connector = $("vendor-connector").value;
    const lines = (id) =>
        $(id)
            .value.split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
    let profile;
    if (["epic-fhir", "fhir-api", "sap-bw", "clinical-rest-api"].includes(connector))
        profile = {
            connector,
            baseUrl: $("vendor-base").value,
            recordsPointer: $("vendor-records-pointer").value,
            nextPointer: $("vendor-next-pointer").value || null,
            readPaths: lines("vendor-read-paths"),
            fhirVersion: $("vendor-fhir-release").value,
            analytics: connector === "sap-bw" ? JSON.parse($("vendor-analytics").value) : null,
            authentication: {
                mode: $("vendor-auth").value,
                token: $("vendor-token").value || null,
                user: $("vendor-api-user").value || null,
                password: $("vendor-api-password").value || null,
                tokenEndpoint: $("vendor-token-endpoint").value || null,
                clientId: $("vendor-client-id").value || null,
                clientSecret: $("vendor-client-secret").value || null,
                scopes: $("vendor-scopes").value.split(/\s+/).filter(Boolean),
                keyId: $("vendor-key-id").value || null,
                privateKeyPem: $("vendor-private-key").value || null,
                algorithm: $("vendor-algorithm").value,
            },
        };
    else
        profile = {
            connector,
            host: $("vendor-host").value,
            port: Number($("vendor-port").value),
            database: $("vendor-database-name").value,
            user: $("vendor-user").value,
            password: $("vendor-password").value,
            schemas: lines("vendor-schemas"),
            driverSha256: $("vendor-driver-sha").value || null,
        };
    return {
        projectId: project(),
        displayName: $("vendor-name").value,
        identityDomain: $("vendor-domain").value,
        profile,
        allowAgentMetadata: $("vendor-agent-metadata").checked,
    };
}
$("vendor-refresh").onclick = () => run(vendorList);
$("vendor-connection").onchange = vendorShow;
$("vendor-connector").onchange = () => {
    vendorKind();
    const ports = {
        sqlserver: 1433,
        "epic-clarity-sqlserver": 1433,
        oracle: 2484,
        "epic-clarity-oracle": 2484,
        postgresql: 5432,
        mysql: 3306,
        mariadb: 3306,
        "sap-hana": 30015,
    };
    $("vendor-port").value = ports[$("vendor-connector").value] || 443;
};
$("vendor-profile-preview").onclick = () =>
    run(async () => {
        const ticket = await api("vendor-sources/profile-preview", vendorInput());
        for (const id of [
            "vendor-password",
            "vendor-token",
            "vendor-api-password",
            "vendor-client-secret",
            "vendor-private-key",
        ])
            $(id).value = "";
        reviewOperation("vendor-sources/profile", ticket);
    });
$("vendor-discover").onclick = () =>
    run(async () => {
        const result = await api("vendor-sources/discover", {
            projectId: project(),
            id: $("vendor-connection").value,
            query: $("vendor-query").value,
            afterTableId: Number($("vendor-after-table").value),
            tableId: $("vendor-table-id").value ? Number($("vendor-table-id").value) : null,
            afterColumnId: Number($("vendor-after-column").value),
        });
        $("vendor-metadata").textContent = pretty(result.metadata);
        await vendorList();
    });
$("vendor-plan-preview").onclick = () =>
    run(async () => {
        const item = vendorConnections.find((item) => item.id === $("vendor-connection").value);
        if (!item) throw new Error("Choose a connection.");
        const isApi = ["epic-fhir", "fhir-api", "sap-bw", "clinical-rest-api"].includes(item.connector);
        const ticket = await api("vendor-sources/plan-preview", {
            projectId: project(),
            id: item.id,
            plan: isApi ? null : JSON.parse($("vendor-plan").value),
            readPath: isApi ? $("vendor-read-path").value : null,
            cursor: $("vendor-capture-mode").value === "append" ? JSON.parse($("vendor-cursor").value) : null,
            appendOnlyAcknowledged: $("vendor-append-ack").checked,
            comment: $("vendor-plan-comment").value,
        });
        reviewOperation("vendor-sources/plan", ticket);
    });
$("vendor-capture").onclick = () =>
    run(async () => {
        const result = await api("vendor-sources/refresh", { projectId: project(), id: $("vendor-connection").value });
        $("vendor-status").textContent = pretty(result);
        await load();
    });
$("vendor-disable").onclick = () =>
    run(async () => {
        const item = vendorConnections.find((item) => item.id === $("vendor-connection").value);
        if (!item) throw new Error("Choose a connection.");
        await api("vendor-sources/disable", { projectId: project(), id: item.id, expectedRevision: item.revision });
        await vendorList();
        await load();
    });

$("vendor-enable").onclick = () =>
    run(async () => {
        const item = vendorConnections.find((item) => item.id === $("vendor-connection").value);
        if (!item) throw new Error("Choose a connection.");
        await api("vendor-sources/enable", { projectId: project(), id: item.id, expectedRevision: item.revision });
        await vendorList();
        await load();
    });

function vendorAuth() {
    const mode = $("vendor-auth").value;
    const shown =
        {
            bearer: ["vendor-token"],
            basic: ["vendor-api-user", "vendor-api-password"],
            "oauth-client-secret": [
                "vendor-token-endpoint",
                "vendor-client-id",
                "vendor-client-secret",
                "vendor-scopes",
            ],
            "smart-private-key-jwt": [
                "vendor-token-endpoint",
                "vendor-client-id",
                "vendor-scopes",
                "vendor-key-id",
                "vendor-algorithm",
                "vendor-private-key",
            ],
        }[mode] || [];
    for (const id of [
        "vendor-token",
        "vendor-api-user",
        "vendor-api-password",
        "vendor-token-endpoint",
        "vendor-client-id",
        "vendor-client-secret",
        "vendor-scopes",
        "vendor-key-id",
        "vendor-algorithm",
        "vendor-private-key",
    ])
        $(id).closest("label").hidden = !shown.includes(id);
}
$("vendor-auth").onchange = vendorAuth;

$("vendor-metadata-access").onclick = () =>
    run(async () => {
        const item = vendorConnections.find((item) => item.id === $("vendor-connection").value);
        if (!item) throw new Error("Choose a connection.");
        await api("vendor-sources/metadata-access", {
            projectId: project(),
            id: item.id,
            expectedRevision: item.revision,
            allow: $("vendor-agent-metadata").checked,
        });
        await vendorList();
    });

$("vendor-detail").onclick = () =>
    run(async () => {
        const result = await api("vendor-sources/detail", { projectId: project(), id: $("vendor-connection").value }),
            profile = result.profile;
        $("vendor-status").textContent = pretty(result.connection);
        $("vendor-connector").value = profile.connector;
        $("vendor-name").value = result.connection.displayName;
        $("vendor-domain").value = result.connection.identityDomain;
        for (const [field, id] of [
            ["host", "vendor-host"],
            ["port", "vendor-port"],
            ["database", "vendor-database-name"],
            ["user", "vendor-user"],
            ["driverSha256", "vendor-driver-sha"],
            ["baseUrl", "vendor-base"],
            ["recordsPointer", "vendor-records-pointer"],
            ["nextPointer", "vendor-next-pointer"],
        ])
            $(id).value = profile[field] ?? "";
        $("vendor-schemas").value = (profile.schemas || []).join("\n");
        $("vendor-read-paths").value = (profile.readPaths || []).join("\n");
        $("vendor-fhir-release").value = profile.fhirVersion || "4.0.1";
        $("vendor-analytics").value = profile.analytics ? pretty(profile.analytics) : "";
        const auth = profile.authentication || {};
        $("vendor-auth").value = auth.mode || "bearer";
        for (const [field, id] of [
            ["user", "vendor-api-user"],
            ["tokenEndpoint", "vendor-token-endpoint"],
            ["clientId", "vendor-client-id"],
            ["keyId", "vendor-key-id"],
            ["algorithm", "vendor-algorithm"],
        ])
            $(id).value = auth[field] || "";
        $("vendor-scopes").value = (auth.scopes || []).join(" ");
        for (const id of [
            "vendor-password",
            "vendor-token",
            "vendor-api-password",
            "vendor-client-secret",
            "vendor-private-key",
        ])
            $(id).value = "";
        $("vendor-plan").value = result.plan ? pretty(result.plan) : "";
        $("vendor-read-path").value = result.readPath || "";
        $("vendor-capture-mode").value = result.cursor ? "append" : "snapshot";
        $("vendor-cursor").value = result.cursor ? pretty(result.cursor) : "";
        $("vendor-plan-comment").value = result.review?.comment || "";
        $("vendor-append-ack").checked = false;
        vendorKind();
    });
