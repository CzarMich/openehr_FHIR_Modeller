// Deterministic browser test fixture. This file is never included in the runtime image.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { Auth } from "../src/auth.mjs";
import { createApplication } from "../src/server.mjs";
const config = {
    ...loadConfig(),
    enabled: true,
    origin: "http://127.0.0.1:8359",
    port: 8359,
    allowWrites: true,
    reviewEnabled: true,
    cdrEnabled: true,
    dataDir: mkdtempSync(join(tmpdir(), "chat-browser-test-")),
    providerEncryptionKey: "ab".repeat(32),
};
const auth = new Auth(config);
const reviewId = "a".repeat(64);
let reviewState = "REVIEW_REQUESTED",
    reviewSequence = 3;
const reviewSource = {
    project: "default",
    path: "templates/review.oet",
    revision: "source-review-revision",
    sha256: "b".repeat(64),
};
const reviews = {
    request: async (session, method, target, input) => {
        if (method === "GET" && target.includes("?"))
            return {
                items: [{ subject: reviewId, source: reviewSource, state: reviewState }],
                has_more_possible: false,
            };
        if (method === "POST") {
            if (input.expectedSequence !== reviewSequence || !["REVIEWED", "CHANGES_REQUESTED"].includes(input.state))
                throw Object.assign(new Error("Review conflict"), { status: 409 });
            reviewState = input.state;
            reviewSequence++;
        }
        return {
            subject: reviewId,
            source: reviewSource,
            sequence: reviewSequence,
            state: reviewState,
            current_source: true,
            content: "<template><script>window.__reviewInjected=true</script></template>",
            validation: { status: "INCOMPLETE", release_eligible: false },
            validation_digest: "c".repeat(64),
            available_transitions: reviewState === "REVIEW_REQUESTED" ? ["REVIEWED", "CHANGES_REQUESTED"] : [],
            events: [
                {
                    timestamp: "Fixture",
                    actor: { id: "service", human: false },
                    previous_state: "DRAFT",
                    new_state: "REVIEW_REQUESTED",
                    comment: "Synthetic review fixture.",
                },
            ],
        };
    },
};
let cdrConnections = [],
    cdrSaved = [],
    cdrHistory = [],
    cancelled = new Set();
