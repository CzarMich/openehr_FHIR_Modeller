"use strict";
const $ = (id) => document.getElementById(id);
let session,
    connections = [],
    editing = null,
    loaded = false,
    loading = false,
    busy = false,
    job = null,
    result = null,
    queryVersion = 0,
    generation = 0;
let sources = [],
    modelFiles = [],
    model = null,
    selectedPaths = new Set();
const textFields = [
    "name",
    "vendor",
    "baseUrl",
    "apiUrl",
    "queryUrl",
    "username",
    "apiKeyHeader",
    "tokenUrl",
    "clientId",
    "scope",
    "tenant",
    "tenantHeader",
];
const secretFields = ["password", "token", "apiKey", "clientSecret"];
const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const button = (text, action) => {
    const node = el("button", text);
    node.type = "button";
    node.onclick = () => safely(action);
    return node;
};
function notice(message) {
    $("aql-notice").textContent = message;
}
async function safely(action, settings = false) {
    try {
        await action();
    } catch (error) {
        (settings ? $("cdr-settings-status") : $("aql-notice")).textContent = error.message;
    }
}
async function api(operation, input = {}, signal) {
    if (!session?.authenticated) throw new Error("Sign in to use the AQL workspace.");
    const identityGeneration = generation;
    const response = await fetch("/chat/api/cdr/" + operation, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
        body: JSON.stringify(input),
        signal: signal || AbortSignal.timeout(175000),
    });
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("The server returned an incomplete response. Please retry.");
    }
    if (generation !== identityGeneration || !session?.authenticated)
        throw new Error("The sign-in session changed. Please retry.");
    if (!response.ok)
        throw new Error((data.error || "The request failed.") + (data.code ? " (" + data.code + ")" : ""));
    return data;
}
async function workspaceFetch(path, input) {
    const identityGeneration = generation;
    const response = await fetch(
        "/chat/api/" + path,
        input === undefined
            ? { signal: AbortSignal.timeout(125000) }
            : {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf },
                  body: JSON.stringify(input),
                  signal: AbortSignal.timeout(125000),
              },
    );
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    let data;
    try {
        data = await response.json();
    } catch {
        throw new Error("The model source returned an incomplete response. Reload the source and retry.");
    }
    if (identityGeneration !== generation || !session?.authenticated)
        throw new Error("The sign-in session changed. Please retry.");
    if (!response.ok) throw new Error(data.error || "The model source is unavailable.");
    return data;
}
function settings() {
    if (!$("chat-settings-dialog").open) $("chat-settings-dialog").showModal();
    $("cdr-settings").open = true;
    $("cdr-settings").scrollIntoView({ block: "start" });
    safely(refreshConnections, true);
}
$("aql-settings").onclick = settings;
$("cdr-settings").addEventListener("toggle", () => {
    if ($("cdr-settings").open && session?.authenticated) safely(refreshConnections, true);
});
function showAuth() {
    for (const node of document.querySelectorAll("[data-cdr-auth]"))
        node.hidden = node.dataset.cdrAuth !== $("cdr-auth").value;
}
$("cdr-auth").onchange = showAuth;
function editConnection(connection = null) {
    editing = connection?.id || null;
    $("cdr-form").reset();
    $("cdr-form").hidden = false;
    $("cdr-form-title").textContent = connection ? "Edit " + connection.name : "New connection";
    for (const field of textFields)
        $("cdr-" + field).value = connection?.[field] || (field === "vendor" ? "openEHR REST" : "");
    $("cdr-auth").value = connection?.auth || "none";
    $("cdr-enabled").checked = connection?.enabled ?? true;
    $("cdr-timeout").value = connection?.timeout || 60;
    $("cdr-settings-status").textContent = connection?.hasCredentials
        ? "Credentials are saved. Leave secret fields blank to keep them."
        : "";
    if (connection?.headerNames?.length)
        $("cdr-settings-status").textContent += " Saved headers: " + connection.headerNames.join(", ") + ".";
    showAuth();
    $("cdr-name").focus();
}
$("cdr-new").onclick = () => editConnection();
$("cdr-form-cancel").onclick = () => {
    $("cdr-form").reset();
    $("cdr-form").hidden = true;
    editing = null;
};
$("cdr-form").onsubmit = (event) => {
    event.preventDefault();
    safely(async () => {
        $("cdr-save").disabled = true;
        try {
            const connection = Object.fromEntries(textFields.map((field) => [field, $("cdr-" + field).value.trim()]));
            Object.assign(connection, {
                auth: $("cdr-auth").value,
                timeout: Number($("cdr-timeout").value),
                enabled: $("cdr-enabled").checked,
                secrets: Object.fromEntries(secretFields.map((field) => [field, $("cdr-" + field).value])),
            });
            if (editing) connection.id = editing;
            if ($("cdr-headers").value.trim()) {
                connection.headers = JSON.parse($("cdr-headers").value);
                if (!connection.headers || Array.isArray(connection.headers) || typeof connection.headers !== "object")
                    throw new Error("Additional headers must be a JSON object.");
            }
            if ($("cdr-caCertificate").value.trim()) connection.caCertificate = $("cdr-caCertificate").value.trim();
            const saved = await api("connection-save", { connection });
            $("cdr-form").reset();
            $("cdr-form").hidden = true;
            editing = null;
            await refreshConnections(saved.id);
            $("cdr-settings-status").textContent = "Connection saved. Press Test to check access.";
        } finally {
            $("cdr-save").disabled = false;
        }
    }, true);
};
async function refreshConnections(select) {
    if (!session?.cdrEnabled) {
        $("cdr-settings-status").textContent = "CDR connections are not enabled on this installation.";
        return;
    }
    connections = (await api("connections")).items;
    const current = select || $("aql-connection").value;
    $("aql-connection").replaceChildren(new Option("Choose a connection", ""));
    $("cdr-connection-list").replaceChildren();
    for (const item of connections) {
        if (item.enabled) $("aql-connection").append(new Option(item.name, item.id));
        const row = el("div", undefined, "cdr-row"),
            label = el("span", item.name + (item.enabled ? "" : " · Disabled"));
        row.append(label);
        const test = button("Test", async () => {
            test.disabled = true;
            $("cdr-settings-status").textContent = "Testing " + item.name + "…";
            try {
                const checked = await api("connection-test", { id: item.id });
                $("cdr-settings-status").textContent =
                    (checked.ok ? "Connection ready. " : "Connection needs attention. ") +
                    Object.entries(checked.checks)
                        .map(
                            ([key, value]) =>
                                key.replaceAll("_", " ") + ": " + value.toLowerCase().replaceAll("_", " "),
                        )
                        .join(" · ") +
                    (checked.error ? " (" + checked.error.code + ")" : "");
            } catch (error) {
                $("cdr-settings-status").textContent = error.message;
            } finally {
                test.disabled = false;
            }
        });
        test.disabled = !item.enabled;
        row.append(test);
        if (!item.readOnly)
            row.append(
                button("Edit", () => editConnection(item)),
                button("Delete", async () => {
                    if (!confirm("Delete the connection “" + item.name + "”? Saved queries will remain.")) return;
                    await api("connection-delete", { id: item.id });
                    await refreshConnections();
                }),
            );
        $("cdr-connection-list").append(row);
    }
    if (connections.some((item) => item.id === current && item.enabled)) $("aql-connection").value = current;
    else if (connections.filter((item) => item.enabled).length === 1)
        $("aql-connection").value = connections.find((item) => item.enabled).id;
    if (!connections.length) $("cdr-connection-list").append(el("p", "No CDR connections yet."));
    controls();
}
function controls() {
    const ready = !!session?.authenticated && !!session?.cdrEnabled;
    for (const id of [
        "aql-format",
        "aql-validate",
        "aql-explain",
        "aql-inspect",
        "aql-source-refresh",
        "aql-save",
        "aql-refresh",
        "aql-generate",
        "aql-files",
        "aql-model",
        "aql-dependencies",
        "aql-source",
        "aql-project",
        "aql-connection",
        "aql-use-template",
    ])
        $(id).disabled = !ready || busy || (id === "aql-use-template" && !model?.template);
    $("aql-run").disabled = !ready || busy || !$("aql-connection").value;
    $("aql-editor").readOnly = busy;
    $("aql-parameters").readOnly = busy;
    $("aql-cancel").hidden = !job;
    $("aql-progress").hidden = !busy;
    $("aql-ask-assistant").disabled = !ready || busy || !model?.template;
    $("aql-generate").disabled = !ready || busy || !model || !selectedPaths.size;
    $("aql-clear-paths").disabled = busy || !selectedPaths.size;
    $("aql-download-opt").hidden = !model?.template;
    $("aql-download-web-template").hidden = !model?.webTemplate;
    $("aql-download-opt").disabled = busy;
    $("aql-download-web-template").disabled = busy;
    $("cdr-new").disabled = !ready;
}
async function work(label, action) {
    if (busy) return;
    busy = true;
    controls();
    notice("");
    $("aql-progress-text").textContent = label;
    try {
        await action();
    } finally {
        busy = false;
        job = null;
        controls();
    }
}
function highlight() {
    const tokens =
        $("aql-editor").value.match(
            /'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\/\*[\s\S]*?\*\/|--[^\n]*|\$[A-Za-z_][\w]*|\b(?:SELECT|DISTINCT|FROM|CONTAINS|WHERE|AND|OR|NOT|EXISTS|MATCHES|LIKE|ORDER|BY|ASC|DESC|LIMIT|OFFSET|AS|COUNT|MIN|MAX|SUM|AVG|EHR|COMPOSITION|OBSERVATION|EVALUATION|INSTRUCTION|ACTION|CLUSTER|ELEMENT)\b|[^\s]+|\s+/gi,
        ) || [];
    $("aql-highlight").replaceChildren(
        ...tokens.map((token) =>
            el(
                "span",
                token,
                /^["']/.test(token)
                    ? "literal"
                    : /^\$/.test(token)
                      ? "parameter"
                      : /^(--|\/\*)/.test(token)
                        ? "comment"
                        : /^(SELECT|DISTINCT|FROM|CONTAINS|WHERE|AND|OR|NOT|EXISTS|MATCHES|LIKE|ORDER|BY|ASC|DESC|LIMIT|OFFSET|AS|COUNT|MIN|MAX|SUM|AVG|EHR|COMPOSITION|OBSERVATION|EVALUATION|INSTRUCTION|ACTION|CLUSTER|ELEMENT)$/i.test(
                                token,
                            )
                          ? "keyword"
                          : "",
            ),
        ),
        document.createTextNode("\n"),
    );
    $("aql-highlight").scrollTop = $("aql-editor").scrollTop;
    $("aql-highlight").scrollLeft = $("aql-editor").scrollLeft;
}
function changed() {
    queryVersion++;
    highlight();
    if ($("aql-findings").childNodes.length)
        $("aql-findings").replaceChildren(el("p", "Query changed. Validate again to refresh the findings."));
    if (result)
        $("aql-result-summary").textContent =
            "Previous query results · the query or environment has changed. Run again to refresh.";
}
$("aql-editor").oninput = () => {
    changed();
    suggestPaths();
};
let completions = [],
    completionIndex = 0,
    completionRange = null;
function hideSuggestions() {
    completions = [];
    completionRange = null;
    $("aql-suggestions").hidden = true;
    $("aql-suggestion-list").replaceChildren();
    $("aql-editor").removeAttribute("aria-activedescendant");
}
function chooseSuggestion(index) {
    if (!completionRange || !completions[index] || busy) return;
    const editor = $("aql-editor");
    editor.setRangeText(completions[index], completionRange.start, completionRange.end, "end");
    hideSuggestions();
    changed();
    editor.focus();
}
function selectSuggestion(index) {
    completionIndex = (index + completions.length) % completions.length;
    for (const [i, option] of [...$("aql-suggestion-list").children].entries())
        option.setAttribute("aria-selected", String(i === completionIndex));
    $("aql-editor").setAttribute("aria-activedescendant", "aql-suggestion-" + completionIndex);
    $("aql-suggestion-" + completionIndex)?.scrollIntoView({ block: "nearest" });
}
function suggestPaths(force = false) {
    hideSuggestions();
    if (!model || busy) return;
    const editor = $("aql-editor"),
        caret = editor.selectionStart;
    if (caret !== editor.selectionEnd) return;
    const before = editor.value.slice(0, caret);
    // Only complete a root-model alias. Nested CONTAINS aliases need relative
    // paths and must not be given incorrect composition-relative suggestions.
    const root = model.inspection.inspection.paths.find((path) => path.path === "/")?.rm_type;
    const alias =
        editor.value.match(
            new RegExp("\\b(?:FROM|CONTAINS)\\s+" + root + "\\s+([A-Za-z_][A-Za-z0-9_]*)\\b", "i"),
        )?.[1] || (/\b(?:FROM|CONTAINS)\b/i.test(editor.value) ? null : "m");
    const token = before.match(/([A-Za-z_][A-Za-z0-9_]*)(\/[^\s,;()]*)?$/);
    if (!token || token[1] !== alias || (!token[2] && !force)) return;
    // Do not offer model paths inside quoted literals or line comments.
    const withoutLiterals = before.replace(/'(?:''|\\.|[^'])*'|"(?:""|\\.|[^"])*"|--[^\n]*/g, " ");
    if (/["']/.test(withoutLiterals) || /--[^\n]*$/.test(before)) return;
    const prefix = token[2] || "/";
    completions = [...new Set(model.inspection.inspection.paths.map((path) => path.path))]
        .filter((path) => path !== "/" && path.toLowerCase().startsWith(prefix.toLowerCase()))
        .slice(0, 12)
        .map((path) => alias + path);
    if (!completions.length) return;
    completionRange = { start: caret - token[0].length, end: caret };
    completions.forEach((path, index) => {
        const label = model.inspection.inspection.paths.find((item) => alias + item.path === path)?.label;
        const option = el("div", (label ? label + " · " : "") + path);
        option.id = "aql-suggestion-" + index;
        option.setAttribute("role", "option");
        option.onmousedown = (event) => {
            event.preventDefault();
            chooseSuggestion(index);
        };
        $("aql-suggestion-list").append(option);
    });
    $("aql-suggestions").hidden = false;
    selectSuggestion(0);
}
$("aql-editor").addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.code === "Space") {
        event.preventDefault();
        suggestPaths(true);
        return;
    }
    if (!completions.length) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        selectSuggestion(completionIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseSuggestion(completionIndex);
    } else if (event.key === "Escape") {
        event.preventDefault();
        hideSuggestions();
    } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) hideSuggestions();
});
$("aql-editor").addEventListener("blur", hideSuggestions);
$("aql-editor").addEventListener("click", () => suggestPaths());
$("aql-editor").onscroll = highlight;
$("aql-parameters").oninput = changed;
$("aql-connection").onchange = () => {
    changed();
    $("aql-unassigned").checked = false;
    safely(refreshLibrary);
    if ($("aql-source").value === "remote") resetModel();
    controls();
};
function templates() {
    return model?.template && $("aql-use-template").checked
        ? [{ identifier: "selected_template", content: model.content }]
        : [];
}
function renderReport(report) {
    const container = $("aql-findings");
    container.replaceChildren();
    container.append(
        el(
            "p",
            (report.status || "Unknown") +
                " · " +
                (report.profile === "AQL_TEMPLATE_PATHS" ? "Syntax and selected-template paths" : "Syntax only"),
            report.valid ? "aql-pass" : "aql-fail",
        ),
    );
    for (const finding of report.findings || []) container.append(el("p", finding.code + ": " + finding.message));
    for (const template of report.templates || []) {
        container.append(
            el("p", "Template: " + template.template_id + " · " + template.status + " · SHA-256 " + template.sha256),
        );
        const table = el("table"),
            head = el("tr");
        for (const value of ["Query path", "Check", "Finding"]) head.append(el("th", value));
        table.append(head);
        for (const path of template.paths || []) {
            const row = el("tr");
            row.append(el("td", path.query_path), el("td", path.status), el("td", path.message));
            table.append(row);
        }
        container.append(table);
    }
    container.append(
        el("p", "This does not execute the query or verify predicate values, function types or clinical meaning."),
    );
    for (const limitation of report.limitations || []) container.append(el("p", limitation));
}
function formatAql(query) {
    // The native parser normalises syntax; insert line breaks only outside quoted literals and predicates.
    const parts =
        query.match(
            /'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\[|\]|\b(?:FROM|WHERE|ORDER BY|LIMIT|OFFSET|CONTAINS)\b|[^'"\[\]]+?/g,
        ) || [];
    let depth = 0;
    return parts
        .map((part) => {
            if (part === "[") depth++;
            if (part === "]") depth--;
            return depth === 0 && /^(FROM|WHERE|ORDER BY|LIMIT|OFFSET|CONTAINS)$/.test(part) ? "\n" + part : part;
        })
        .join("")
        .replace(/ +\n/g, "\n")
        .trim();
}
for (const operation of ["format", "validate", "explain"])
    $("aql-" + operation).onclick = () =>
        safely(() =>
            work(operation === "format" ? "Formatting…" : "Checking query…", async () => {
                const report = await api(operation === "explain" ? "explain" : "validate", {
                    query: $("aql-editor").value,
                    templates: templates(),
                });
                const validation = report.validation || report;
                if (operation === "format" && validation.normalized_query) {
                    $("aql-editor").value = formatAql(validation.normalized_query);
                    highlight();
                }
                renderReport(validation);
                if (report.explanation)
                    $("aql-findings").append(
                        el("p", report.explanation),
                        el("pre", JSON.stringify(report.references, null, 2)),
                    );
            }),
        );
