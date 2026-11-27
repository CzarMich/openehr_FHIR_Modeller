import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { problem } from "./personal-http.mjs";

export class IntegrationCore {
    constructor(config, { fetcher = fetch, launcher = spawn } = {}) {
        this.config = config;
        this.fetcher = fetcher;
        this.launcher = launcher;
        this.origin = "http://127.0.0.1:8351";
        this.key = config.mcpKey || randomBytes(32).toString("hex");
        this.keys = config.integrationApprovalKeys || { [config.reviewKeyId]: config.reviewSigningKey };
        this.ready = false;
    }
    async start() {
        if (!this.config.integrationEnabled) return;
        if (!this.config.reviewEnabled || !this.config.reviewSigningKey)
            throw problem("Integration requires verified human review.", 503);
        const directory = join(this.config.dataDir, "integration-service");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const operationalKeyFile = join(directory, "operational-key");
        if (!existsSync(operationalKeyFile)) {
            if (existsSync(join(this.config.dataDir, "integration-operational", "operational.sqlite")))
                throw problem(
                    "The patient identity encryption key is missing. Restore the original key before starting.",
                    503,
                );
            try {
                writeFileSync(operationalKeyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        if (lstatSync(operationalKeyFile).isSymbolicLink() || lstatSync(operationalKeyFile).size !== 32)
            throw problem("The patient identity encryption key is invalid.", 503);
        const configuration = {
            modelRoot: join(this.config.dataDir, "integration-models"),
            fhirUrl: this.config.integrationFhirUrl,
            fhirKeyFile: this.config.integrationFhirKeyFile,
            nativeUrl: this.config.integrationNativeUrl,
            nativeKeyFile: this.config.integrationNativeKeyFile,
            operationalRoot: join(this.config.dataDir, "integration-operational"),
            operationalKeyFile,
            connectionsFile: this.config.integrationConnectionsFile || null,
            runtimeFiles: [
                join(dirname(this.config.integrationWorker), "Modeller.Processing.dll"),
                join(dirname(this.config.integrationWorker), "Modeller.Operational.dll"),
            ],
            sources: [],
            destinations: [],
            requireTerminology: true,
        };
        this.configuration = configuration;
        this.configurationFile = join(directory, "configuration.json");
        writeFileSync(this.configurationFile, JSON.stringify(configuration), { mode: 0o600 });
        const keyFile = join(directory, "mcp-key");
        writeFileSync(keyFile, this.key, { mode: 0o600 });
        const env = {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            HTTP_CA_BUNDLE: process.env.HTTP_CA_BUNDLE,
            DOTNET_ENVIRONMENT: "Production",
            DOTNET_EnableDiagnostics: "0",
            DOTNET_GCHeapHardLimit: "0x18000000",
            ASPNETCORE_URLS: this.origin,
            GUIDE_ROOT: "/app/integration/resources/guides",
            DOTNET_MCP_API_KEY_FILE: keyFile,
            DOTNET_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
            DOTNET_MCP_ALLOWED_ORIGINS: this.config.origin,
            MODELLER_WORKSPACE_ENABLED: "true",
            MODELLER_PROCESSING_CONFIG: this.configurationFile,
            MODELLER_APPROVAL_KEYS: JSON.stringify(this.keys),
            MODELLER_APPROVAL_KEY_ID: this.config.reviewKeyId,
            MODELLER_BROWSER_ORIGIN: this.config.origin,
            MODELLER_IDENTITY_ISSUERS: [this.config.localIssuer, this.config.issuer].filter(Boolean).join(","),
            MODELLER_DRAFT_WRITES_ENABLED: this.config.allowWrites ? "true" : "false",
        };
        this.child = this.launcher(this.config.integrationServer, [], {
            env,
            stdio: ["ignore", "ignore", "ignore"],
            shell: false,
        });
        this.child.on("error", () => {
            this.ready = false;
        });
        this.child.on("exit", () => {
            this.ready = false;
        });
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.child.exitCode !== null) throw problem("The C# modelling service could not start.", 503);
            try {
                const response = await this.fetcher(this.origin + "/ready", { signal: AbortSignal.timeout(1000) });
                if (response.ok) {
                    this.ready = true;
                    return;
                }
            } catch {
                /* Startup is bounded and does not log environment/credentials. */
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        this.child.kill("SIGTERM");
        throw problem("The C# modelling service did not become ready.", 503);
    }
    stop() {
        this.ready = false;
        this.child?.kill("SIGTERM");
    }
    async request(session, method, target, input) {
        if (!this.ready) throw problem("The C# modelling service is unavailable.", 503);
        if (
            !/^\/api\/v1\/integration\/(?:projects(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/(?:models|mappings|reuse|source-trust|pending\/(?:inspect|resolve-patient|resolve-relationship|recover)|destinations\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/privacy))?)?|mappings\/[a-f0-9]{64}(?:\/decisions)?|execute)$/.test(
                target,
            )
        )
            throw problem("Invalid integration operation.");
        const identity = session?.reviewIdentity,
            now = Math.floor(Date.now() / 1000);
        if (
            typeof session?.identity !== "string" ||
            !identity ||
            now - identity.started >
                (method === "GET" ||
                /^\/api\/v1\/integration\/projects\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/reuse$/.test(target)
                    ? this.config.sessionSeconds
                    : this.config.reviewSessionSeconds)
        )
            throw problem("Refresh sign-in before changing an integration.", 401);
        const body = input === undefined ? "" : JSON.stringify(input);
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw problem("The model request exceeds the limit.", 413);
        const header = { alg: "HS256", typ: "openehr-integration+jwt", kid: this.config.reviewKeyId };
        const claims = {
            iss: this.config.origin,
            aud: "openehr-modelling-integration",
            identity_issuer: identity.issuer,
            identity_method: identity.method || "interactive_oidc",
            sub: identity.subject,
            tenant: identity.tenant,
            roles: identity.roles,
            project_scopes: identity.projectScopes || [],
            owner_hash: createHash("sha256").update(session.identity).digest("hex"),
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
        const token =
            signing + "." + createHmac("sha256", this.config.reviewSigningKey).update(signing).digest("base64url");
        const response = await this.fetcher(this.origin + target, {
            method,
            headers: { "X-API-Key": this.key, Authorization: "Bearer " + token, "Content-Type": "application/json" },
            body: body || undefined,
            redirect: "error",
            signal: AbortSignal.timeout(650000),
        });
        if (Number(response.headers.get("content-length") || 0) > 20 * 1024 * 1024)
            throw problem("The modelling response exceeds the limit.", 503);
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 20 * 1024 * 1024) throw problem("The modelling response exceeds the limit.", 503);
            chunks.push(chunk);
        }
        let result;
        try {
            result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
            throw problem("The C# service returned an incomplete response.", 503);
        }
        if (!response.ok) {
            const code = /^[A-Z][A-Z0-9_]{0,100}$/.test(result.error || "")
                ? result.error
                : "MODELLING_OPERATION_FAILED";
            throw Object.assign(
                problem(
                    "Integration operation failed (" + code + ").",
                    [400, 401, 403, 404, 409, 413, 422, 503].includes(response.status) ? response.status : 502,
                ),
                { code },
            );
        }
        return result;
    }
}
