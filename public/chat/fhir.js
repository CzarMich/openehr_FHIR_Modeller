"use strict";
const $ = (id) => document.getElementById(id);
const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
let session,
    project = null,
    projectRevision = null,
    projects = [],
    artifacts = [],
    draftFiles = [],
    artifact = null;
let inspectedSource = null;
let loaded = false,
    busy = false,
    generation = 0,
    sourceGeneration = 0;
const projectForm = $("fhir-project-form");
const pretty = (value) => JSON.stringify(value, null, 2);
function output(id, value) {
    $(id).textContent = typeof value === "string" ? value : pretty(value);
    $(id).hidden = false;
}
function message(text) {
    $(document.body.dataset.section === "mappings" ? "mapping-notice" : "fhir-notice").textContent = text;
}
function updateProjectControls() {
    for (const id of ["fhir-refresh", "fhir-project", "mapping-project"])
        $(id).disabled = busy || !session?.authenticated;
    $("fhir-new-project").disabled = busy || !session?.authenticated || !session?.allowWrites;
}
async function run(action) {
    if (busy) return;
    if (!session?.authenticated) return message("Sign in to use FHIR modelling.");
    busy = true;
    updateProjectControls();
    $("panel-fhir").setAttribute("aria-busy", "true");
    $("panel-mappings").setAttribute("aria-busy", "true");
    message("Working with the FHIR modelling service…");
    try {
        await action();
        message("");
    } catch (error) {
        message(
            error.name === "TimeoutError"
                ? "The operation timed out. Inspect server status before retrying a confirmed change."
                : error.message,
        );
    } finally {
        busy = false;
        updateProjectControls();
        $("panel-fhir").setAttribute("aria-busy", "false");
        $("panel-mappings").setAttribute("aria-busy", "false");
    }
}
function jsonField(value, label, array = false) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(label + " must contain valid JSON.");
    }
    if (!parsed || (array ? !Array.isArray(parsed) : typeof parsed !== "object" || Array.isArray(parsed)))
        throw new Error(label + (array ? " must be a JSON array." : " must be a JSON object."));
    return parsed;
}
async function request(input) {
    if (!session?.authenticated) throw new Error("Sign in to use FHIR modelling.");
    const identityGeneration = generation;
    const response = await fetch("/chat/api/fhir/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(660000),
    });
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("The service returned an incomplete response. Refresh before retrying.");
    }
    if (generation !== identityGeneration || !session?.authenticated)
        throw new Error("The sign-in session changed. Refresh to continue.");
    if (!response.ok) throw new Error(data.error || "FHIR operation failed.");
    return data;
}
function confirmChange(preview) {
    const dialog = $("fhir-confirm-dialog");
    $("fhir-confirm-summary").textContent =
        preview.tool + " · " + (preview.args.action || "compile") + " · " + preview.args.projectId;
    const args = { ...preview.args };
    for (const key of ["document", "arguments"]) if (args[key]) args[key] = JSON.parse(args[key]);
    output("fhir-confirm-request", args);
    dialog.returnValue = "cancel";
    dialog.showModal();
    return new Promise((resolve) =>
        dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }),
    );
}
async function invoke(tool, action, args = {}, projectId = project?.id) {
    const input = {
        tool,
        args:
            tool === "fhir_project"
                ? { action, ...args }
                : {
                      ...(["fhir_fsh_compile", "fhir_example_generate"].includes(tool) ? {} : { action }),
                      projectId,
                      arguments: JSON.stringify(args),
                  },
    };
    let response = await request(input);
    if (response.confirmationRequired) {
        if (!(await confirmChange(response))) throw new Error("Change cancelled. No mutation was executed.");
        response = await request({ ...input, confirmation: response.confirmation });
    }
    return response.result;
}
function discuss(prompt) {
    location.hash = "#chat";
    document.dispatchEvent(new CustomEvent("workspace:discuss", { detail: { prompt } }));
}
function requireProject() {
    if (!project) throw new Error("Select or create a FHIR project first.");
    return project;
}
function fillProject(value = null) {
    projectForm.reset();
    const fields = projectForm.elements;
    for (const key of [
        "id",
        "name",
        "fhirVersion",
        "canonical",
        "packageId",
        "version",
        "publisher",
        "jurisdiction",
        "language",
        "clinicalProjectId",
        "sourceFormat",
    ])
        if (value?.[key] !== undefined)
            fields.namedItem(key).value = typeof value[key] === "string" ? value[key] : pretty(value[key]);
    fields.namedItem("id").readOnly = !!value;
    for (const [name, key] of [
        ["repositoryUrl", "url"],
        ["repositoryProvider", "provider"],
        ["repositoryBranch", "branch"],
        ["repositoryRoot", "rootPath"],
        ["repositoryConnection", "connectionId"],
    ])
        if (value?.repository?.[key] !== undefined) fields.namedItem(name).value = value.repository[key];
    for (const kind of ["ig", "runtime", "terminology"])
        fields.namedItem(kind).value = value?.connections?.[kind] || "";
    for (const key of ["dependencies", "sources", "policy"])
        fields.namedItem(key).value = pretty(value?.[key] || (key === "policy" ? {} : []));
}
function projectContext() {
    $("fhir-project-work").hidden = !project;
    $("fhir-context").textContent = project
        ? `${project.name} · FHIR ${project.fhirVersion} · ${project.canonical} · ${project.packageId}#${project.version} · Git: ${project.repository?.url || "not configured"} (${project.repository?.branch || "no branch"})`
        : "FHIR workspaces have independent releases, dependencies and repositories.";
}
async function loadProjects() {
    const result = await invoke("fhir_project", "list", {});
    projects = result.items || result.projects || [];
    const selected = project?.id || $("fhir-project").value;
    for (const id of ["fhir-project", "mapping-project"]) {
        $(id).replaceChildren(new Option("Select a project", ""));
        for (const item of projects)
            $(id).append(new Option((item.name || item.id) + " · " + item.fhirVersion, item.id));
        $(id).value = projects.some((item) => item.id === selected) ? selected : projects[0]?.id || "";
    }
    loaded = true;
    if ($("fhir-project").value) await loadProject($("fhir-project").value);
    else {
        project = null;
        fillProject();
        projectContext();
    }
}
async function loadProject(id) {
    clearExternalSource();
    if (!id) {
        project = null;
        projectContext();
        return;
    }
    const result = await invoke("fhir_project", "get", { projectId: id });
    project = result.project;
    projectRevision = result.revision;
    artifacts = result.artifacts || [];
    artifact = null;
    draftFiles = [];
    $("fhir-project").value = $("mapping-project").value = id;
    $("fhir-source").value = "";
    $("fhir-artifact-path").value = "";
    sourceChanged();
    fillProject(project);
    projectContext();
    renderArtifacts();
    $("mapping-notice").textContent =
        "Mapping proposals for " + project.name + ". Source and target semantics remain independent.";
}
function renderArtifacts() {
    const current = $("fhir-artifact-select").value;
    $("fhir-artifact-select").replaceChildren(new Option("New draft", ""));
    for (const item of artifacts)
        $("fhir-artifact-select").append(new Option(item.path + " · saved", "saved:" + item.path));
    for (const item of draftFiles)
        $("fhir-artifact-select").append(new Option(item.path + " · generated draft", "draft:" + item.path));
    if ([...$("fhir-artifact-select").options].some((option) => option.value === current))
        $("fhir-artifact-select").value = current;
}
function sourceChanged() {
    sourceGeneration++;
    $("fhir-validation-state").textContent =
        "Not validated for current editor contents. Run validation on these exact bytes.";
    $("fhir-artifact-inspector").replaceChildren();
}
function selectSource(file, representation = "imported") {
    file = {
        ...file,
        path: file.path?.replace(/^fhir\//, ""),
        format: file.format || file.metadata?.format,
        representation: file.representation || file.metadata?.representation,
        provenance: file.provenance || file.metadata?.sourceClaims || file.metadata,
    };
    artifact = file;
    $("fhir-source").value =
        typeof file.content === "string" ? file.content : pretty(file.content || file.resource || {});
    $("fhir-artifact-path").value = file.path || "";
    $("fhir-format").value =
        file.format || (/\.fsh$/i.test(file.path || "") ? "fsh" : /\.xml$/i.test(file.path || "") ? "xml" : "json");
    $("fhir-representation").value = file.representation || representation;
    $("fhir-artifact-revision").textContent =
        (file.revision ? "Revision " + file.revision : "Unsaved draft") +
        (file.sha256 ? " · SHA-256 " + file.sha256 : "");
    output("fhir-artifact-evidence", {
        provenance: file.provenance || {},
        revision: file.revision || null,
        representation: file.representation || representation,
    });
    sourceChanged();
}
function exactSource() {
    const displayed = $("fhir-source").value;
    // A textarea normalizes line endings. Retain retrieved original bytes until
    // the editor actually changes, including imported XML and authored FSH.
    return typeof artifact?.content === "string" && artifact.content.replace(/\r\n?/g, "\n") === displayed
        ? artifact.content
        : displayed;
}
function content() {
    if (!$("fhir-source").value.trim()) throw new Error("Load or enter an artifact source first.");
    return $("fhir-format").value === "json"
        ? jsonField($("fhir-source").value, "FHIR source")
        : $("fhir-source").value;
}
function profileArguments() {
    requireProject();
    if (!$("fhir-requirement").value.trim())
        throw new Error("Enter clinical requirements before discovery or generation.");
    return {
        requirement: $("fhir-requirement").value,
        baseResource: $("fhir-base-resource").value,
        constraints: jsonField($("fhir-constraints").value, "Constraints", true),
    };
}
function renderCandidates(result) {
    $("fhir-candidates").replaceChildren();
    for (const item of result.candidates || []) {
        const card = element("article", undefined, "fhir-result-card");
        card.append(element("strong", item.title || item.name || item.canonical || item.url));
        card.append(
            element(
                "p",
                [
                    item.canonical || item.url,
                    item.packageId || item.package?.id || item.package,
                    item.packageVersion || item.version,
                ]
                    .filter(Boolean)
                    .map((v) => (typeof v === "object" ? pretty(v) : v))
                    .join(" · "),
            ),
        );
        card.append(
            element(
                "p",
                typeof item.reason === "string"
                    ? item.reason
                    : pretty(item.reason || item.reasons || item.relevance || item.compatibility || {}),
            ),
        );
        $("fhir-candidates").append(card);
    }
    output("fhir-reuse-result", result);
}
function inspectResource(resource, evidence) {
    const host = $("fhir-artifact-inspector");
    host.replaceChildren();
    if (!resource || typeof resource !== "object") return;
    const metadata = element("dl", undefined, "fhir-metadata");
    for (const key of [
        "resourceType",
        "id",
        "name",
        "title",
        "url",
        "version",
        "fhirVersion",
        "status",
        "publisher",
        "jurisdiction",
        "baseDefinition",
        "type",
        "kind",
        "derivation",
    ]) {
        if (resource[key] === undefined) continue;
        metadata.append(
            element("dt", key),
            element("dd", typeof resource[key] === "string" ? resource[key] : pretty(resource[key])),
        );
    }
    host.append(metadata);
    for (const section of ["differential", "snapshot"]) {
        const rows = resource[section]?.element;
        if (!rows?.length) continue;
        const details = element("details"),
            wrapper = element("div", undefined, "fhir-table-scroll"),
            table = element("table");
        details.open = section === "differential";
        details.append(element("summary", section + " · " + rows.length + " elements"));
        const header = element("tr");
        for (const label of ["Element", "Cardinality", "Types / target profiles", "Terminology / constraints"])
            header.append(element("th", label));
        const head = element("thead");
        head.append(header);
        table.append(head);
        const body = element("tbody");
        for (const row of rows) {
            const tr = element("tr");
            const constraints = Object.fromEntries(
                Object.entries(row).filter(([key]) =>
                    /^(binding|slicing|constraint|mustSupport|isModifier|fixed|pattern|sliceName)/.test(key),
                ),
            );
            for (const value of [
                row.id || row.path,
                (row.min ?? "—") + ".." + (row.max ?? "—"),
                pretty(row.type || []),
                pretty(constraints),
            ])
                tr.append(element("td", value));
            body.append(tr);
        }
        table.append(body);
        wrapper.append(table);
        details.append(wrapper);
        host.append(details);
    }
    output("fhir-artifact-evidence", evidence);
}
async function listPackageArtifacts() {
    const result = await invoke("fhir_package", "artifacts", { query: $("fhir-package-query").value });
    $("fhir-package-list").replaceChildren();
    for (const item of result.items || []) {
        const card = element("article", undefined, "fhir-result-card");
        card.append(
            element("strong", item.title || item.name || item.id),
            element(
                "p",
                [
                    item.resourceType,
                    item.url || item.canonical,
                    item.version,
                    item.packageId || item.package,
                    item.packageVersion,
                ]
                    .filter(Boolean)
                    .join(" · "),
            ),
        );
        if (item.url || item.canonical) {
            const button = element("button", "Inspect " + (item.name || item.id || "artifact"), "secondary-button");
            button.type = "button";
            button.onclick = () =>
                run(async () => {
                    const found = await invoke("fhir_package", "resolve", {
                        canonical: item.url || item.canonical,
                        ...(item.version ? { version: item.version } : {}),
                    });
                    const resource = found.resource || found.artifact || found.content || found;
                    selectSource({
                        content: typeof resource === "string" ? resource : pretty(resource),
                        format: "json",
                        provenance: found.provenance || item,
                        path:
                            "input/resources/" +
                            (item.resourceType || "Resource") +
                            "-" +
                            (item.id || "imported") +
                            ".json",
                    });
                    inspectResource(typeof resource === "string" ? JSON.parse(resource) : resource, found);
                    $("fhir-artifact-title").scrollIntoView({ block: "start" });
                });
            card.append(button);
        }
        $("fhir-package-list").append(card);
    }
    output("fhir-package-result", { ...result, items: undefined });
}
$("fhir-refresh").onclick = () => run(loadProjects);
$("fhir-project").onchange = () => run(() => loadProject($("fhir-project").value));
$("mapping-project").onchange = () => run(() => loadProject($("mapping-project").value));
$("fhir-new-project").onclick = () => {
    fillProject();
    $("fhir-project-settings").open = true;
    projectForm.elements.namedItem("id").focus();
};
projectForm.onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
        const data = Object.fromEntries(new FormData(projectForm)),
            existing = projects.some((item) => item.id === data.id);
        if (existing && project?.id !== data.id) throw new Error("Select this existing project before editing it.");
        const document = { ...(existing ? project : {}) };
        for (const key of [
            "name",
            "fhirVersion",
            "canonical",
            "packageId",
            "version",
            "publisher",
            "jurisdiction",
            "language",
            "clinicalProjectId",
            "sourceFormat",
        ])
            document[key] = data[key];
        document.repository = {
            ...(document.repository || {}),
            provider: data.repositoryProvider,
            url: data.repositoryUrl,
            branch: data.repositoryBranch,
            rootPath: data.repositoryRoot,
            connectionId: data.repositoryConnection,
        };
        document.connections = { ...(document.connections || {}) };
        for (const kind of ["ig", "runtime", "terminology"]) {
            if (data[kind]) document.connections[kind] = data[kind];
            else delete document.connections[kind];
        }
        document.dependencies = jsonField(data.dependencies, "Dependencies", true);
        document.sources = jsonField(data.sources, "Knowledge sources", true);
        document.policy = jsonField(data.policy, "Policy");
        const result = await invoke("fhir_project", existing ? "update" : "create", {
            projectId: data.id,
            document: JSON.stringify(document),
            ...(existing ? { expectedRevision: projectRevision } : {}),
        });
        project = result.project || { ...document, id: data.id };
        await loadProjects();
        $("fhir-project-settings").open = false;
    });
};
$("fhir-discovery-form").onsubmit = (event) => {
    event.preventDefault();
    run(async () => renderCandidates(await invoke("fhir_profile", "discover", profileArguments())));
};
$("fhir-discuss").onclick = () => {
    if (!project) return;
    discuss(
        "In FHIR project " +
            project.id +
            " (FHIR " +
            project.fhirVersion +
            "), analyse these requirements and retrieve authoritative candidates before generating anything: " +
            $("fhir-requirement").value +
            ". Load project configuration, sources and exact dependencies, inspect candidate constraints and terminology, and return reuse decisions with typed, requirement-traceable constraints. The existing IG server remains distribution authority.",
    );
};
$("fhir-generate").onclick = () =>
    run(async () => {
        const args = profileArguments();
        if (!$("fhir-profile-id").value || !$("fhir-profile-name").value)
            throw new Error("Enter a profile identifier and name before generation.");
        const result = await invoke("fhir_profile", "generate", {
            ...args,
            id: $("fhir-profile-id").value,
            name: $("fhir-profile-name").value,
            title: $("fhir-profile-title").value || $("fhir-profile-name").value,
            description: args.requirement,
        });
        renderCandidates(result.reuse || result);
        draftFiles =
            result.files ||
            (result.fsh ? [{ path: "input/fsh/" + $("fhir-profile-name").value + ".fsh", content: result.fsh }] : []);
        draftFiles = draftFiles.map((file) => ({ ...file, provenance: result.provenance, representation: "authored" }));
        renderArtifacts();
        if (draftFiles.length) {
            selectSource(draftFiles[0], "authored");
            $("fhir-artifact-select").value = "draft:" + draftFiles[0].path;
        }
        output("fhir-artifact-evidence", result);
    });
