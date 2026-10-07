import { createHmac, createHash, randomBytes } from "node:crypto";

export const CDR_OPERATIONS = new Set([
    "connections",
    "connection-save",
    "connection-delete",
    "connection-test",
    "capabilities",
    "templates",
    "execute",
    "execute-metadata",
    "cancel",
    "history",
    "history-clear",
    "saved",
    "saved-get",
    "saved-save",
    "saved-delete",
    "validate",
    "explain",
    "generate",
    "inspect",
    "compile",
]);
export const CDR_TOOLS = new Set([
    "cdr_connection_list",
    "cdr_connection_test",
    "cdr_capabilities",
    "aql_execute",
    "aql_history",
    "aql_saved_list",
    "aql_saved_get",
    "aql_saved_save",
]);
// Query libraries may contain patient identifiers in user-entered literals.
// Keep them, and real execution, exclusively in the authenticated browser UI.
export const CDR_BROWSER_ONLY_TOOLS = new Set(["aql_execute", "aql_history", "aql_saved_list", "aql_saved_get"]);

export class CdrClient {
    constructor(config, fetcher = fetch) {
        Object.assign(this, { config, fetcher });
    }
    async request(session, operation, input = {}, signal) {
        if (!this.config.cdrEnabled)
            throw Object.assign(new Error("CDR connections are not configured on this installation."), { status: 503 });
        if (!CDR_OPERATIONS.has(operation)) throw Object.assign(new Error("Unknown CDR operation."), { status: 400 });
        const identity = session.reviewIdentity,
            now = Math.floor(Date.now() / 1000);
        if (!identity || now - identity.started > this.config.sessionSeconds)
            throw Object.assign(new Error("Sign in again to use your CDR connections."), { status: 401 });
        const target = "/api/v1/cdr/" + operation,
            body = JSON.stringify(input);
        const header = { alg: "HS256", typ: "openehr-cdr+jwt", kid: this.config.reviewKeyId };
        const claims = {
            iss: this.config.origin,
            aud: "openehr-modelling-cdr",
            identity_issuer: identity.issuer,
            identity_method: identity.method || "interactive_oidc",
            sub: identity.subject,
            tenant: identity.tenant,
            roles: identity.roles,
            project_scopes: identity.projectScopes || [],
            session_started: identity.started,
            iat: now,
            exp: now + 60,
            jti: randomBytes(32).toString("hex"),
            method: "POST",
            target,
            body_sha256: createHash("sha256").update(body).digest("hex"),
        };
        const signing = [header, claims]
            .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
            .join(".");
        const token =
            signing + "." + createHmac("sha256", this.config.reviewSigningKey).update(signing).digest("base64url");
        let response, result;
        try {
            response = await this.fetcher(new URL(target, this.config.reviewApiOrigin), {
                method: "POST",
                headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
                body,
                redirect: "error",
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(170000)]) : AbortSignal.timeout(170000),
            });
            const chunks = [];
            let size = 0;
            for await (const chunk of response.body) {
                size += chunk.length;
                if (size > 32 * 1024 * 1024) throw new Error();
                chunks.push(chunk);
            }
            result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
            throw Object.assign(
                new Error(
                    error.name === "AbortError"
                        ? "Query cancelled."
                        : "The CDR service could not be reached or returned an incomplete response.",
                ),
                { status: 503, code: error.name === "AbortError" ? "CDR_CANCELLED" : "CDR_UNAVAILABLE" },
            );
        }
        if (!response.ok) {
            const code = /^(?:CDR|ENGINE)_[A-Z_]{1,70}$/.test(result?.error?.code || "")
                ? result.error.code
                : "CDR_OPERATION_FAILED";
            const messages = {
                CDR_REDIRECT_REFUSED:
                    "The server redirected the API request, often to a sign-in page. Use its direct openEHR API address and an API credential in Settings.",
                CDR_SIGN_IN_REQUIRED: "Your session expired. Sign in again.",
                CDR_AUTHENTICATION_FAILED: "The CDR rejected these credentials. Update the connection in Settings.",
                CDR_FORBIDDEN: "This account does not have permission to query the CDR.",
                CDR_TIMEOUT:
                    "The CDR did not finish within the connection timeout. Narrow the query or increase its timeout in Settings.",
                CDR_CANCELLED: "Query cancelled.",
                CDR_AQL_INVALID: "The AQL is invalid. Select Validate to see the findings.",
                CDR_QUERY_REJECTED:
                    "The CDR rejected the query or parameters. Validate the query and check the CDR's supported AQL features.",
                CDR_API_UNSUPPORTED: "This CDR does not expose the requested API at the configured address.",
                CDR_TLS_FAILED:
                    "The server certificate could not be verified. Check the address or configure its CA certificate.",
                CDR_QUERY_LIMIT_REQUIRED:
                    "Use an AQL LIMIT between 1 and 1000, or remove LIMIT to use the page-size control.",
                CDR_PAGINATION_CONFLICT: "Remove AQL LIMIT/OFFSET before using the page controls.",
                CDR_QUERY_ALREADY_RUNNING: "A query is already running. Cancel it or wait for it to finish.",
                CDR_NETWORK_NOT_ALLOWED:
                    "This address is on a private network. An administrator must allow its hostname before it can be used.",
                CDR_HTTPS_REQUIRED:
                    "Use an HTTPS address. Private HTTP development servers need administrator configuration.",
                CDR_CONNECTION_NOT_FOUND: "This connection is no longer available. Refresh the list.",
                CDR_CONNECTION_DISABLED: "Enable this connection in Settings before using it.",
                CDR_CREDENTIAL_REQUIRED: "Enter the credential required by the selected authentication method.",
                CDR_ENDPOINT_ORIGIN_MISMATCH:
                    "The API and query endpoints must use the same server and port as the base URL.",
            };
            throw Object.assign(
                new Error(
                    messages[code] ||
                        "The CDR operation could not be completed. Check the connection settings and retry.",
                ),
                { code, status: [400, 401, 403, 404].includes(response.status) ? response.status : 503 },
            );
        }
        return result;
    }
    async tool(session, name, args, signal) {
        if (CDR_BROWSER_ONLY_TOOLS.has(name))
            throw Object.assign(
                new Error(
                    "Patient-data protection: execution, results, query history and saved query contents are available only in the AQL workspace. The assistant can draft and validate queries; use Run query yourself.",
                ),
                { status: 403, userSafe: true },
            );
        const allowed = {
            cdr_connection_list: [],
            cdr_connection_test: ["connection_id"],
            cdr_capabilities: ["connection_id"],
            aql_execute: ["connection_id", "query", "parameters", "fetch", "offset"],
            aql_history: [],
            aql_saved_list: [],
            aql_saved_get: ["id"],
            aql_saved_save: ["name", "query", "id"],
        };
        if (
            !Object.hasOwn(allowed, name) ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).some((key) => !allowed[name].includes(key))
        )
            throw Object.assign(new Error("Invalid CDR tool arguments. Configure credentials in Settings."), {
                status: 400,
            });
        const mapping = {
            cdr_connection_list: ["connections", {}],
            cdr_connection_test: ["connection-test", { id: args.connection_id }],
            cdr_capabilities: ["capabilities", { id: args.connection_id }],
            aql_execute: [
                "execute-metadata",
                {
                    id: args.connection_id,
                    query: args.query,
                    parameters: args.parameters || {},
                    fetch: args.fetch ?? 100,
                    offset: args.offset ?? 0,
                },
            ],
            aql_history: ["history", {}],
            aql_saved_list: ["saved", {}],
            aql_saved_get: ["saved-get", { id: args.id }],
            aql_saved_save: ["saved-save", { name: args.name, query: args.query, ...(args.id ? { id: args.id } : {}) }],
        };
        if (!Object.hasOwn(mapping, name)) throw new Error("Unknown CDR tool");
        const [operation, input] = mapping[name];
        const result = await this.request(session, operation, input, signal);
        const envelope = { success: true, result, error: null };
        return { structuredContent: envelope, content: [{ type: "text", text: JSON.stringify(envelope) }] };
    }
}