async function execute() {
    await work("Running query…", async () => {
        const parameters = JSON.parse($("aql-parameters").value);
        if (!parameters || Array.isArray(parameters) || typeof parameters !== "object")
            throw new Error("Parameters must be a JSON object.");
        const fetchCount = Number($("aql-fetch").value),
            offset = Number($("aql-offset").value);
        if (
            !Number.isInteger(fetchCount) ||
            fetchCount < 1 ||
            fetchCount > 1000 ||
            !Number.isInteger(offset) ||
            offset < 0 ||
            offset > 1000000
        )
            throw new Error("Choose a page size from 1 to 1,000 and a valid offset.");
        const version = queryVersion,
            id = $("aql-connection").value,
            query = $("aql-editor").value;
        job = crypto.randomUUID().replaceAll("-", "");
        controls();
        const started = Date.now(),
            timer = setInterval(() => {
                $("aql-progress-text").textContent =
                    "Running query · " + Math.round((Date.now() - started) / 1000) + "s";
            }, 1000);
        try {
            const next = await api("execute", { id, query, parameters, fetch: fetchCount, offset, job });
            if (queryVersion !== version)
                throw new Error("The query changed while it was running. Run again to see current results.");
            result = next;
            $("aql-results").hidden = false;
            $("aql-next").hidden = !next.has_more;
            $("aql-result-summary").textContent =
                next.count +
                " rows · " +
                (next.duration_ms / 1000).toFixed(2) +
                "s · " +
                (connections.find((item) => item.id === id)?.name || "Selected CDR") +
                " · offset " +
                next.offset;
            renderResult();
            notice(next.count === 0 ? "Query completed with no matching rows." : "Query completed.");
        } finally {
            clearInterval(timer);
            await refreshLibrary();
        }
    });
}
$("aql-run").onclick = () => safely(execute);
$("aql-cancel").onclick = () =>
    safely(async () => {
        if (!job) return;
        $("aql-cancel").disabled = true;
        try {
            await api("cancel", { job });
            notice("Cancellation requested. The CDR may continue processing remotely.");
        } finally {
            $("aql-cancel").disabled = false;
        }
    });