$("fhir-package-form").onsubmit = (event) => {
    event.preventDefault();
    run(listPackageArtifacts);
};
$("fhir-package-search").onclick = () =>
    run(async () =>
        output("fhir-package-result", await invoke("fhir_package", "search", { query: $("fhir-package-query").value })),
    );
$("fhir-dependencies").onclick = () =>
    run(async () => output("fhir-package-result", await invoke("fhir_package", "dependencies")));
$("fhir-install-form").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
        output(
            "fhir-package-result",
            await invoke("fhir_package", "install", {
                id: $("fhir-install-id").value,
                version: $("fhir-install-version").value,
            }),
        );
    });
};
$("fhir-artifact-refresh").onclick = () =>
    run(async () => {
        const result = await invoke("fhir_artifact", "search");
        artifacts = result.items || result.artifacts || [];
        renderArtifacts();
    });
$("fhir-artifact-select").onchange = () =>
    run(async () => {
        const value = $("fhir-artifact-select").value;
        if (value.startsWith("draft:"))
            selectSource(
                draftFiles.find((file) => file.path === value.slice(6)),
                "generated",
            );
        else if (value.startsWith("saved:")) {
            const result = await invoke("fhir_artifact", "get", { path: value.slice(6) });
            selectSource(result.artifact || result);
        } else {
            artifact = null;
            $("fhir-source").value = "";
            $("fhir-artifact-path").value = "";
            sourceChanged();
        }
    });
