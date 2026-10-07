import { resolve } from "node:path";

export function loadConfig(env = process.env) {
    const boundedInteger = (name, fallback, minimum, maximum) => {
        const value = Number(env[name] ?? fallback);
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid " + name);
        return value;
    };
    const enabled = env.CHAT_ENABLED === "true";
    const publicUrl = new URL(env.CHAT_PUBLIC_URL || "http://localhost:8350");
    if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash)
        throw new Error("Invalid CHAT_PUBLIC_URL");
    if (
        publicUrl.protocol !== "https:" &&
        !(["localhost", "127.0.0.1"].includes(publicUrl.hostname) && publicUrl.protocol === "http:")
    )
        throw new Error("Chat requires HTTPS");
    const config = {
        enabled,
        port: Number(env.CHAT_PORT || 8350),
        origin: publicUrl.origin,
        secure: publicUrl.protocol === "https:",
        dataDir: resolve(env.CHAT_DATA_DIR || "/data/chat"),
        identityEnabled: env.CHAT_LOCAL_IDENTITY_ENABLED === "true",
        signupEnabled: env.CHAT_SIGNUP_ENABLED !== "false",
        localIssuer: env.CHAT_LOCAL_IDENTITY_ISSUER || publicUrl.origin + "/identity/local",
        identityEncryptionKey: env.CHAT_LOCAL_IDENTITY_ENCRYPTION_KEY || "",
        issuer: env.CHAT_OIDC_ISSUER || "",
        clientId: env.CHAT_OIDC_CLIENT_ID || "",
        clientSecret: env.CHAT_OIDC_CLIENT_SECRET || "",
        allowedGroups: (env.CHAT_ALLOWED_GROUPS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        mcpUrl: env.CHAT_MCP_URL || "http://ingress:8343/mcp",
        mcpKey: env.CHAT_MCP_API_KEY || "",
        mcpKeyHeader: env.CHAT_MCP_API_KEY_HEADER || "X-API-Key",
        allowWrites: env.CHAT_ALLOW_WRITES === "true",
        personalAllowedHosts: (env.CHAT_PERSONAL_ALLOWED_HOSTS || "")
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
        reviewEnabled: env.CHAT_REVIEW_ENABLED === "true",
        cdrEnabled: env.CHAT_CDR_ENABLED === "true",
        reviewSigningKey: env.CHAT_REVIEW_SIGNING_KEY || "",
        reviewKeyId: env.CHAT_REVIEW_KEY_ID || "active",
        reviewRolesClaim: env.CHAT_REVIEW_ROLES_CLAIM || "roles",
        reviewTenantClaim: env.CHAT_REVIEW_TENANT_CLAIM || "",
        reviewProjectScopesClaim: env.CHAT_REVIEW_PROJECT_SCOPES_CLAIM || "project_scopes",
        reviewSessionSeconds: Number(env.CHAT_REVIEW_SESSION_MAX_AGE || 900),
        reviewApiOrigin: new URL(env.CHAT_MCP_URL || "http://ingress:8343/mcp").origin,
        model: env.CHAT_MODEL || "gpt-6-sol",
        claudeModel: env.CHAT_CLAUDE_MODEL || "claude-sonnet-5-5",
        providerEncryptionKey: env.CHAT_PROVIDER_ENCRYPTION_KEY || "",
        codexBinary: env.CHAT_CODEX_BINARY || "codex",
        codexWorkDir: resolve(env.CHAT_CODEX_WORK_DIR || "/workspace"),
        turnTimeoutMs: Math.min(1800, Math.max(30, Number(env.CHAT_TURN_TIMEOUT_SECONDS || 1200))) * 1000,
        sessionSeconds: 3600,
        retentionDays: 30,
        maxConcurrentTurns: 3,
        contextBudget: {
            input: boundedInteger("CHAT_CONTEXT_INPUT_TOKENS", 12000, 4000, 64000),
            history: boundedInteger("CHAT_CONTEXT_HISTORY_TOKENS", 2000, 0, 16000),
            result: boundedInteger("CHAT_TOOL_RESULT_TOKENS", 4000, 500, 16000),
            session: boundedInteger("CHAT_CONTEXT_SESSION_TOKENS", 48000, 24000, 256000),
            turns: boundedInteger("CHAT_SESSION_MAX_TURNS", 8, 1, 40),
            idleMs: boundedInteger("CHAT_SESSION_IDLE_SECONDS", 1800, 60, 86400) * 1000,
        },
    };
    if (
        config.contextBudget.input + 8192 >= config.contextBudget.session ||
        config.contextBudget.history > config.contextBudget.input
    )
        throw new Error("Invalid chat context budget relationship");
    const oidcConfigured = Boolean(config.issuer || config.clientId || config.clientSecret);
    if (oidcConfigured && (!config.issuer.startsWith("https://") || !config.clientId || !config.clientSecret))
        throw new Error("Configure all OIDC client settings");
    if ((enabled || config.reviewEnabled || config.cdrEnabled) && !config.identityEnabled && !oidcConfigured)
        throw new Error("Chat or model review requires OIDC or explicitly enabled local identity");
    if (config.identityEnabled) {
        let localIssuer;
        try {
            localIssuer = new URL(config.localIssuer);
        } catch {
            throw new Error("Invalid local identity issuer");
        }
        if (
            !["https:", "http:"].includes(localIssuer.protocol) ||
            localIssuer.username ||
            localIssuer.password ||
            localIssuer.search ||
            localIssuer.hash ||
            (localIssuer.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(localIssuer.hostname))
        )
            throw new Error("Local identity issuer requires HTTPS");
        if (!/^[a-f0-9]{64}$/.test(config.identityEncryptionKey))
            throw new Error("Local identity requires a dedicated 32-byte hexadecimal encryption key");
    }
    if (enabled && !/^[a-f0-9]{64}$/.test(config.providerEncryptionKey))
        throw new Error("Chat requires a dedicated CHAT_PROVIDER_ENCRYPTION_KEY (32-byte hexadecimal key)");
    const mcp = new URL(config.mcpUrl);
    if (!["http:", "https:"].includes(mcp.protocol) || mcp.username || mcp.password || mcp.search || mcp.hash)
        throw new Error("Invalid CHAT_MCP_URL");
    if (!Number.isInteger(config.port) || !Number.isFinite(config.turnTimeoutMs))
        throw new Error("Invalid chat limits");
    if (
        (config.reviewEnabled || config.cdrEnabled) &&
        (!/^[a-f0-9]{64,128}$/.test(config.reviewSigningKey) ||
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(config.reviewKeyId))
    )
        throw new Error("Model review requires browser OIDC and a dedicated signing key");
    if (
        !Number.isInteger(config.reviewSessionSeconds) ||
        config.reviewSessionSeconds < 60 ||
        config.reviewSessionSeconds > 3600
    )
        throw new Error("Invalid review session maximum age");
    for (const claim of [config.reviewRolesClaim, config.reviewTenantClaim, config.reviewProjectScopesClaim])
        if (claim && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(claim)) throw new Error("Invalid review claim path");
    return Object.freeze(config);
}