$("aql-next").onclick = () =>
    safely(async () => {
        if (!result || busy) return;
        $("aql-offset").value = result.offset + result.fetch;
        await execute();
    });
function renderResult() {
    const body = $("aql-result-body");
    body.replaceChildren();
    if (!result) return;
    const view = $("aql-result-view").value;
    if (view !== "table") {
        body.append(el("pre", view === "raw" ? result.raw : JSON.stringify(result.json, null, 2)));
        return;
    }
    if (!result.rows.length) {
        body.append(el("p", "No matching rows."));
        return;
    }
    const table = el("table"),
        head = el("thead"),
        header = el("tr"),
        rows = el("tbody");
    for (const column of result.columns) header.append(el("th", column.name));
    head.append(header);
    table.append(head, rows);
    for (const cells of result.rows) {
        const row = el("tr");
        for (const cell of cells)
            row.append(
                el("td", cell === null ? "null" : typeof cell === "object" ? JSON.stringify(cell) : String(cell)),
            );
        rows.append(row);
    }
    body.append(table);
}
$("aql-result-view").onchange = renderResult;
$("aql-copy").onclick = () =>
    safely(async () => {
        if (result) {
            await navigator.clipboard.writeText(
                $("aql-result-view").value === "raw" ? result.raw : JSON.stringify(result.json, null, 2),
            );
            notice("Result copied.");
        }
    });