$("fhir-source").oninput = sourceChanged;
$("fhir-format").onchange = () => {
    if ($("fhir-format").value === "xml") $("fhir-representation").value = "imported";
    sourceChanged();
};
$("fhir-validation-profile").oninput = sourceChanged;
$("fhir-inspect").onclick = () =>
    run(async () => {
        const result = await invoke("fhir_artifact", "inspect", { content: content() });
        let resource = result.resource || result.artifact;
        if (!resource && $("fhir-format").value === "json") resource = content();
        inspectResource(resource, result);
    });
$("fhir-compile").onclick = () =>
    run(async () => {
        const version = sourceGeneration;
        if ($("fhir-format").value !== "fsh") throw new Error("Choose an FSH source to compile.");
        const path = $("fhir-artifact-path").value;
        if (!path.startsWith("input/fsh/") || !path.endsWith(".fsh"))
            throw new Error("Use an input/fsh/*.fsh source path.");
        const files = [
            ...draftFiles
                .filter((file) => file.path.endsWith(".fsh") && file.path !== path)
                .map(({ path, content }) => ({ path, content })),
            { path, content: $("fhir-source").value },
        ];
        const result = await invoke("fhir_fsh_compile", "compile", { files });
        output("fhir-artifact-evidence", result);
        if (result.success === true) {
            for (const file of result.files || [])
                draftFiles = [
                    ...draftFiles.filter((row) => row.path !== file.path),
                    { ...file, representation: "generated", provenance: result.evidence },
                ];
            renderArtifacts();
            $("fhir-validation-state").textContent =
                version === sourceGeneration
                    ? "SUSHI compilation succeeded. Generated resources require FHIR validation; select an output above."
                    : "SUSHI compiled the earlier source. The editor changed during compilation; compile again for current bytes.";
        } else
            $("fhir-validation-state").textContent =
                "SUSHI compilation failed. Inspect the diagnostics; generated artifacts are not validated.";
    });
