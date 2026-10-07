import { createHmac, createHash, randomBytes } from "node:crypto";

export class ReviewClient {
    constructor(config, fetcher = fetch) {
        this.config = config;
        this.fetcher = fetcher;
    }
    async request(session, method, target, input) {
        if (!this.config.reviewEnabled)
            throw Object.assign(new Error("Model review is not configured."), { status: 503 });
        const identity = session.reviewIdentity;
        const now = Math.floor(Date.now() / 1000);
        const maximumAge = method === "GET" ? this.config.sessionSeconds : this.config.reviewSessionSeconds;
        if (!identity || now - identity.started > maximumAge)
            throw Object.assign(new Error("Sign in again before reviewing a model."), { status: 401 });
        if (!/^\/api\/v1\/reviews(?:\?|\/[a-f0-9]{64}(?:\/transitions)?$|$)/.test(target))
            throw new Error("Invalid review operation");
        const body = input === undefined ? "" : JSON.stringify(input);
        const header = { alg: "HS256", typ: "openehr-review+jwt", kid: this.config.reviewKeyId };
        const claims = {
            iss: this.config.origin,
            aud: "openehr-modelling-review",
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
            method,
            target,
            body_sha256: createHash("sha256").update(body).digest("hex"),
        };
        const signing = [header, claims]
            .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
            .join(".");
        const signature = createHmac("sha256", this.config.reviewSigningKey).update(signing).digest("base64url");
        const url = new URL(target, this.config.reviewApiOrigin);
        const response = await this.fetcher(url, {
            method,
            headers: { Authorization: `Bearer ${signing}.${signature}`, "Content-Type": "application/json" },
            body: body || undefined,
            redirect: "error",
            signal: AbortSignal.timeout(60000),
        });
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 16 * 1024 * 1024) throw new Error("Review response exceeds the limit");
            chunks.push(chunk);
        }
        let result;
        try {
            result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
            throw new Error("Review service returned an invalid response");
        }
        if (!response.ok) {
            const code = result?.error?.code;
            const safe = typeof code === "string" && /^[A-Z_]{1,100}$/.test(code) ? code : "REVIEW_SERVICE_FAILED";
            const messages = {
                INTERACTIVE_REVIEW_AUTHENTICATION_REQUIRED:
                    "Your review sign-in needs to be refreshed. Use Refresh sign-in to continue with the same account.",
                GOVERNANCE_ROLE_REQUIRED:
                    "Your signed-in account has no model governance role. A platform administrator can assign one; refresh sign-in after the role changes.",
                GOVERNANCE_REVISION_CONFLICT: "Another decision was recorded. Reload the review before continuing.",
                GOVERNANCE_SOURCE_CHANGED: "The source changed. Prepare a review for the new revision.",
                GOVERNANCE_VALIDATION_REQUIRED: "Required validation checks have not passed.",
                GOVERNANCE_INDEPENDENT_HUMAN_REQUIRED:
                    "This action requires an independent reviewer with the appropriate role.",
                GOVERNANCE_VALIDATION_CONFIRMATION_REQUIRED:
                    "The validation evidence changed. Reload and review it again.",
                GOVERNANCE_NOT_CONFIGURED: "Model review is not configured on this deployment.",
                WRITES_DISABLED: "Changes are disabled on this deployment.",
            };
            throw Object.assign(new Error(messages[safe] || "The review service could not complete this action."), {
                code: safe,
                status: [400, 401, 403, 404, 409, 413, 503].includes(response.status) ? response.status : 502,
            });
        }
        return result;
    }
}