function download(content, name, type) {
    const link = el("a"),
        url = URL.createObjectURL(new Blob([content], { type }));
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("aql-export").onclick = () => {
    if (result) download(JSON.stringify(result.json, null, 2), "aql-results.json", "application/json");
};
$("aql-export-csv").onclick = () => {
    if (!result) return;
    const cell = (value) => {
        let text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
        if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
    };
    download(
        [result.columns.map((c) => c.name), ...result.rows].map((row) => row.map(cell).join(",")).join("\r\n"),
        "aql-results.csv",
        "text/csv",
    );
};
$("aql-clear-results").onclick = () => {
    result = null;
    $("aql-result-body").replaceChildren();
    $("aql-results").hidden = true;
};
async function refreshLibrary() {
    const connectionId = $("aql-connection").value;
    const libraryId = $("aql-unassigned").checked ? "" : connectionId;
    const [saved, history] = await Promise.all([
        api("saved", { connection_id: libraryId }),
        api("history", { connection_id: connectionId }),
    ]);
    if (connectionId !== $("aql-connection").value || libraryId !== ($("aql-unassigned").checked ? "" : connectionId))
        return;
    $("aql-library-context").textContent = libraryId
        ? "Private to your profile in this CDR environment."
        : "Private queries not yet assigned to a CDR. Load one and save it for the selected environment.";
    $("aql-saved-list").replaceChildren();
    $("aql-history-list").replaceChildren();
    for (const item of saved.items) {
        const row = el("div", undefined, "aql-list-row");
        row.append(
            el("span", item.name),
            button("Load", () => {
                if (!busy) {
                    $("aql-editor").value = item.query;
                    $("aql-parameters").value = "{}";
                    changed();
                }
            }),
            button("Delete", async () => {
                await api("saved-delete", { id: item.id, connection_id: libraryId });
                await refreshLibrary();
            }),
        );
        $("aql-saved-list").append(row);
    }
    for (const item of history.items) {
        const row = el("div", undefined, "aql-list-row"),
            label = el("span", item.query.slice(0, 90));
        label.append(
            el("small", item.status + " · " + new Date(item.at).toLocaleString() + " · " + item.duration_ms + "ms"),
        );
        row.append(
            label,
            button("Load", () => {
                if (!busy) {
                    $("aql-editor").value = item.query;
                    $("aql-parameters").value = JSON.stringify(
                        Object.fromEntries(item.parameter_names.map((name) => [name, ""])),
                        null,
                        2,
                    );
                    changed();
                    notice("Query restored. Enter parameter values before running.");
                }
            }),
        );
        $("aql-history-list").append(row);
    }
    if (!saved.items.length) $("aql-saved-list").append(el("p", "No saved queries yet."));
    if (!history.items.length) $("aql-history-list").append(el("p", "No query executions yet."));
}
$("aql-save-form").onsubmit = (event) => {
    event.preventDefault();
    safely(async () => {
        await api("saved-save", {
            name: $("aql-save-name").value,
            query: $("aql-editor").value,
            connection_id: $("aql-connection").value,
        });
        $("aql-unassigned").checked = false;
        notice("Query saved privately for this environment.");
        await refreshLibrary();
    });
};
$("aql-history-clear").onclick = () =>
    safely(async () => {
        await api("history-clear", { connection_id: $("aql-connection").value });
        await refreshLibrary();
    });
$("aql-unassigned").onchange = () => safely(refreshLibrary);
function resetModel() {
    model = null;
    selectedPaths.clear();
    $("aql-use-template").checked = false;
    $("aql-use-template").disabled = true;
    $("aql-path-controls").hidden = true;
    $("aql-model-status").textContent = "";
    hideSuggestions();
    changed();
}
function setModelFiles(files) {
    resetModel();
    files = [...files].sort(
        (a, b) => Number(/\.(adl|adls|adlf)$/i.test(a.path)) - Number(/\.(adl|adls|adlf)$/i.test(b.path)),
    );
    modelFiles = files;
    $("aql-model").replaceChildren(new Option("Choose a model", ""));
    $("aql-dependencies").replaceChildren();
    files.forEach((file, i) => {
        $("aql-model").append(new Option(file.path || file.identifier, String(i)));
        if (/\.(adl|adls|adlf)$/i.test(file.path || "")) $("aql-dependencies").append(new Option(file.path, String(i)));
    });
    if (files.length) $("aql-model").value = "0";
}
$("aql-source").onchange = () => {
    setModelFiles([]);
    $("aql-files-label").hidden = $("aql-source").value !== "local";
    $("aql-project-label").hidden = $("aql-source").value !== "enterprise";
};
$("aql-model").onchange = resetModel;
$("aql-dependencies").onchange = resetModel;
$("aql-use-template").onchange = changed;
$("aql-files").onchange = () =>
    safely(async () => {
        const identityGeneration = generation;
        const files = [...$("aql-files").files];
        if (
            files.length > 65 ||
            files.some((file) => file.size > 2097152) ||
            files.reduce((n, file) => n + file.size, 0) > 15000000
        )
            throw new Error("Choose up to 65 model files, at most 2 MiB each and 15 MiB together.");
        const loadedFiles = await Promise.all(
            files.map(async (file) => ({ path: file.name, content: await file.text(), source: "local_file" })),
        );
        if (identityGeneration === generation) setModelFiles(loadedFiles);
    });
async function projectFiles() {
    const data = await workspaceFetch("models/project?project=" + encodeURIComponent($("aql-project").value));
    setModelFiles(
        data.artifacts
            .filter((item) => /\.(opt(?:\.xml)?|oet|adlt|adl|adls|adlf|xml)$/i.test(item.path))
            .map((item) => ({ ...item, source: "enterprise", project: $("aql-project").value })),
    );
}
$("aql-project").onchange = () => safely(projectFiles);
$("aql-source-refresh").onclick = () =>
    safely(() =>
        work("Loading model source…", async () => {
            const source = $("aql-source").value;
            if (source === "local") {
                $("aql-files").click();
                return;
            }
            if (source === "enterprise") {
                const data = await workspaceFetch("models/projects");
                $("aql-project").replaceChildren(
                    ...data.projects.map((item) => new Option(item.name || item.id, item.id)),
                );
                if (data.projects.length) await projectFiles();
                else setModelFiles([]);
            } else if (source === "remote") {
                if (!$("aql-connection").value) throw new Error("Choose a CDR first.");
                const data = await api("templates", { id: $("aql-connection").value });
                setModelFiles(
                    data.items.map((item) => ({
                        ...item,
                        path: item.identifier,
                        source: "remote",
                        connection: $("aql-connection").value,
                    })),
                );
            } else {
                const data = await workspaceFetch("aql-repository/list", { repository: source });
                setModelFiles(
                    data.items
                        .filter(
                            (item) =>
                                item.type === "blob" &&
                                /\.(opt(?:\.xml)?|oet|adlt|adl|adls|adlf|xml)$/i.test(item.path),
                        )
                        .map((item) => ({ ...item, ref: data.ref, source: "personal", repository: source })),
                );
                if (data.windowed)
                    notice(
                        "This repository listing is limited to the first 100 entries. Download an omitted model and load it under Model files.",
                    );
            }
        }),
    );
async function readModel(file, includePackage = false) {
    if (file.content !== undefined) return file;
    if (file.source === "remote")
        return { ...file, ...(await api("templates", { id: file.connection, identifier: file.identifier })) };
    if (file.source === "enterprise")
        return {
            ...file,
            ...(await workspaceFetch(
                "models/artifact?project=" +
                    encodeURIComponent(file.project) +
                    "&path=" +
                    encodeURIComponent(file.path) +
                    "&revision=" +
                    encodeURIComponent(file.revision),
            )),
        };
    const data = await workspaceFetch("aql-repository/" + (includePackage ? "package" : "get"), {
        repository: file.repository,
        path: file.path,
        ref: file.ref,
    });
    if (!data.exists) throw new Error("The selected file no longer exists. Reload the source.");
    // Git tree revisions identify blobs; the read response identifies the pinned bytes independently.
    return { ...file, ...data, repository: file.repository, source: "personal" };
}
function dependencyIdentifier(content) {
    const match = content.match(/\bopenEHR-[A-Za-z0-9_.-]+/);
    if (!match) throw new Error("A dependency does not declare an openEHR archetype identifier.");
    return match[0];
}
$("aql-inspect").onclick = () =>
    safely(() =>
        work("Inspecting exact model paths…", async () => {
            if ($("aql-model").value === "") throw new Error("Choose a model first.");
            const source = await readModel(modelFiles[Number($("aql-model").value)], true);
            if (typeof source.content !== "string") throw new Error("The source did not return a text model.");
            const dependencies = (source.dependencies || []).map(({ identifier, content }) => ({
                identifier,
                content,
            }));
            // A manifest is authoritative. Manual choices are for local models
            // and older layouts that do not have a saved dependency package.
            for (const option of dependencies.length ? [] : $("aql-dependencies").selectedOptions) {
                if (option.value === $("aql-model").value) continue;
                const dep = await readModel(modelFiles[Number(option.value)]);
                dependencies.push({ identifier: dependencyIdentifier(dep.content), content: dep.content });
            }
            let content = source.content,
                format,
                webTemplate;
            const xml = /^\s*(?:<\?xml[^>]*>\s*)?</.test(content);
            const template =
                /\.oet(?:\.xml)?$|\.adlt$/i.test(source.path) ||
                /^\s*template\b/i.test(content) ||
                (xml &&
                    new DOMParser().parseFromString(content, "application/xml").documentElement.namespaceURI ===
                        "openEHR/v1/Template");
            if (template) {
                if (!dependencies.length && source.source === "local_file") {
                    for (const file of modelFiles.filter((item) => /\.(adl|adls|adlf)$/i.test(item.path)))
                        dependencies.push({ identifier: dependencyIdentifier(file.content), content: file.content });
                }
                $("aql-progress-text").textContent =
                    "Compiling template with " + dependencies.length + " exact archetypes…";
                const compiled = await api("compile", { content, dependencies });
                if (!compiled.valid || !compiled.output) {
                    renderReport(compiled);
                    throw new Error("The template could not be compiled. Check its exact dependencies and findings.");
                }
                content = compiled.output.content;
                format = compiled.output.format === "opt14_xml" ? "opt14" : "opt2";
                webTemplate = compiled.web_template?.content;
            } else format = xml ? "opt14" : /^\s*operational_template\b/i.test(content) ? "opt2" : "adl2";
            const inspection = await api("inspect", {
                content,
                format,
                dependencies: format === "adl2" ? dependencies : [],
            });
            if (!inspection.valid) {
                renderReport(inspection);
                throw new Error("This model did not pass its native inspection checks.");
            }
            model = {
                ...source,
                content,
                format,
                inspection,
                webTemplate,
                dependencies: format === "adl2" ? dependencies : [],
                template: format !== "adl2",
            };
            selectedPaths.clear();
            $("aql-model-status").textContent =
                (source.source === "remote" ? "Remote CDR model" : "Model") +
                " · " +
                source.path +
                (source.ref
                    ? " · commit " + source.ref.slice(0, 12)
                    : source.revision
                      ? " · revision " + source.revision
                      : "") +
                (template ? " · " + dependencies.length + " archetypes loaded" : "") +
                (source.dependencySource === "verified_manifest" ? " · package hashes verified" : "") +
                " · SHA-256 " +
                inspection.content_sha256;
            $("aql-use-template").checked = model.template;
            $("aql-use-template").disabled = !model.template;
            $("aql-path-controls").hidden = false;
            renderPaths();
        }),
    );
const modelFilename = () => (model?.inspection.identifier || "template").replace(/[^A-Za-z0-9_-]/g, "_");
$("aql-download-opt").onclick = () => {
    if (model?.template && !busy)
        download(model.content, modelFilename() + ".opt", model.format === "opt14" ? "application/xml" : "text/plain");
};
$("aql-download-web-template").onclick = () => {
    if (model?.webTemplate && !busy)
        download(model.webTemplate, modelFilename() + ".webtemplate.json", "application/json");
};
function renderPaths() {
    $("aql-paths").replaceChildren();
    if (!model) return;
    const filter = $("aql-path-filter").value.toLowerCase(),
        matches = model.inspection.inspection.paths.filter((path) =>
            (path.path + " " + path.rm_type + " " + (path.label || "") + " " + (path.description || ""))
                .toLowerCase()
                .includes(filter),
        );
    const summary = el("p");
    const selectionChanged = () => {
        summary.textContent = matches.length + " matching paths · " + selectedPaths.size + " selected";
        controls();
    };
    $("aql-paths").append(summary);
    selectionChanged();
    for (const path of matches.slice(0, 300)) {
        const row = el("div", undefined, "aql-path-row"),
            label = el("label", undefined, "aql-check"),
            check = el("input");
        check.type = "checkbox";
        check.checked = selectedPaths.has(path.path);
        check.onchange = () => {
            if (busy) {
                check.checked = selectedPaths.has(path.path);
                return;
            }
            if (check.checked && selectedPaths.size >= 30) {
                check.checked = false;
                notice("Select up to 30 paths for one query.");
                return;
            }
            check.checked ? selectedPaths.add(path.path) : selectedPaths.delete(path.path);
            selectionChanged();
        };
        label.append(
            check,
            document.createTextNode((path.label ? path.label + " · " : "") + path.path + " · " + path.rm_type),
        );
        row.append(
            label,
            button("Insert", () => {
                if (busy) return;
                const editor = $("aql-editor");
                editor.setRangeText(
                    "m" + (path.path === "/" ? "" : path.path),
                    editor.selectionStart,
                    editor.selectionEnd,
                    "end",
                );
                changed();
                editor.focus();
                notice(
                    "Path inserted using alias m. Ensure FROM defines that alias, or generate a query from selected paths.",
                );
            }),
        );
        $("aql-paths").append(row);
    }
    if (matches.length > 300)
        $("aql-paths").append(el("p", "Showing 300 paths. Refine the filter to find another field."));
}
$("aql-path-filter").oninput = renderPaths;
$("aql-clear-paths").onclick = () => {
    if (busy) return;
    selectedPaths.clear();
    renderPaths();
    notice("All selected paths cleared. Select fields to generate a new query; the current query is kept.");
};
$("aql-ask-assistant").onclick = () =>
    safely(() =>
        work("Assistant is drafting and checking your query…", async () => {
            if (!model) throw new Error("Inspect a model first.");
            const draft = await workspaceFetch("aql-draft", {
                provider: $("chat-provider").value,
                intent: $("aql-intent").value.trim() || "Suggest useful fields from this template",
                model: { content: model.content, format: model.format },
                paths: [...selectedPaths],
            });
            if (!draft.query || draft.executed !== false)
                throw new Error("The assistant did not return a query draft.");
            $("aql-editor").value = formatAql(draft.query);
            $("aql-parameters").value = JSON.stringify(draft.parameters, null, 2);
            $("aql-offset").value = 0;
            changed();
            renderReport(draft.validation);
            notice(
                "Draft placed in the AQL query box. Review it, enter any parameter values, then press Run query. " +
                    (draft.explanation || ""),
            );
            $("aql-editor").scrollIntoView({ block: "center", behavior: "smooth" });
            $("aql-editor").focus();
        }),
    );
$("aql-generate").onclick = () =>
    safely(() =>
        work("Generating query from model…", async () => {
            if (!model || !selectedPaths.size) throw new Error("Select at least one model path.");
            const generated = await api("generate", {
                content: model.content,
                format: model.format,
                paths: [...selectedPaths],
                dependencies: model.dependencies,
            });
            if (!generated.query) throw new Error("A query could not be generated from this model.");
            $("aql-editor").value = formatAql(generated.query);
            $("aql-parameters").value = JSON.stringify(generated.parameters, null, 2);
            $("aql-offset").value = 0;
            changed();
            renderReport(generated.validation);
            notice("Query draft generated. Review the fields and template identifier before running.");
        }),
    );
async function load() {
    if (loading || !session?.authenticated || !session.cdrEnabled) return;
    loading = true;
    try {
        await refreshConnections();
        await refreshLibrary();
        try {
            sources = (await workspaceFetch("connections")).personal.filter((item) => item.kind !== "ckm");
            const current = $("aql-source").value;
            for (const option of [...$("aql-source").options])
                if (!["local", "enterprise", "remote"].includes(option.value)) option.remove();
            for (const item of sources)
                $("aql-source").append(new Option(item.label || item.name || item.url, item.id));
            if ([...$("aql-source").options].some((option) => option.value === current))
                $("aql-source").value = current;
        } catch {
            /* Local and enterprise model sources remain usable. */
        }
        loaded = true;
        notice(
            connections.length
                ? ""
                : "Add a CDR in Manage connections to run queries. You can inspect and validate models first.",
        );
    } finally {
        loading = false;
    }
}
$("aql-refresh").onclick = () => safely(load);
document.addEventListener("workspace:aql", () => {
    if (!loaded) safely(load);
});
function updateSession(value) {
    const changedIdentity =
        session?.user?.id !== value.user?.id ||
        session?.csrf !== value.csrf ||
        session?.authenticated !== value.authenticated;
    if (changedIdentity) {
        generation++;
        loaded = false;
        result = null;
        model = null;
        modelFiles = [];
        connections = [];
        sources = [];
        $("aql-connection").replaceChildren(new Option("Choose a connection", ""));
        $("cdr-connection-list").replaceChildren();
        $("cdr-settings-status").textContent = "";
        $("aql-paths").replaceChildren();
        $("aql-path-controls").hidden = true;
        $("aql-findings").replaceChildren();
        $("aql-model-status").textContent = "";
        $("aql-model").replaceChildren(new Option("Choose a model", ""));
        $("aql-dependencies").replaceChildren();
        $("aql-intent").value = "";
        hideSuggestions();
        $("aql-project").replaceChildren();
        $("aql-files").value = "";
        $("aql-use-template").checked = false;
        for (const option of [...$("aql-source").options])
            if (!["local", "enterprise", "remote"].includes(option.value)) option.remove();
        if (session) {
            $("aql-editor").value = "SELECT e/ehr_id/value\nFROM EHR e\nLIMIT 100";
            $("aql-parameters").value = "{}";
            $("aql-save-name").value = "";
            highlight();
        }
        $("aql-result-body").replaceChildren();
        $("aql-results").hidden = true;
        $("aql-saved-list").replaceChildren();
        $("aql-history-list").replaceChildren();
        $("cdr-form").reset();
        $("cdr-form").hidden = true;
    }
    session = value;
    controls();
    if (!value.authenticated) notice("Sign in to inspect models and use your CDR connections.");
    else if (!value.cdrEnabled) notice("The AQL workspace is not enabled on this installation.");
    else if (document.body.dataset.section === "aql" && !loaded) safely(load);
}
document.addEventListener("workspace:query-model", (event) => {
    const source = event.detail;
    if (!source || typeof source.content !== "string" || busy) return;
    $("aql-source").value = "local";
    $("aql-files-label").hidden = false;
    $("aql-project-label").hidden = true;
    $("aql-model-section").open = true;
    setModelFiles([{ ...source, source: "enterprise" }]);
    notice(
        "Model loaded at the selected revision. Inspect its paths before generating a query. Load exact dependencies separately if it is an uncompiled template.",
    );
});
document.addEventListener("workspace:session", (event) => updateSession(event.detail));
fetch("/chat/api/session")
    .then((response) => response.json())
    .then(updateSession)
    .catch(() => notice("Could not check sign-in status. Refresh to retry."));
highlight();
showAuth();
controls();