$("fhir-validate").onclick = () =>
    run(async () => {
        const version = sourceGeneration;
        const profile = $("fhir-validation-profile").value;
        const result = await invoke("fhir_artifact", "validate", {
            content: content(),
            ...(profile ? { profile } : {}),
            profiles: draftFiles.flatMap((file) => {
                try {
                    const resource = JSON.parse(file.content);
                    return resource.resourceType === "StructureDefinition" ? [resource] : [];
                } catch {
                    return [];
                }
            }),
        });
        output("fhir-artifact-evidence", result);
        if (version !== sourceGeneration)
            throw new Error("Source changed during validation. The result applies to earlier bytes; validate again.");
        $("fhir-validation-state").textContent =
            "Validation result: " +
            (result.status ||
                result.validation?.status ||
                (result.valid === true ? "passed" : result.valid === false ? "failed" : "inspect recorded evidence")) +
            ". Review the executed validator, diagnostics and limitations in the evidence. Clinical approval remains separate.";
    });
$("fhir-example-generate").onclick = () =>
    run(async () => {
        const profile = content();
        if (typeof profile !== "object" || profile.resourceType !== "StructureDefinition")
            throw new Error("Select a StructureDefinition in FHIR JSON before generating its synthetic example.");
        const file = {
            path: $("fhir-artifact-path").value || "input/resources/profile.json",
            content: $("fhir-source").value,
            representation: $("fhir-representation").value,
            provenance: artifact?.provenance,
        };
        draftFiles = [...draftFiles.filter((item) => item.path !== file.path), file];
        const result = await invoke("fhir_example_generate", "generate", {
            content: profile,
            id: $("fhir-example-id").value || "synthetic-example",
            values: jsonField($("fhir-example-values").value, "Synthetic example values"),
        });
        for (const example of result.files || [])
            draftFiles = [
                ...draftFiles.filter((item) => item.path !== example.path),
                { ...example, representation: "example", provenance: result.provenance },
            ];
        renderArtifacts();
        if (result.files?.length) {
            selectSource({ ...result.files[0], representation: "example", provenance: result.provenance }, "example");
            $("fhir-artifact-select").value = "draft:" + result.files[0].path;
        }
        $("fhir-validation-profile").value = profile.url || "";
        output("fhir-artifact-evidence", result);
        $("fhir-validation-state").textContent =
            "Synthetic example draft generated. Review reported gaps, supply missing values and validate against the target profile.";
    });
