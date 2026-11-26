const $ = (id) => document.getElementById(id);
let session,
    selected,
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
    item.textContent = label;
    item.onclick = () => run(action);
    return item;
}
async function run(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
        await action();
    } catch (error) {
        notice(error.message);
    } finally {
        busy = false;
        document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
}
function showReview(view) {
    selected = view;
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
        clinicalApproval: view.clinicalApproval,
    });
    $("review").append(rules);
}
async function load() {
    const id = project();
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
    notice("Review the exact source, mapping and destination, then confirm.");
}
async function jobs() {
    const [jobs, channels] = await Promise.all([api("jobs"), api("channels")]);
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
                "X-Source-Name": file.name,
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
        $("inspection").textContent = pretty(
            await api("sources/inspect", { projectId: project(), sourceId: $("source").value, file: $("file").value }),
        );
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
        await api(value.kind + "/commit", { confirmation: value.token });
        await jobs();
        notice("Operation confirmed. Review status below.");
    });
$("dismiss").onclick = () => {
    pending = null;
    $("confirmation").hidden = true;
};
$("jobs-refresh").onclick = () => run(jobs);
run(async () => {
    const response = await fetch("/chat/api/session");
    session = await response.json();
    if (!session.authenticated) throw new Error("Sign in through the modelling workspace, then return here.");
    if (!session.integrationReady) throw new Error("The C# integration service is not enabled or ready.");
    await refresh();
});
