import { randomUUID, createHash } from "node:crypto";
import { problem } from "./personal-http.mjs";

// Closed action lists are shared by browser routes and conversational tool dispatch.
// Unknown actions fail closed: adding a backend mutation cannot bypass confirmation.
// Allow the bounded ten-minute validator job to return its actual evidence.
export const FHIR_REQUEST_TIMEOUT_MS = 650000;
export const FHIR_ACTIONS = Object.freeze({
    fhir_project: { read: ["list", "get", "capabilities"], write: ["create", "update"] },
    fhir_source: { read: ["inspect"], write: ["import"] },
    fhir_package: { read: ["search", "get", "dependencies", "artifacts", "resolve"], write: ["install"] },
    fhir_artifact: { read: ["inspect", "get", "search", "validate", "diff", "history"], write: ["save"] },
    fhir_profile: { read: ["discover", "generate", "validate"], write: [] },
    fhir_fsh_compile: { read: ["compile"], write: [] },
    fhir_example_generate: { read: ["generate"], write: [] },
    fhir_fhirpath: { read: ["validate", "evaluate"], write: [] },
    fhir_mapping: { read: ["list", "get", "analyse"], write: ["save"] },
    fhir_connection: { read: ["list", "get", "test", "metadata", "search", "read", "validate"], write: [] },
    fhir_ig: { read: ["test", "projects", "status"], write: ["submit", "sync"] },
});
export const isFhirTool = (name) => Object.hasOwn(FHIR_ACTIONS, name);
const directActions = { fhir_fsh_compile: "compile", fhir_example_generate: "generate" };
export function isFhirWrite(name, args) {
    if (!isFhirTool(name)) return false;
    const action = directActions[name] || args?.action;
    if (FHIR_ACTIONS[name].read.includes(action)) return false;
    return true;
}
export function validateFhirCall(name, args) {
    if (!isFhirTool(name)) throw problem("Unknown FHIR operation.", 404);
    const action = directActions[name] || args?.action;
    if (![...FHIR_ACTIONS[name].read, ...FHIR_ACTIONS[name].write].includes(action))
        throw problem("Unsupported FHIR action.");
    const fields =
        name === "fhir_project"
            ? ["action", "projectId", "document", "expectedRevision"]
            : directActions[name]
              ? ["projectId", "arguments"]
              : ["action", "projectId", "arguments"];
    if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => !fields.includes(key))
    )
        throw problem("Invalid FHIR request fields.");
    if (name !== "fhir_project" || !["list", "capabilities"].includes(action)) {
        if (typeof args.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.projectId))
            throw problem("Choose a valid FHIR project.");
    }
    for (const key of ["document", "arguments"])
        if (args[key] !== undefined) {
            let value;
            try {
                value = JSON.parse(args[key]);
            } catch {
                throw problem("FHIR " + key + " must be a JSON object.");
            }
            if (!value || typeof value !== "object" || Array.isArray(value))
                throw problem("FHIR " + key + " must be a JSON object.");
        }
    if (
        args.expectedRevision !== undefined &&
        args.expectedRevision !== null &&
        typeof args.expectedRevision !== "string"
    )
        throw problem("Invalid project revision.");
    return args;
}

export function fhirResult(response) {
    let value = response?.structuredContent;
    if (!value) {
        try {
            value = JSON.parse(response?.content?.find((item) => item.type === "text")?.text);
        } catch {
            throw problem("The FHIR service returned an incomplete response.", 503);
        }
    }
    if (response?.isError || value?.success !== true) {
        // Endpoint diagnostics are untrusted; forward stable codes, never raw upstream
        // headers, credential-bearing URLs or arbitrary exception messages.
        const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(value?.error?.code || "")
            ? value.error.code
            : "FHIR_OPERATION_FAILED";
        const error = problem(
            "FHIR operation failed (" + code + "). Check project configuration and validation evidence.",
            422,
        );
        error.code = code;
        throw error;
    }
    if (!value.result || typeof value.result !== "object") throw problem("Invalid FHIR response.", 503);
    return { result: value.result, provenance: value.provenance || null };
}

// A single-use ticket binds a human review to exact arguments and authenticated identity.
// A preview never executes the mutation; cancellation and expiration make no changes.
export class FhirWorkspace {
    constructor({ allowWrites, now = Date.now } = {}) {
        this.allowWrites = !!allowWrites;
        this.now = now;
        this.pending = new Map();
    }
    async execute(client, identity, input) {
        const { tool, args, confirmation } = input;
        validateFhirCall(tool, args);
        if (isFhirWrite(tool, args)) {
            if (!this.allowWrites) throw problem("FHIR changes are disabled by this installation.", 403);
            for (const [id, value] of this.pending) if (value.expires < this.now()) this.pending.delete(id);
            const digest = createHash("sha256").update(JSON.stringify({ tool, args })).digest("hex");
            if (!confirmation) {
                // Bound retained state per user and globally, even if a client abandons dialogs.
                for (const [id, value] of this.pending) if (value.identity === identity) this.pending.delete(id);
                if (this.pending.size >= 128) throw problem("FHIR confirmations are busy. Retry shortly.", 429);
                const token = randomUUID();
                this.pending.set(token, { identity, digest, expires: this.now() + 120000 });
                return { confirmationRequired: true, confirmation: token, tool, args };
            }
            const ticket = this.pending.get(confirmation);
            if (!ticket || ticket.identity !== identity || ticket.digest !== digest)
                throw problem("This confirmation expired or the proposed change changed. Review it again.", 409);
            this.pending.delete(confirmation);
        } else if (confirmation) throw problem("This read operation does not accept confirmation.");
        if (!(await client.tools()).some((item) => item.name === tool))
            throw problem("FHIR modelling is unavailable on this deployment.", 503);
        return fhirResult(await client.call(tool, args));
    }
}