$("fhir-save").onclick = () =>
    run(async () => {
        const path = $("fhir-artifact-path").value;
        if (!path) throw new Error("Enter the repository source path before saving.");
        const savedContent = exactSource(),
            savedFormat = $("fhir-format").value;
        const result = await invoke("fhir_artifact", "save", {
            path,
            content: savedContent,
            format: savedFormat,
            representation: $("fhir-representation").value,
            expectedRevision: artifact?.path === path ? artifact.revision || null : null,
            provenance: artifact?.provenance || { origin: "browser-authored", clinicalApproval: false },
        });
        artifact = {
            ...(result.artifact || result),
            path,
            content: savedContent,
            format: savedFormat,
        };
        output("fhir-artifact-evidence", result);
        $("fhir-artifact-revision").textContent =
            "Draft saved · revision " + (artifact.revision || "see save evidence");
    });
$("fhir-git").onclick = () => {
    if (!project) return;
    discuss(
        "Prepare a Git commit for saved FHIR artifact " +
            $("fhir-artifact-path").value +
            " in FHIR project " +
            project.id +
            ". Retrieve exact saved bytes and provenance via fhir_artifact; verify validation and pinned dependencies, confirm the selected private Git connection matches " +
            (project.repository?.url || "the configured FHIR repository") +
            " on branch " +
            (project.repository?.branch || "configured branch") +
            ". Use personal_repository_get for current revision then personal_repository_save standard=FHIR with existing source layout. Preserve FSH as engineering source and show the exact change for confirmation. Do not publish or deploy.",
    );
};
$("fhir-download").onclick = () => {
    if (!$("fhir-source").value) return;
    const link = element("a"),
        url = URL.createObjectURL(new Blob([exactSource()], { type: "text/plain" }));
    link.href = url;
    link.download = $("fhir-artifact-path").value.split("/").at(-1) || "fhir-source.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
};
$("fhir-diff").onclick = () =>
    run(async () =>
        output(
            "fhir-diff-result",
            await invoke("fhir_artifact", "diff", {
                before: jsonField($("fhir-diff-before").value, "Earlier artifact"),
                after: content(),
            }),
        ),
    );