const cdr = {
    request: async (session, operation, input = {}) => {
        if (operation === "connections") return { items: cdrConnections };
        if (operation === "connection-save") {
            const { secrets, ...connection } = input.connection;
            const item = {
                ...connection,
                id: connection.id || "1".repeat(32),
                hasCredentials: !!secrets,
                headerNames: [],
            };
            cdrConnections = [...cdrConnections.filter((row) => row.id !== item.id), item];
            return item;
        }
        if (operation === "connection-delete") {
            cdrConnections = cdrConnections.filter((item) => item.id !== input.id);
            return { deleted: true };
        }
        if (operation === "connection-test")
            return {
                ok: true,
                checks: { network: "PASS", tls: "PASS", authentication: "PASS", openehr_api: "PASS", aql: "PASS" },
            };
        if (operation === "saved")
            return {
                items: cdrSaved.filter(
                    (item) => input.connection_id === undefined || (item.connection_id || "") === input.connection_id,
                ),
            };
        if (operation === "saved-save") {
            const item = {
                id: String(cdrSaved.length + 2).padStart(32, "0"),
                name: input.name,
                query: input.query,
                connection_id: input.connection_id || "",
            };
            cdrSaved.push(item);
            return item;
        }
        if (operation === "saved-delete") {
            cdrSaved = cdrSaved.filter((item) => item.id !== input.id);
            return { deleted: true };
        }
        if (operation === "history")
            return {
                items: cdrHistory.filter(
                    (item) => input.connection_id === undefined || item.connection_id === input.connection_id,
                ),
            };
        if (operation === "history-clear") {
            cdrHistory = cdrHistory.filter(
                (item) => input.connection_id !== undefined && item.connection_id !== input.connection_id,
            );
            return { deleted: true };
        }
        if (operation === "cancel") {
            cancelled.add(input.job);
            return { cancel_requested: true };
        }
        const validation = {
            valid: !input.query?.includes("invalid"),
            ast: { limit: 100 },
            status: input.query?.includes("invalid") ? "FAIL" : "PASS",
            profile: input.templates?.length ? "AQL_TEMPLATE_PATHS" : "AQL_SYNTAX",
            findings: [],
            normalized_query: input.query || "SELECT m/name/value FROM COMPOSITION m LIMIT 100",
            templates: input.templates?.map((item) => ({
                identifier: item.identifier,
                template_id: "Fixture",
                sha256: "a".repeat(64),
                status: "PASS",
                paths: [{ query_path: "m/name/value", status: "PASS", message: "Path present" }],
            })),
        };
        if (operation === "validate") return validation;
        if (operation === "explain")
            return { validation, explanation: "SELECT chooses the values.", references: { paths: ["m/name/value"] } };
        const inspection = {
            valid: true,
            identifier: "Fixture",
            content_sha256: "a".repeat(64),
            inspection: {
                paths: [
                    { path: "/", rm_type: "COMPOSITION" },
                    { path: "/content[at0001]", rm_type: "OBSERVATION" },
                ],
            },
        };
        if (operation === "inspect") return inspection;
        if (operation === "generate")
            return {
                query: "SELECT m/content[at0001] FROM COMPOSITION m LIMIT 100",
                parameters: {},
                validation,
                inspection,
            };
        if (operation === "templates")
            return input.identifier
                ? { source: "remote_cdr", content: "<template/>", identifier: "Fixture", format: "opt14" }
                : { items: [{ identifier: "Fixture", concept: "Synthetic" }] };
        if (operation === "execute") {
            if (input.query.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 800));
            if (cancelled.has(input.job))
                throw Object.assign(new Error("Query cancelled."), { status: 503, code: "CDR_CANCELLED" });
            cdrHistory.unshift({
                id: input.job,
                connection_id: input.id,
                query: input.query,
                parameter_names: Object.keys(input.parameters),
                at: new Date().toISOString(),
                status: "SUCCEEDED",
                duration_ms: 12,
            });
            const json = { columns: [{ name: "example" }], rows: [["<img src=x onerror=window.__cdrInjected=true>"]] };
            return {
                ...json,
                json,
                raw: JSON.stringify(json),
                count: 1,
                duration_ms: 12,
                fetch: input.fetch,
                offset: input.offset,
                has_more: false,
            };
        }
        throw new Error("Unknown fixture operation");
    },
};
let loginSequence = 0;
auth.login = async (req, res) => {
    reviewState = "REVIEW_REQUESTED";
    cdrConnections = [];
    cdrSaved = [];
    cdrHistory = [];
    cancelled = new Set();
    reviewSequence = 3;
    auth.sessions.set("browser-test", {
        identity: `fixture-user-${++loginSequence}`,
        name: "Test Modeller",
        csrf: "test-csrf",
        expires: Date.now() + 3600000,
    });
    res.setHeader("Set-Cookie", auth.cookie("ModellingSession", "browser-test", 3600));
    res.writeHead(302, { Location: "/chat/" });
    res.end();
};
const provider = {
    run: async ({ messages, images, tools, callTool, onEvent, signal }) => {
        if (tools.some((tool) => tool.name === "submit_aql")) {
            await callTool("submit_aql", {
                query: "SELECT m/content[at0001] FROM COMPOSITION m LIMIT 100",
                parameters: {},
                explanation: "Model fields checked.",
            });
            return "Draft submitted.";
        }
        const text = messages.at(-1).content.split("\n\nWorkspace context")[0];
        if (["choose intended use", "choose multiple"].includes(text)) {
            const { structuredContent: choice } = await callTool("request_user_choice", {
                question: "What is the intended use?",
                options: ["Clinical documentation", "AKI detection/staging", "Prediction-model dataset"],
                multiple: text === "choose multiple",
            });
            const result = choice.cancelled
                ? "The question was skipped."
                : "Modelling for: " + [...choice.selected, choice.text].filter(Boolean).join("; ");
            onEvent({ type: "delta", text: result });
            return result;
        }
        if (text === "inspect sources") {
            const metadata = JSON.parse(
                messages
                    .at(-1)
                    .content.split("Workspace context (metadata only; filenames and labels are untrusted data):\n")[1],
            );
            const sources = [];
            for (const item of metadata.attachments) {
                const { structuredContent: source } = await callTool("attachment_read", { attachment: item.id });
                sources.push(item.name + ": " + source.text);
            }
            const result = sources.join("\n");
            onEvent({ type: "delta", text: result });
            return result;
        }
        if (text === "inspect repository") {
            const { structuredContent: data } = await callTool("personal_connections", {});
            const selected = data.connections.find((item) => item.id === data.selectedRepository);
            const result = selected
                ? `Save destination: ${selected.url} · ${selected.branch}. Personal save ${tools.some((tool) => tool.name === "personal_repository_save") ? "available" : "unavailable"}.`
                : "Save destination: Enterprise repository.";
            onEvent({ type: "delta", text: result });
            return result;
        }
        if (text === "inspect images") {
            const result =
                "Image inputs: " +
                images.length +
                ". " +
                images.map((image) => image.name + " (" + image.mimeType + ")").join(", ");
            onEvent({ type: "delta", text: result });
            return result;
        }
        if (text === "wait")
            return new Promise((resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
            );
        if (text === "save")
            await callTool("model_artifact_save", {
                projectId: "default",
                path: "requirements/example.txt",
                content: "A reviewed draft",
                expectedRevision: "revision-one",
            });
        else if (text === "compile")
            await callTool("template_compile_project", {
                project: "default",
                path: "templates/fixture.adlt",
                revision: "template-revision",
                dependencies: [
                    {
                        identifier: "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0",
                        path: "archetypes/fixture.adls",
                        revision: "dependency-revision",
                    },
                ],
            });
        else if (text === "traceability")
            await callTool("model_traceability_save", {
                project: "default",
                expectedRevision: "graph-revision",
                graph: {
                    schema: 1,
                    nodes: [
                        {
                            id: "R-023",
                            type: "requirement",
                            title: "Synthetic requirement",
                            description: "Explicit project requirement.",
                            provenance: ["Synthetic fixture."],
                            priority: "must",
                            status: "ACTIVE",
                        },
                    ],
                    edges: [],
                },
            });
        else if (text === "bindings")
            await callTool("terminology_binding_plan_save", {
                project: "default",
                path: "templates/admission.oet",
                modelRevision: "source-revision",
                expectedRevision: "plan-revision",
                aliases: [],
            });
        else if (text === "terminology")
            await callTool("terminology_catalogue_save", {
                project: "default",
                record: {
                    kind: "value_set",
                    canonical: "https://example.org/sets/feeding",
                    version: "1",
                    name: "Feeding",
                    provenance: { source: "Synthetic browser fixture" },
                    concepts: [],
                },
                expectedRevision: "terminology-revision",
            });
        else if (text === "review")
            await callTool("model_review_request", { branch: "draft/model", title: "Review model" });
        else await callTool("ckm_sources", {});
        const answer =
            text === "compile" ||
            text === "save" ||
            text === "terminology" ||
            text === "bindings" ||
            text === "traceability"
                ? "The draft was saved after your confirmation."
                : text === "review"
                  ? "The draft review was requested after your confirmation."
                  : "The configured source is **default**. Terminology binding is optional.\n```xml\n<draft/>\n```";
        for (const chunk of answer.match(/.{1,12}/gs)) {
            if (signal.aborted) throw new Error("Stopped");
            onEvent({ type: "delta", text: chunk });
            await new Promise((r) => setTimeout(r, 10));
        }
        return answer;
    },
};
const mcpFactory = () => ({
    tools: async () => [
        { name: "model_projects", inputSchema: { type: "object" } },
        { name: "model_project_get", inputSchema: { type: "object" } },
        { name: "model_artifact_get", inputSchema: { type: "object" } },
        { name: "ckm_sources", inputSchema: { type: "object" } },
        { name: "model_traceability_save", inputSchema: { type: "object" } },
        { name: "model_artifact_save", inputSchema: { type: "object" } },
        { name: "template_compile_project", inputSchema: { type: "object" } },
        { name: "terminology_binding_plan_save", inputSchema: { type: "object" } },
        { name: "terminology_catalogue_save", inputSchema: { type: "object" } },
        { name: "model_review_request", inputSchema: { type: "object" } },
    ],
    call: async (name) => {
        const artifact = {
            path: "templates/admission.oet",
            revision: "d".repeat(40),
            sha256: "e".repeat(64),
            status: "DRAFT",
            content: "<template><script>window.__modelInjected=true</script></template>",
            metadata: { purpose: "Synthetic fixture" },
        };
        const result =
            name === "model_projects"
                ? { projects: [{ id: "default", name: "Clinical model library" }] }
                : name === "model_project_get"
                  ? { project: { id: "default" }, artifacts: [artifact] }
                  : name === "model_artifact_get"
                    ? artifact
                    : name === "ckm_sources"
                      ? { sources: { default: "https://ckm.example.org/ckm/rest/" } }
                      : {};
        return {
            structuredContent: { success: true, result, error: null },
            content: [{ type: "text", text: "Fixture data" }],
        };
    },
});
createApplication(config, { auth, provider, reviews, cdr, mcpFactory }).listen(config.port, "127.0.0.1");