$("fhirpath-evaluate").onclick = () =>
    run(async () =>
        output(
            "fhirpath-result",
            await invoke("fhir_fhirpath", "evaluate", {
                expression: $("fhirpath-expression").value,
                content: content(),
            }),
        ),
    );
$("fhir-connection-refresh").onclick = () =>
    run(async () => {
        const result = await invoke("fhir_connection", "list");
        $("fhir-connection-list").replaceChildren();
        for (const item of result.items || result.connections || []) {
            const card = element("article", undefined, "fhir-result-card");
            card.append(
                element("strong", item.name || item.id),
                element("p", [item.kind || item.type, item.baseUrl || item.url].filter(Boolean).join(" · ")),
            );
            const button = element("button", "Test " + (item.name || item.id), "secondary-button");
            button.type = "button";
            button.onclick = () =>
                run(async () =>
                    output("fhir-connection-result", await invoke("fhir_connection", "test", { id: item.id })),
                );
            card.append(button);
            $("fhir-connection-list").append(card);
        }
        output("fhir-connection-result", result);
    });
for (const action of ["test", "projects", "status", "submit", "sync"])
    $("fhir-ig-" + action).onclick = () =>
        run(async () =>
            output(
                "fhir-connection-result",
                await invoke("fhir_ig", action, jsonField($("fhir-ig-arguments").value, "IG operation arguments")),
            ),
        );
$("mapping-analyse").onclick = () =>
    run(async () => {
        requireProject();
        output(
            "mapping-analysis",
            await invoke("fhir_mapping", "analyse", {
                source: jsonField($("mapping-source").value, "Source semantics"),
                requirement: $("mapping-requirement").value,
                baseResource: $("mapping-base-resource").value,
            }),
        );
    });
$("mapping-save").onclick = () =>
    run(async () =>
        output(
            "mapping-result",
            await invoke("fhir_mapping", "save", jsonField($("mapping-document").value, "Mapping document")),
        ),
    );
$("mapping-list").onclick = () => run(async () => output("mapping-result", await invoke("fhir_mapping", "list")));
$("mapping-discuss").onclick = () =>
    discuss(
        "For FHIR project " +
            ($("mapping-project").value || "selected project") +
            ", inspect the exact openEHR model and analyse FHIR candidates for: " +
            $("mapping-requirement").value +
            ". Retrieve source semantics, paths, cardinalities, terminology, units, context and repeating structures. Search configured FHIR packages. Produce versioned mapping proposals, transformation requirements and semantic gaps. Do not claim lossless conversion or equivalence from similar names.",
    );
$("mapping-git").onclick = () =>
    discuss(
        "Retrieve the saved mapping proposal for FHIR project " +
            ($("mapping-project").value || "selected project") +
            " and prepare its exact Git change using standard=mappings. Check the independently selected mapping repository, live expected revision and provenance. Preserve provisional status and unresolved semantic gaps; require confirmation of the exact commit.",
    );
function updateSession(value) {
    const changed =
        session?.user?.id !== value.user?.id ||
        session?.user?.name !== value.user?.name ||
        session?.authenticated !== value.authenticated;
    session = value;
    if (changed) {
        generation++;
        loaded = false;
        project = null;
        projects = [];
        artifacts = [];
        draftFiles = [];
        artifact = null;
        clearExternalSource();
        if ($("fhir-confirm-dialog").open) $("fhir-confirm-dialog").close("cancel");
        $("fhir-source").value = $("mapping-source").value = $("mapping-document").value = "";
        for (const node of document.querySelectorAll(".fhir-output,.fhir-results,#fhir-artifact-inspector"))
            node.replaceChildren();
        for (const id of ["fhir-project", "mapping-project"]) $(id).replaceChildren(new Option("Select a project", ""));
        fillProject();
        projectContext();
    }
    for (const id of [
        "fhir-refresh",
        "fhir-project",
        "mapping-project",
        "mapping-analyse",
        "mapping-list",
        "mapping-discuss",
        "mapping-git",
    ])
        $(id).disabled = !session.authenticated;
    for (const id of ["fhir-new-project", "fhir-project-fields", "mapping-save"])
        $(id).disabled = !session.authenticated || !session.allowWrites;
    updateProjectControls();
    if (session.authenticated && ["fhir", "mappings"].includes(document.body.dataset.section) && !loaded)
        run(loadProjects);
    else if (!session.authenticated) message("Sign in to use FHIR modelling.");
}
for (const section of ["fhir", "mappings"])
    document.addEventListener("workspace:" + section, () => {
        if (session?.authenticated && !loaded) run(loadProjects);
    });
document.addEventListener("workspace:session", (event) => updateSession(event.detail));
fetch("/chat/api/session")
    .then((response) => response.json())
    .then(updateSession)
    .catch(() => message("Could not load sign-in status. Refresh to retry."));

function clearExternalSource() {
    inspectedSource = null;
    $("fhir-external-import").disabled = true;
    $("fhir-external-releases").replaceChildren();
    $("fhir-definition-results").replaceChildren();
    $("fhir-external-result").textContent = "";
}
function showExternalSource(result, parameters) {
    inspectedSource = result.sha256 && result.kind !== "releases" ? { result, parameters } : null;
    $("fhir-external-import").disabled = !inspectedSource || !session?.allowWrites;
    output("fhir-external-result", { ...result, content: undefined, resource: undefined });
    $("fhir-external-releases").replaceChildren();
    for (const release of result.releases || []) {
        const button = element(
            "button",
            release.version + " · FHIR " + (release.fhirVersion || "unspecified"),
            "secondary-button",
        );
        button.type = "button";
        button.onclick = () =>
            run(async () => {
                $("fhir-external-version").value = release.version;
                const selected = { url: parameters.url, version: release.version };
                showExternalSource(await invoke("fhir_source", "inspect", selected), selected);
            });
        $("fhir-external-releases").append(button);
    }
    if (result.kind === "resource") {
        $("fhir-external-path").value =
            "imported/" +
            result.resource.resourceType +
            "-" +
            (result.resource.id || result.sha256.slice(0, 12)) +
            ".json";
        inspectResource(result.resource, result.provenance);
    }
}
$("fhir-capabilities").onclick = () =>
    run(async () => output("fhir-capabilities-result", await invoke("fhir_project", "capabilities")));
$("fhir-external-inspect").onclick = () =>
    run(async () => {
        requireProject();
        clearExternalSource();
        const parameters = { url: $("fhir-external-url").value.trim() };
        if ($("fhir-external-version").value.trim()) parameters.version = $("fhir-external-version").value.trim();
        showExternalSource(await invoke("fhir_source", "inspect", parameters), parameters);
    });
$("fhir-definition-search").onclick = () =>
    run(async () => {
        requireProject();
        clearExternalSource();
        const connectionId = $("fhir-definition-connection").value.trim();
        const resourceType = $("fhir-definition-type").value;
        const query = $("fhir-definition-query").value.trim();
        const args = {
            id: connectionId,
            resourceType,
            ...(query ? { [query.startsWith("http") || query.startsWith("urn:") ? "url" : "name"]: query } : {}),
        };
        const result = await invoke("fhir_connection", "search", args);
        output("fhir-external-result", result);
        for (const item of result.items || []) {
            const button = element(
                "button",
                "Inspect " + (item.title || item.name || item.id) + " · " + (item.version || "unversioned"),
                "secondary-button",
            );
            button.type = "button";
            button.onclick = () =>
                run(async () => {
                    const parameters = { connectionId, resourceType, resourceId: item.id };
                    showExternalSource(await invoke("fhir_source", "inspect", parameters), parameters);
                });
            $("fhir-definition-results").append(button);
        }
    });
$("fhir-external-import").onclick = () =>
    run(async () => {
        requireProject();
        if (!inspectedSource) throw new Error("Inspect a source first.");
        const { result, parameters } = inspectedSource;
        const args = { ...parameters, expectedSha256: result.sha256, projectRevision };
        if (result.kind === "resource") args.path = $("fhir-external-path").value.trim();
        const imported = await invoke("fhir_source", "import", args);
        await loadProject(project.id);
        output("fhir-external-result", { ...imported, content: undefined, resource: undefined });
    });
