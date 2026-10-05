import { GLOBAL_IDENTITY, workspaceAccess, identityCanUseGlobal } from "./access.mjs";
import http from "node:http";
import QRCode from "qrcode";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Auth } from "./auth.mjs";
import { Store } from "./store.mjs";
import { McpClient, WRITE_TOOLS } from "./mcp.mjs";
import { Providers } from "./providers.mjs";
import { ReviewClient } from "./reviews.mjs";
import { CdrClient, CDR_OPERATIONS } from "./cdr.mjs";
import { readModels } from "./models.mjs";
import { PersonalConnections } from "./personal-connections.mjs";
import { Checkpoints } from "./checkpoints.mjs";
import { TemplatePackages } from "./template-packages.mjs";
import { RepositoryModels } from "./repository-models.mjs";
import { draftAql } from "./aql-drafting.mjs";
import { ModelCache } from "./model-cache.mjs";
import { Attachments, UPLOAD_LIMIT } from "./attachments.mjs";
import { Shares } from "./shares.mjs";
import { repositoryFolder } from "./repository-paths.mjs";
import { ProjectMoves, recordArtifact } from "./project-moves.mjs";
import { WorkspaceTools, PERSONAL_WRITE } from "./workspace-tools.mjs";
import { CHOICE_TOOL, choiceQuestion, choiceAnswer, choiceMessage } from "./choices.mjs";

const publicDir = fileURLToPath(new URL("../../public/chat/", import.meta.url));
const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
};
async function body(req, allowed, message = "Invalid request fields.", maximum = 32768) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
        throw Object.assign(new Error("Expected JSON"), { status: 415 });
    let size = 0,
        parts = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maximum) throw Object.assign(new Error("Message is too large"), { status: 413 });
        parts.push(chunk);
    }
    let input;
    try {
        input = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
        throw Object.assign(new Error("Invalid JSON"), { status: 400 });
    }
    if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        (allowed && Object.keys(input).some((key) => !allowed.includes(key)))
    )
        throw Object.assign(new Error(message), { status: 400 });
    return input;
}

// Serialize tool calls so each write confirmation identifies exactly one pending change.
function serialToolCalls(run) {
    let pending = Promise.resolve();
    return (...args) => {
        const result = pending.then(() => run(...args));
        pending = result.catch(() => {});
        return result;
    };
}

export function createApplication(
    config,
    {
        auth = new Auth(config),
        store = new Store(config.dataDir + "/conversations", config.retentionDays),
        provider = new Providers(config),
        mcpFactory = (signal) => new McpClient(config, signal),
        reviews = new ReviewClient(config),
        cdr = new CdrClient(config),
        connections = new PersonalConnections(config),
        attachments = new Attachments(store),
        shares = new Shares(store),
    } = {},
) {
    provider.canUseGlobal = (identity) => identityCanUseGlobal(auth.identityStore, identity);
    connections.canUseGlobal = provider.canUseGlobal;
    const active = new Map(),
        rate = new Map(),
        modelReads = new Map(),
        cdrRequests = new Map();
    const drafts = new Map();
    const cancelUserWork = (userId) => {
        const affectedIdentity = auth.identityStore?.issuer + "\n" + userId;
        for (const turn of active.values())
            if (turn.identity === affectedIdentity) turn.controller.abort("ACCESS_CHANGED");
        drafts.get(affectedIdentity)?.abort();
    };
    const uploading = new Set();
    const moving = new Set();
    const projectMoves = new ProjectMoves(store, connections, config.allowWrites);
    store.prune();
    shares.prune();
    TemplatePackages.prune(config);
    Checkpoints.prune(config);
    const modelCache = new ModelCache(config);
    try {
        modelCache.prune();
    } catch {
        /* Cache maintenance must not block startup. */
    }
    const cleanup = setInterval(() => {
        try {
            store.prune();
            shares.prune();
            TemplatePackages.prune(config);
            Checkpoints.prune(config);
            modelCache.prune();
        } catch {
            console.error('{"event":"chat_retention_failed"}');
        }
    }, 3600000);
    cleanup.unref();
    const server = http.createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        );
        const path = new URL(req.url, "http://local").pathname;
        try {
            if (req.method === "GET" && path === "/health")
                return json(res, 200, {
                    status: "alive",
                    enabled: config.enabled,
                    review_enabled: config.reviewEnabled,
                });
            if (
                (config.enabled || config.reviewEnabled || config.identityEnabled) &&
                req.headers.host !== new URL(config.origin).host
            )
                throw Object.assign(new Error("Unknown host"), { status: 421 });
            const assets = {
                "/": ["index.html", "text/html; charset=utf-8"],
                "/chat/": ["index.html", "text/html; charset=utf-8"],
                "/chat/workspace.js": ["workspace.js", "text/javascript"],
                "/chat/workspace.css": ["workspace.css", "text/css"],
                "/chat/app.js": ["app.js", "text/javascript"],
                "/chat/style.css": ["style.css", "text/css"],
                "/chat/reviews.js": ["reviews.js", "text/javascript"],
                "/chat/identity.js": ["identity.js", "text/javascript"],
                "/chat/aql.js": ["aql.js", "text/javascript"],
                "/chat/aql.css": ["aql.css", "text/css"],
            };
            if (req.method === "GET" && path === "/chat/reviews") {
                res.writeHead(302, { Location: "/chat/#governance" });
                return res.end();
            }
            if (req.method === "GET" && path === "/chat") {
                res.writeHead(302, { Location: "/chat/" });
                return res.end();
            }
            if (req.method === "GET" && assets[path]) {
                res.writeHead(200, { "Content-Type": assets[path][1] });
                return res.end(readFileSync(publicDir + assets[path][0]));
            }
            if (req.method === "GET" && path === "/chat/api/session") {
                const session = auth.session(req);
                return json(res, 200, {
                    enabled: config.enabled,
                    authenticated: !!session && !session.mfaSetupRequired,
                    user: session
                        ? {
                              name: session.name,
                              ...(session.user ? { id: session.user.id, roles: session.user.roles } : {}),
                          }
                        : null,
                    csrf: session?.csrf,
                    allowWrites: config.allowWrites,
                    reviewEnabled: config.reviewEnabled,
                    cdrEnabled: !!config.cdrEnabled,
                    identityEnabled: config.identityEnabled,
                    signupEnabled: config.signupEnabled !== false && !!auth.identityStore?.signupAvailable(),
                    access: workspaceAccess(auth.identityStore, session),
                    identitySetupRequired: config.identityEnabled && auth.identityStore.read().users.length === 0,
                    oidcEnabled: !!config.issuer,
                    mcpConnection: { url: config.origin + "/mcp", header: config.mcpKeyHeader },
                    mfaSetupRequired: !!session?.mfaSetupRequired,
                    ...(session?.mfaSetupRequired
                        ? { totpSecret: session.totpSecret, otpAuthUrl: session.otpAuthUrl }
                        : {}),
                    retentionDays: config.retentionDays,
                    providers:
                        session && !session.mfaSetupRequired && config.enabled
                            ? provider.status?.(session.identity) || [
                                  { id: "codex", name: "Codex", connected: true },
                                  { id: "claude", name: "Claude", connected: true },
                              ]
                            : [],
                });
            }
            if (!config.enabled && !config.reviewEnabled && !config.identityEnabled && !config.cdrEnabled)
                throw Object.assign(
                    new Error(
                        "Browser review is disabled. Configure CHAT_REVIEW_ENABLED=true and the browser OIDC client; CHAT_ENABLED and a model-provider account are only needed for conversational chat.",
                    ),
                    { status: 503 },
                );
            if (req.method === "POST" && path.startsWith("/chat/auth/") && req.headers.origin !== config.origin)
                throw Object.assign(new Error("Request could not be verified"), { status: 403 });
            if (req.method === "POST" && path === "/chat/auth/local") {
                const input = await body(
                    req,
                    ["username", "password", "otp", "recoveryCode"],
                    "Invalid sign-in request.",
                );
                const result = await auth.localLogin(input, req, res);
                return json(res, 200, result);
            }
            if (req.method === "POST" && path === "/chat/auth/signup") {
                const input = await body(req, ["username", "displayName", "password"], "Invalid registration.");
                return json(res, 201, auth.signup(input, req, res));
            }
            if (req.method === "POST" && path === "/chat/auth/bootstrap") {
                const input = await body(
                    req,
                    ["token", "username", "displayName", "password"],
                    "Invalid bootstrap request.",
                );
                return json(res, 201, auth.bootstrap(input, res));
            }
            if (req.method === "POST" && path === "/chat/auth/invitations/accept") {
                const input = await body(
                    req,
                    ["token", "username", "displayName", "password"],
                    "Invalid invitation request.",
                );
                return json(res, 201, auth.acceptInvite(input, res));
            }
            if (req.method === "GET" && path === "/chat/auth/mfa-qr") {
                const pending = auth.require(req, false, true);
                if (!pending.mfaSetupRequired || !pending.otpAuthUrl)
                    throw Object.assign(new Error("Authenticator setup is not pending."), { status: 403 });
                const png = await QRCode.toBuffer(pending.otpAuthUrl, {
                    type: "png",
                    width: 288,
                    margin: 4,
                    errorCorrectionLevel: "M",
                });
                // Enrollment or recovery may finish while the PNG is being generated.
                const current = auth.require(req, false, true);
                if (!current.mfaSetupRequired || current.otpAuthUrl !== pending.otpAuthUrl)
                    throw Object.assign(new Error("Authenticator setup is no longer pending."), { status: 403 });
                res.writeHead(200, {
                    "Content-Type": "image/png",
                    "Cross-Origin-Resource-Policy": "same-origin",
                });
                return res.end(png);
            }
            if (req.method === "POST" && path === "/chat/auth/mfa") {
                auth.require(req, true, true);
                const input = await body(req, ["code"], "Invalid MFA request.");
                return json(res, 200, auth.finishMfa(req, input));
            }
            if (req.method === "POST" && path === "/chat/auth/password-reset") {
                if (!auth.identityStore)
                    throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
                const input = await body(req, ["token", "password"], "Invalid password reset request.");
                auth.identityStore.resetPassword(input.token, input.password);
                return json(res, 200, { success: true });
            }
            if (req.method === "POST" && path === "/chat/auth/recovery-code") {
                const input = await body(req, ["username", "recoveryCode", "password"], "Invalid recovery request.");
                const result = auth.recoverWithCode(input, res);
                cancelUserWork(result.user.id);
                return json(res, 200, result);
            }
            if (req.method === "POST" && path === "/chat/auth/account-recovery") {
                const input = await body(req, ["token", "password"], "Invalid account recovery request.");
                const result = auth.completeAccountRecovery(input, res);
                cancelUserWork(result.user.id);
                return json(res, 200, result);
            }
            if (req.method === "GET" && path === "/chat/auth/login") return await auth.login(req, res);
            if (req.method === "GET" && path === "/chat/auth/callback") return await auth.callback(req, res);
            const mutation = req.method !== "GET";
            const session = auth.require(req, mutation);
            const identity = session.identity;
            if (req.method === "POST" && path === "/chat/auth/keepalive") {
                await body(req, []);
                return json(res, 200, auth.renew(req, res));
            }
            const access = workspaceAccess(auth.identityStore, session);
            const globalScope = new URL(req.url, config.origin).searchParams.get("scope") === "global";
            const connectionOwner = (permission, write = false) => {
                if (!globalScope) return identity;
                if (
                    !access.permissions.includes(permission) &&
                    (write || !access.permissions.includes("use-global-connections"))
                )
                    throw Object.assign(new Error("The platform owner must grant shared connection permission."), {
                        status: 403,
                    });
                return GLOBAL_IDENTITY;
            };
            const recordSharedChange = (kind, operation) => {
                if (globalScope)
                    auth.identityStore.mutate(
                        session.user.id,
                        "SHARED_CONNECTION_CHANGED",
                        { kind, operation },
                        () => {},
                    );
            };
            const checkMoving = () => {
                if (moving.has(identity))
                    throw Object.assign(new Error("Wait for the project move to finish."), { status: 409 });
            };
            if (mutation) checkMoving();
            if (req.method === "POST" && path === "/chat/auth/logout") {
                for (const [key, turn] of active)
                    if (key.startsWith(store.owner(identity) + ":")) turn.controller.abort();
                provider.cancelLogin?.(identity);
                drafts.get(identity)?.abort();
                auth.logout(req, res);
                return json(res, 200, { success: true });
            }
            if (path.startsWith("/chat/api/identity/")) {
                const store = auth.identityStore;
                if (!store) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
                const actor = session.user?.id;
                if (!actor)
                    throw Object.assign(new Error("A native administrator account is required."), { status: 403 });
                if (req.method === "PUT" && path === "/chat/api/identity/signup") {
                    const input = await body(req, ["enabled"]);
                    return json(res, 200, store.setSignup(actor, input.enabled));
                }
                const permissionsRoute = path.match(/^\/chat\/api\/identity\/users\/([a-f0-9-]{36})\/permissions$/);
                if (permissionsRoute && req.method === "PUT") {
                    const input = await body(req, ["permissions"]);
                    const user = store.setPermissions(actor, permissionsRoute[1], input.permissions);
                    cancelUserWork(user.id);
                    return json(res, 200, { user });
                }
                if (req.method === "GET" && path === "/chat/api/identity/users")
                    return json(res, 200, store.listUsers(actor));
                if (req.method === "GET" && path === "/chat/api/identity/audit")
                    return json(res, 200, store.listUsers(actor).audit);
                if (req.method === "POST" && path === "/chat/api/identity/mcp-connection") {
                    await body(req, []);
                    store.listUsers(actor);
                    if (!config.mcpKey)
                        throw Object.assign(
                            new Error("The workspace administrator must configure a modelling connection key."),
                            { status: 503 },
                        );
                    store.recordMcpConnectionAccess(actor);
                    return json(res, 200, { key: config.mcpKey });
                }
                if (req.method === "POST" && path === "/chat/api/identity/invitations") {
                    const input = await body(req, ["email", "roles", "expiresSeconds"], "Invalid invitation request.");
                    return json(res, 201, store.invite(actor, input.email, input.roles, input.expiresSeconds));
                }
                const userRoute = path.match(
                    /^\/chat\/api\/identity\/users\/([a-f0-9-]{36})\/(roles|disable|reset|sessions)$/,
                );
                if (userRoute) {
                    const [, userId, action] = userRoute;
                    if (action === "roles" && req.method === "PUT") {
                        const input = await body(req, ["roles"], "Invalid role assignment.");
                        const user = store.setRoles(actor, userId, input.roles);
                        cancelUserWork(userId);
                        return json(res, 200, { user });
                    }
                    if (action === "disable" && req.method === "POST") {
                        const user = store.disableUser(actor, userId);
                        cancelUserWork(userId);
                        return json(res, 200, { user });
                    }
                    if (action === "reset" && req.method === "POST")
                        return json(res, 201, store.inviteReset(actor, userId));
                    if (action === "sessions" && req.method === "DELETE") {
                        const success = store.revokeUserSessions(actor, userId);
                        cancelUserWork(userId);
                        return json(res, 200, { success });
                    }
                }
                if (req.method === "POST" && path === "/chat/api/identity/service-accounts") {
                    const input = await body(req, ["name", "scopes"], "Invalid service account request.");
                    return json(res, 201, store.issueServiceAccount(actor, input.name, input.scopes));
                }
                const recoveryRoute = path.match(/^\/chat\/api\/identity\/users\/([a-f0-9-]{36})\/recovery$/);
                if (recoveryRoute && req.method === "POST")
                    return json(res, 201, store.issueAccountRecovery(actor, recoveryRoute[1]));
                const serviceRoute = path.match(/^\/chat\/api\/identity\/service-accounts\/([a-f0-9-]{36})$/);
                if (serviceRoute && req.method === "DELETE")
                    return json(res, 200, { success: store.revokeServiceAccount(actor, serviceRoute[1]) });
                throw Object.assign(new Error("Not found."), { status: 404 });
            }
            if (path.startsWith("/chat/api/cdr/")) {
                const operation = path.slice("/chat/api/cdr/".length);
                if (req.method !== "POST" || !CDR_OPERATIONS.has(operation) || new URL(req.url, config.origin).search)
                    throw Object.assign(new Error("Unknown CDR operation."), { status: 404 });
                const input = await body(req, undefined, "Invalid CDR request.", 16777216);
                // Cancellation retains capacity even while query workers are busy.
                if (operation === "cancel") return json(res, 200, await cdr.request(session, operation, input));
                const count = cdrRequests.get(identity) || 0;
                if (count >= 2 || [...cdrRequests.values()].reduce((sum, n) => sum + n, 0) >= 12)
                    throw Object.assign(new Error("CDR requests are busy. Cancel a running query or retry shortly."), {
                        status: 429,
                    });
                cdrRequests.set(identity, count + 1);
                try {
                    return json(res, 200, await cdr.request(session, operation, input));
                } finally {
                    const remaining = (cdrRequests.get(identity) || 1) - 1;
                    if (remaining) cdrRequests.set(identity, remaining);
                    else cdrRequests.delete(identity);
                }
            }
            if (path === "/chat/api/aql-draft") {
                if (req.method !== "POST")
                    throw Object.assign(new Error("Use the AQL drafting button."), { status: 405 });
                if (!config.enabled || !config.cdrEnabled)
                    throw Object.assign(new Error("AQL drafting is not configured."), { status: 503 });
                if (drafts.has(identity) || drafts.size + active.size >= config.maxConcurrentTurns)
                    throw Object.assign(new Error("An assistant is busy. Please retry shortly."), { status: 429 });
                const now = Date.now(),
                    recent = (rate.get(identity) || []).filter((time) => now - time < 60000);
                if (recent.length >= 10)
                    throw Object.assign(new Error("Please wait before drafting another query."), { status: 429 });
                rate.set(identity, [...recent, now]);
                const input = await body(
                    req,
                    ["provider", "intent", "model", "paths"],
                    "Only modelling input is accepted for AQL drafting.",
                    4194304,
                );
                if (drafts.has(identity) || drafts.size + active.size >= config.maxConcurrentTurns)
                    throw Object.assign(new Error("An assistant is busy. Please retry shortly."), { status: 429 });
                const controller = new AbortController();
                controller.provider = input.provider;
                controller.credentialIdentity = provider.credentialIdentity?.(identity, input.provider) || identity;
                const closed = () => controller.abort();
                res.once("close", closed);
                drafts.set(identity, controller);
                try {
                    return json(
                        res,
                        200,
                        await draftAql({
                            input,
                            identity,
                            session,
                            provider,
                            cdr,
                            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
                        }),
                    );
                } finally {
                    controller.abort();
                    res.off("close", closed);
                    drafts.delete(identity);
                }
            }
            if (path.startsWith("/chat/api/aql-repository/")) {
                if (req.method !== "POST") throw Object.assign(new Error("Read-only model access."), { status: 405 });
                const operation = path.slice("/chat/api/aql-repository/".length);
                if (!["list", "get", "package"].includes(operation))
                    throw Object.assign(new Error("Not found."), { status: 404 });
                const input = await body(req, ["repository", "path", "ref"]);
                const count = modelReads.get(identity) || 0;
                if (count >= 2 || [...modelReads.values()].reduce((a, b) => a + b, 0) >= 16)
                    throw Object.assign(new Error("Repository requests are busy. Please retry shortly."), {
                        status: 429,
                    });
                modelReads.set(identity, count + 1);
                const controller = new AbortController();
                const closed = () => controller.abort();
                res.once("close", closed);
                const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
                try {
                    const models = new RepositoryModels(connections, identity, signal);
                    return json(res, 200, await models[operation](input));
                } finally {
                    controller.abort();
                    res.off("close", closed);
                    const remaining = (modelReads.get(identity) || 1) - 1;
                    if (remaining) modelReads.set(identity, remaining);
                    else modelReads.delete(identity);
                }
            }
            if (path === "/chat/api/reviews" || path.startsWith("/chat/api/reviews/")) {
                if (!config.reviewEnabled)
                    throw Object.assign(new Error("Model review is not configured."), { status: 503 });
                const url = new URL(req.url, config.origin);
                const suffix = path.slice("/chat/api/reviews".length);
                if (req.method === "GET" && suffix === "") {
                    const project = url.searchParams.get("project"),
                        offset = url.searchParams.get("offset") || "0";
                    if (
                        !project ||
                        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(project) ||
                        [...url.searchParams.keys()].some((key) => !["project", "offset"].includes(key)) ||
                        url.searchParams.getAll("project").length !== 1 ||
                        url.searchParams.getAll("offset").length > 1 ||
                        !/^\d{1,5}$/.test(offset) ||
                        Number(offset) > 10000
                    )
                        throw Object.assign(new Error("Choose a project."), { status: 400 });
                    return json(
                        res,
                        200,
                        await reviews.request(
                            session,
                            "GET",
                            "/api/v1/reviews?project=" + encodeURIComponent(project) + "&offset=" + Number(offset),
                        ),
                    );
                }
                if (/^\/[a-f0-9]{64}$/.test(suffix) && req.method === "GET" && !url.search)
                    return json(res, 200, await reviews.request(session, "GET", "/api/v1/reviews" + suffix));
                if (/^\/[a-f0-9]{64}\/transitions$/.test(suffix) && req.method === "POST" && !url.search) {
                    const input = await body(req);
                    if (
                        !input ||
                        typeof input !== "object" ||
                        Array.isArray(input) ||
                        Object.keys(input).some(
                            (key) => !["state", "expectedSequence", "comment", "validationDigest"].includes(key),
                        ) ||
                        typeof input.state !== "string" ||
                        !Number.isSafeInteger(input.expectedSequence) ||
                        input.expectedSequence < 1 ||
                        typeof input.comment !== "string" ||
                        !input.comment.trim() ||
                        input.comment.length > 4000
                    )
                        throw Object.assign(new Error("Review the decision and enter a comment."), { status: 400 });
                    return json(res, 200, await reviews.request(session, "POST", "/api/v1/reviews" + suffix, input));
                }
                throw Object.assign(new Error("Not found"), { status: 404 });
            }
            if (path.startsWith("/chat/api/models/")) {
                if (req.method !== "GET")
                    throw Object.assign(new Error("Model browsing is read-only."), { status: 403 });
                const count = modelReads.get(identity) || 0;
                if (count >= 2 || [...modelReads.values()].reduce((a, b) => a + b, 0) >= 16)
                    throw Object.assign(new Error("Repository requests are busy. Please retry shortly."), {
                        status: 429,
                    });
                modelReads.set(identity, count + 1);
                const controller = new AbortController();
                const deadline = setTimeout(() => controller.abort(), 20000);
                const client = mcpFactory(controller.signal);
                try {
                    return json(res, 200, await readModels(client, req.url));
                } finally {
                    clearTimeout(deadline);
                    await client.close?.();
                    const remaining = (modelReads.get(identity) || 1) - 1;
                    if (remaining) modelReads.set(identity, remaining);
                    else modelReads.delete(identity);
                }
            }
            if (!config.enabled)
                throw Object.assign(new Error("Browser chat is not configured on this deployment."), { status: 503 });
            if (path === "/chat/api/connections") {
                if (!["GET", "POST"].includes(req.method)) throw Object.assign(new Error("Not found"), { status: 404 });
                const input =
                    req.method === "POST" ? await body(req, ["kind", "label", "url", "token", "branch"]) : null;
                const mcp = mcpFactory(AbortSignal.timeout(20000));
                try {
                    let enterprise = [],
                        enterpriseUnavailable = false;
                    try {
                        enterprise = await connections.enterprise(mcp);
                    } catch (error) {
                        if (input?.kind === "ckm") throw error;
                        enterpriseUnavailable = true;
                    }
                    if (input) {
                        checkMoving();
                        const result = connections.add(
                            connectionOwner("manage-global-repositories", true),
                            input,
                            enterprise,
                        );
                        recordSharedChange(input.kind, "save");
                        return json(res, 200, result);
                    }
                    return json(res, 200, {
                        enterprise,
                        personal: connections.list(connectionOwner("manage-global-repositories")),
                        managed:
                            !globalScope &&
                            access.permissions.includes("manage-global-repositories") &&
                            !access.permissions.includes("use-global-connections")
                                ? connections.list(GLOBAL_IDENTITY).map((item) => ({ ...item, scope: "global" }))
                                : [],
                        enterpriseUnavailable,
                    });
                } finally {
                    await mcp.close?.();
                }
            }
            const personalRoute = path.match(/^\/chat\/api\/connections\/([a-f0-9-]{36})$/);
            if (personalRoute && req.method === "DELETE") {
                connections.remove(connectionOwner("manage-global-repositories", true), personalRoute[1]);
                recordSharedChange("source_or_repository", "delete");
                return json(res, 200, { success: true });
            }
            const sharedRoute = path.match(/^\/chat\/api\/shares\/([A-Za-z0-9_-]{43})$/);
            if (sharedRoute && req.method === "GET") return json(res, 200, shares.get(sharedRoute[1]));
            if (path === "/chat/api/providers" && req.method === "GET")
                return json(res, 200, { providers: provider.status(connectionOwner("manage-global-providers")) });
            if (path === "/chat/api/providers/copilot/test" && req.method === "POST") {
                await body(req, []);
                if (drafts.has(identity) || active.size + drafts.size >= config.maxConcurrentTurns)
                    throw Object.assign(new Error("The assistant is busy. Please retry shortly."), { status: 429 });
                provider.assertConnected(connectionOwner("manage-global-providers"), "copilot");
                const controller = new AbortController();
                controller.provider = "copilot";
                controller.credentialIdentity =
                    provider.credentialIdentity?.(connectionOwner("manage-global-providers"), "copilot") ||
                    connectionOwner("manage-global-providers");
                const timer = setTimeout(() => controller.abort(), 60000);
                const disconnected = () => {
                    if (!res.writableEnded) controller.abort();
                };
                res.on("close", disconnected);
                drafts.set(identity, controller);
                let verified = false;
                try {
                    await provider.run({
                        identity: connectionOwner("manage-global-providers"),
                        provider: "copilot",
                        signal: controller.signal,
                        instructions:
                            "This is a synthetic workspace connection test. Use the OpenEhrWorkspace client tool to describe and call workspace_connection_check with empty argumentsJson {}. Then confirm the returned result. Do not use external tools or fabricate a successful test.",
                        messages: [{ role: "user", content: "Test the workspace connection now." }],
                        tools: [
                            {
                                name: "workspace_connection_check",
                                description:
                                    "Read-only synthetic connection check. No files, repositories or patient data.",
                                inputSchema: { type: "object", properties: {}, additionalProperties: false },
                            },
                        ],
                        callTool: async (name, args) => {
                            controller.signal.throwIfAborted();
                            if (name !== "workspace_connection_check" || !args || Object.keys(args).length)
                                throw new Error("Unavailable test tool");
                            verified = true;
                            return { connected: true, patientDataAccess: false };
                        },
                        onEvent() {},
                    });
                    if (!verified)
                        throw Object.assign(
                            new Error(
                                "Agent access works, but its OpenEhrWorkspace client tool was not called. Follow Help → Copilot Studio browser setup, publish the agent, then test again.",
                            ),
                            { status: 409 },
                        );
                    return json(res, 200, {
                        verified: true,
                        message: "Published agent and workspace tools verified. No patient data was accessed.",
                    });
                } finally {
                    clearTimeout(timer);
                    res.off("close", disconnected);
                    drafts.delete(identity);
                }
            }
            const connection = path.match(/^\/chat\/api\/providers\/(codex|claude|copilot)$/);
            if (connection) {
                const name = connection[1];
                const owner = connectionOwner("manage-global-providers", true);
                if (req.method === "DELETE") {
                    for (const [key, turn] of active)
                        if (
                            (owner === GLOBAL_IDENTITY
                                ? turn.credentialIdentity === GLOBAL_IDENTITY
                                : key.startsWith(store.owner(identity) + ":")) &&
                            turn.provider === name
                        )
                            turn.controller.abort();
                    if (owner === GLOBAL_IDENTITY)
                        for (const draft of drafts.values())
                            if (draft.credentialIdentity === GLOBAL_IDENTITY && draft.provider === name)
                                draft.abort("ACCESS_CHANGED");
                    provider.disconnect(owner, name);
                    recordSharedChange(name, "disconnect");
                    drafts.get(identity)?.abort();
                    return json(res, 200, { success: true });
                }
                if (req.method === "POST" && name === "codex") {
                    const input = await body(req, globalScope ? ["apiKey"] : []);
                    if (globalScope) {
                        provider.connectCodexKey(owner, input.apiKey);
                        recordSharedChange(name, "connect");
                        return json(res, 200, { success: true });
                    }
                    return json(res, 200, await provider.startLogin(owner));
                }
                if (req.method === "POST" && name === "claude") {
                    const input = await body(req, ["apiKey"]);
                    provider.connectClaude(owner, input.apiKey);
                    recordSharedChange(name, "connect");
                    return json(res, 200, { success: true });
                }
                if (req.method === "POST" && name === "copilot") {
                    const input = await body(req, ["tenantId", "clientId", "environmentId", "schemaName"]);
                    const result = await provider.copilot.start(owner, input);
                    recordSharedChange(name, "sign_in_started");
                    return json(res, 200, result);
                }
                throw Object.assign(new Error("Not found"), { status: 404 });
            }
            if (path === "/chat/api/projects") {
                if (req.method === "GET") return json(res, 200, { projects: store.projects(identity) });
                if (req.method === "POST") {
                    const input = await body(req, ["name", "repository", "folder"]);
                    checkMoving();
                    if (
                        input.repository !== undefined &&
                        input.repository !== null &&
                        connections.get(identity, input.repository).kind === "ckm"
                    )
                        throw Object.assign(new Error("Choose a repository."), { status: 400 });
                    return json(res, 201, store.saveProject(identity, input.name, null, input));
                }
            }
            const projectRoute = path.match(/^\/chat\/api\/projects\/([a-f0-9-]{36})$/);
            if (projectRoute) {
                const id = projectRoute[1];
                store.project(identity, id);
                const checkPendingMoves = () => {
                    if (
                        store.list(identity).some((item) => {
                            const chat = store.get(identity, item.id);
                            return chat.movePlan?.commit && (chat.movePlan.project === id || chat.project === id);
                        })
                    )
                        throw Object.assign(
                            new Error("Finish the pending artefact move before changing this project."),
                            { status: 409 },
                        );
                };
                if (req.method === "PUT") {
                    const input = await body(req, ["name", "repository", "folder"]);
                    checkMoving();
                    checkPendingMoves();
                    if (
                        input.repository !== undefined &&
                        input.repository !== null &&
                        connections.get(identity, input.repository).kind === "ckm"
                    )
                        throw Object.assign(new Error("Choose a repository."), { status: 400 });
                    return json(res, 200, store.saveProject(identity, input.name, id, input));
                }
                if (req.method === "DELETE") {
                    checkPendingMoves();
                    const owner = store.owner(identity) + ":";
                    if ([...active.keys(), ...uploading].some((key) => key.startsWith(owner)))
                        throw Object.assign(
                            new Error("Finish active responses and uploads before removing a project."),
                            { status: 409 },
                        );
                    store.deleteProject(identity, id);
                    return json(res, 200, { success: true });
                }
            }
            if (path === "/chat/api/conversations") {
                if (req.method === "GET")
                    return json(res, 200, {
                        conversations: store.list(identity),
                        projects: store.projects(identity),
                        destination: store.destination(identity),
                    });
                if (req.method === "POST") {
                    const input =
                        (req.headers["content-length"] && req.headers["content-length"] !== "0") ||
                        req.headers["transfer-encoding"]
                            ? await body(req, ["provider", "repository", "project", "folder"])
                            : {};
                    const selected = input.provider || "codex";
                    if (!["codex", "claude", "copilot"].includes(selected))
                        throw Object.assign(new Error("Choose a provider."), { status: 400 });
                    const defaults = store.destination(identity, input.project ?? null);
                    checkMoving();
                    const repository = input.repository !== undefined ? input.repository : defaults.repository;
                    if (repository !== null && connections.get(identity, repository).kind === "ckm")
                        throw Object.assign(new Error("Choose a repository."), { status: 400 });
                    const created = store.create(identity, selected, repository, input.project ?? null, input.folder);
                    if (Object.hasOwn(input, "repository") || Object.hasOwn(input, "folder"))
                        store.saveDestination(identity, repository, created.folder, created.project || null);
                    return json(res, 201, created);
                }
            }
            const route = path.match(
                /^\/chat\/api\/conversations\/([a-f0-9-]{36})(?:\/(messages|stop|approval|choice|settings|share|attachments|drafts|move-preview|move)(?:\/([a-f0-9-]{36}))?(?:\/(preview))?)?$/,
            );
            if (!route) throw Object.assign(new Error("Not found"), { status: 404 });
            const [, id, action, attachmentId, preview] = route,
                key = store.owner(identity) + ":" + id;
            let conversation = store.get(identity, id);
            if (mutation && conversation.movePlan?.commit && !["move", "move-preview"].includes(action))
                throw Object.assign(new Error("Finish the pending project move before changing this conversation."), {
                    status: 409,
                });
            const freshConversation = () => {
                checkMoving();
                if (uploading.has(key) || active.has(key))
                    throw Object.assign(new Error("Wait for the current upload or response to finish."), {
                        status: 409,
                    });
                return store.get(identity, id);
            };
            if (attachmentId && !["attachments", "drafts"].includes(action))
                throw Object.assign(new Error("Not found"), { status: 404 });
            if (preview && (!attachmentId || action !== "attachments" || req.method !== "GET"))
                throw Object.assign(new Error("Not found"), { status: 404 });
            if (mutation && uploading.has(key))
                throw Object.assign(new Error("Wait for the file upload to finish."), { status: 409 });
            if (
                ["settings", "share", "attachments", "move-preview", "move"].includes(action) &&
                mutation &&
                active.has(key)
            )
                throw Object.assign(new Error("Stop the response before changing this conversation."), { status: 409 });
            if (["move-preview", "move"].includes(action) && req.method === "POST") {
                const input = await body(req, action === "move-preview" ? ["project", "paths"] : ["id"]);
                conversation = freshConversation();
                const owner = store.owner(identity) + ":";
                if ([...active.keys(), ...uploading].some((item) => item.startsWith(owner)))
                    throw Object.assign(new Error("Finish active responses and uploads before moving artefacts."), {
                        status: 409,
                    });
                moving.add(identity);
                try {
                    if (action === "move" && conversation.lastMove?.id === input.id)
                        return json(res, 200, conversation);
                    return json(
                        res,
                        200,
                        action === "move-preview"
                            ? await projectMoves.preview(identity, conversation, input.project, input.paths)
                            : await projectMoves.apply(identity, conversation, input.id),
                    );
                } finally {
                    moving.delete(identity);
                }
            }
            if (action === "settings" && req.method === "PUT") {
                const input = await body(req, ["repository", "project", "folder"]);
                if (!Object.keys(input).length)
                    throw Object.assign(new Error("Choose a repository or chat project."), { status: 400 });
                conversation = freshConversation();
                if (Object.hasOwn(input, "repository") && input.repository !== null) {
                    const selected = connections.get(identity, input.repository);
                    if (selected.kind === "ckm")
                        throw Object.assign(new Error("Choose a repository."), { status: 400 });
                }
                if (Object.hasOwn(input, "project") && input.project !== null) {
                    const project = store.project(identity, input.project);
                    if (
                        conversation.artifacts?.length ||
                        conversation.messages.some((message) =>
                            (message.tools || []).some(
                                (tool) => tool.name === PERSONAL_WRITE && tool.status === "completed",
                            ),
                        )
                    )
                        throw Object.assign(new Error("Preview the chat move to include its saved artefacts."), {
                            status: 409,
                        });
                    if (project.repository && connections.get(identity, project.repository).kind === "ckm")
                        throw Object.assign(new Error("Choose a repository in project settings."), { status: 400 });
                    input.repository = project.repository;
                    input.folder = project.folder;
                }
                if (Object.hasOwn(input, "folder")) input.folder = repositoryFolder(input.folder);
                if (Object.hasOwn(input, "repository")) conversation.repository = input.repository;
                if (Object.hasOwn(input, "folder")) conversation.folder = input.folder;
                if (Object.hasOwn(input, "project")) conversation.project = input.project;
                if (Object.hasOwn(input, "repository") || Object.hasOwn(input, "folder"))
                    store.saveDestination(
                        identity,
                        conversation.repository || null,
                        conversation.folder || "",
                        conversation.project || null,
                    );
                store.save(identity, conversation);
                return json(res, 200, conversation);
            }
            if (action === "share") {
                if (req.method === "POST") {
                    await body(req, []);
                    conversation = freshConversation();
                    return json(res, 201, shares.create(identity, conversation));
                }
                if (req.method === "DELETE") {
                    shares.revoke(identity, conversation);
                    return json(res, 200, { success: true });
                }
            }
            if (action === "drafts" && attachmentId && req.method === "GET") {
                const draft = new Checkpoints(config, identity, id).getDraft(attachmentId);
                const filename =
                    draft.name
                        .split("/")
                        .at(-1)
                        .replace(/[^A-Za-z0-9._-]/g, "_") || "draft.txt";
                res.writeHead(200, {
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": "attachment; filename=" + JSON.stringify(filename),
                });
                return res.end(draft.content);
            }
            if (action === "attachments") {
                if (attachmentId && req.method === "GET") {
                    if (preview) {
                        const bytes = attachments.preview(identity, conversation, attachmentId);
                        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": bytes.length });
                        return res.end(bytes);
                    }
                    const item = attachments.get(conversation, attachmentId);
                    res.writeHead(200, {
                        "Content-Type": "application/octet-stream",
                        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
                    });
                    return res.end(attachments.bytes(identity, conversation, attachmentId));
                }
                if (attachmentId && req.method === "DELETE") {
                    attachments.remove(identity, conversation, attachmentId);
                    return json(res, 200, { attachments: conversation.attachments });
                }
                if (!attachmentId && req.method === "POST") {
                    if (uploading.size >= 3)
                        throw Object.assign(new Error("File extraction is busy. Please retry shortly."), {
                            status: 429,
                        });
                    uploading.add(key);
                    try {
                        let size = 0;
                        const chunks = [];
                        for await (const chunk of req) {
                            size += chunk.length;
                            if (size > UPLOAD_LIMIT)
                                throw Object.assign(new Error("Files must be no larger than 10 MiB."), { status: 413 });
                            chunks.push(chunk);
                        }
                        let name;
                        try {
                            name = decodeURIComponent(req.headers["x-file-name"] || "");
                        } catch {
                            throw Object.assign(new Error("Invalid filename."), { status: 400 });
                        }
                        return json(
                            res,
                            201,
                            await attachments.add(identity, conversation, name, Buffer.concat(chunks)),
                        );
                    } finally {
                        uploading.delete(key);
                    }
                }
            }
            if (!action && req.method === "GET") {
                if (conversation.run?.status === "running" && !active.has(key)) {
                    conversation.run.status = "interrupted";
                    conversation.run.reason = "SERVER_RESTART";
                    const reply = conversation.messages.find((message) => message.id === conversation.run.messageId);
                    if (reply) {
                        reply.error = true;
                        reply.content +=
                            "\n\nThe server restarted. Continue from saved progress to reuse retained drafts and completed modelling evidence.";
                        for (const tool of reply.tools || [])
                            if (tool.status === "running") tool.status = "interrupted";
                    }
                    store.save(identity, conversation);
                }
                const turn = active.get(key);
                return json(res, 200, {
                    ...conversation,
                    running: !!turn,
                    pending: turn?.pending || null,
                    recovery: new Checkpoints(config, identity, id).summary(),
                });
            }
            if (!action && req.method === "DELETE") {
                if (active.has(key))
                    throw Object.assign(new Error("Stop the response before deleting this chat."), { status: 409 });
                shares.revoke(identity, conversation);
                store.delete(identity, id);
                new TemplatePackages(config, identity, id).delete();
                new Checkpoints(config, identity, id).delete();
                return json(res, 200, { success: true });
            }
            if (action === "stop" && req.method === "POST") {
                active.get(key)?.controller.abort("USER_STOP");
                return json(res, 200, { success: true });
            }
            if (action === "approval" && req.method === "POST") {
                const input = await body(req),
                    turn = active.get(key);
                if (!turn?.approval || turn.approval.id !== input.id || typeof input.approved !== "boolean")
                    throw Object.assign(new Error("This request is no longer awaiting confirmation."), { status: 409 });
                turn.approval.resolve(input.approved);
                turn.approval = null;
                return json(res, 200, { success: true });
            }
            if (action === "choice" && req.method === "POST") {
                const input = await body(req),
                    pending = active.get(key)?.choice;
                if (!pending || pending.id !== input.id)
                    throw Object.assign(new Error("This question is no longer awaiting an answer."), { status: 409 });
                pending.resolve(choiceAnswer(pending.question, input));
                return json(res, 200, { success: true });
            }
            if (action !== "messages" || req.method !== "POST")
                throw Object.assign(new Error("Not found"), { status: 404 });
            const input = await body(req);
            if (
                typeof input.content !== "string" ||
                !input.content.trim() ||
                input.content.length > 8000 ||
                Object.keys(input).some((k) => !["content", "repository", "folder"].includes(k)) ||
                (Object.hasOwn(input, "repository") &&
                    input.repository !== null &&
                    typeof input.repository !== "string")
            )
                throw Object.assign(new Error("Enter a message of up to 8,000 characters."), { status: 400 });
            conversation = freshConversation();
            if (Object.hasOwn(input, "repository") && input.repository !== (conversation.repository || null))
                throw Object.assign(
                    new Error("The repository choice changed. Check Save artifacts to, then send your message again."),
                    { status: 409 },
                );
            if (Object.hasOwn(input, "folder") && input.folder !== (conversation.folder || ""))
                throw Object.assign(
                    new Error("The repository folder changed. Review the destination, then send your message again."),
                    { status: 409 },
                );
            provider.assertConnected?.(identity, conversation.provider || "codex");
            if (active.has(key)) throw Object.assign(new Error("A response is already running."), { status: 409 });
            if (active.size + drafts.size >= config.maxConcurrentTurns)
                throw Object.assign(new Error("The assistant is busy. Please try again shortly."), { status: 429 });
            if (conversation.messages.length >= 80)
                throw Object.assign(new Error("Start a new conversation to continue."), { status: 429 });
            const recent = (rate.get(identity) || []).filter((t) => Date.now() - t < 60000);
            if (recent.length >= 10)
                throw Object.assign(new Error("Please wait before sending another message."), { status: 429 });
            recent.push(Date.now());
            rate.set(identity, recent);
            for (const [user, times] of rate) if (Date.now() - times.at(-1) > 60000) rate.delete(user);
            const usedAttachments = new Set(
                conversation.messages.flatMap((message) => (message.attachments || []).map((item) => item.id)),
            );
            const newAttachments = (conversation.attachments || []).filter((item) => !usedAttachments.has(item.id));
            conversation.messages.push({
                role: "user",
                content: input.content.trim(),
                ...(newAttachments.length ? { attachments: newAttachments } : {}),
            });
            if (conversation.messages.length === 1) conversation.title = input.content.trim().slice(0, 70);
            store.save(identity, conversation);
            const controller = new AbortController(),
                turn = {
                    controller,
                    identity,
                    approval: null,
                    provider: conversation.provider || "codex",
                    credentialIdentity:
                        provider.credentialIdentity?.(identity, conversation.provider || "codex") || identity,
                };
            active.set(key, turn);
            // A response belongs to its conversation, not to one browser socket.
            // Human confirmation time does not consume the model's work budget.
            let remaining = config.turnTimeoutMs,
                started = Date.now(),
                timeout;
            const resumeBudget = () => {
                if (controller.signal.aborted || timeout) return;
                started = Date.now();
                timeout = setTimeout(() => controller.abort("TIME_LIMIT"), Math.max(1, remaining));
                timeout.unref();
            };
            const pauseBudget = () => {
                if (!timeout) return;
                remaining -= Date.now() - started;
                clearTimeout(timeout);
                timeout = null;
            };
            resumeBudget();
            const reply = { id: randomUUID(), role: "assistant", content: "", tools: [] };
            conversation.messages.push(reply);
            conversation.run = { status: "running", messageId: reply.id, startedAt: new Date().toISOString() };
            store.save(identity, conversation);
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
                Connection: "keep-alive",
            });
            res.flushHeaders();
            const checkpoint = () => {
                reply.content = content;
                conversation.run.updatedAt = new Date().toISOString();
                store.save(identity, conversation);
            };
            const emit = (event) => {
                if (event.type === "approval" || event.type === "choice") turn.pending = event;
                if (event.type !== "delta") checkpoint();
                if (!res.destroyed) res.write("data: " + JSON.stringify(event) + "\n\n");
            };
            const heartbeat = setInterval(() => {
                if (!res.destroyed) res.write(": keepalive\n\n");
            }, 15000);
            heartbeat.unref();
            let mcp;
            let content = "",
                toolCount = 0,
                toolActivity = reply.tools;
            const snapshot = setInterval(() => {
                try {
                    checkpoint();
                } catch {
                    controller.abort("CHECKPOINT_FAILED");
                }
            }, 2000);
            snapshot.unref();
            try {
                emit({ type: "status", text: "Connecting to modelling tools…" });
                mcp = mcpFactory(controller.signal);
                const workspace = new WorkspaceTools(
                    mcp,
                    connections,
                    attachments,
                    identity,
                    conversation,
                    controller.signal,
                    config.allowWrites,
                    config.cdrEnabled ? { client: cdr, session } : null,
                );
                const tools = await workspace.tools(),
                    names = new Set(tools.map((t) => t.name));
                const result = await provider.run({
                    identity,
                    provider: turn.provider,
                    messages: workspace.context(conversation.messages.filter((message) => message !== reply)),
                    images: attachments.images(identity, conversation),
                    tools,
                    signal: controller.signal,
                    onEvent: (event) => {
                        if (event.type === "delta") content += event.text;
                        emit(event);
                    },
                    callTool: serialToolCalls(async (name, args) => {
                        if (++toolCount > 64) controller.abort("TOOL_LIMIT");
                        controller.signal.throwIfAborted();
                        if (!names.has(name)) throw new Error("Tool is unavailable");
                        const trace = { id: randomUUID(), name, status: "running" };
                        toolActivity.push(trace);
                        emit({ type: "tool", ...trace });
                        try {
                            if (name === CHOICE_TOOL.name) {
                                const question = choiceQuestion(args);
                                if (conversation.messages.length >= 79)
                                    throw new Error("Start a new conversation for more questions.");
                                pauseBudget();
                                const answer = await new Promise((resolve, reject) => {
                                    const choiceId = randomUUID();
                                    let timer,
                                        settled = false;
                                    const finish = (value) => {
                                        if (settled) return;
                                        settled = true;
                                        clearTimeout(timer);
                                        controller.signal.removeEventListener("abort", cancel);
                                        turn.choice = null;
                                        turn.pending = null;
                                        resumeBudget();
                                        try {
                                            if (!value.cancelled) {
                                                conversation.messages.splice(conversation.messages.indexOf(reply), 0, {
                                                    role: "user",
                                                    content: choiceMessage(value),
                                                });
                                                store.save(identity, conversation);
                                            }
                                            emit({ type: "choice_result", id: choiceId, answer: value });
                                            resolve(value);
                                        } catch (error) {
                                            reject(error);
                                        }
                                    };
                                    const cancel = () =>
                                        finish({ ...question, selected: [], text: "", cancelled: true });
                                    timer = setTimeout(cancel, 120000);
                                    timer.unref();
                                    controller.signal.addEventListener("abort", cancel, { once: true });
                                    turn.choice = { id: choiceId, question, resolve: finish, cancel };
                                    emit({ type: "choice", id: choiceId, ...question });
                                });
                                trace.status = "completed";
                                emit({ type: "tool", ...trace });
                                return {
                                    structuredContent: answer,
                                    content: [{ type: "text", text: JSON.stringify(answer) }],
                                };
                            }
                            if (WRITE_TOOLS.has(name) || name === PERSONAL_WRITE) {
                                workspace.checkWrite(name, args);
                                const packagePlan = await workspace.prepareWrite(name, args);
                                pauseBudget();
                                const approved = await new Promise((resolve) => {
                                    const approvalId = randomUUID();
                                    let timer;
                                    const finish = (value) => {
                                        clearTimeout(timer);
                                        controller.signal.removeEventListener("abort", deny);
                                        turn.pending = null;
                                        resumeBudget();
                                        resolve(value);
                                    };
                                    const deny = () => finish(false);
                                    timer = setTimeout(deny, 120000);
                                    timer.unref();
                                    controller.signal.addEventListener("abort", deny, { once: true });
                                    turn.approval = { id: approvalId, resolve: finish };
                                    emit({
                                        type: "approval",
                                        id: approvalId,
                                        tool: name,
                                        arguments:
                                            name === PERSONAL_WRITE
                                                ? {
                                                      ...args,
                                                      destination: workspace.destination(),
                                                      ...(packagePlan ? { package: packagePlan } : {}),
                                                  }
                                                : args,
                                    });
                                });
                                turn.approval = null;
                                if (!approved || controller.signal.aborted) throw new Error("Change was not confirmed");
                            }
                            const result = await workspace.call(name, args);
                            trace.status =
                                result?.isError || result?.structuredContent?.success === false
                                    ? "failed"
                                    : "completed";
                            if (
                                name === PERSONAL_WRITE &&
                                trace.status === "completed" &&
                                result.structuredContent?.saved
                            ) {
                                trace.artifact = recordArtifact(conversation, args, result.structuredContent);
                                for (const file of result.structuredContent.files || [])
                                    recordArtifact(
                                        conversation,
                                        { ...args, path: file.path },
                                        { ...result.structuredContent, ...file },
                                    );
                                store.save(identity, conversation);
                            }
                            emit({ type: "tool", ...trace });
                            return result;
                        } catch (error) {
                            trace.status = "failed";
                            emit({ type: "tool", ...trace });
                            throw error;
                        }
                    }),
                });
                if (!content) content = result || "No response was returned. Please try again.";
                conversation.run.status = "completed";
                checkpoint();
                emit({ type: "done", conversationId: id });
            } catch {
                const stopped = controller.signal.aborted;
                const reason = stopped ? controller.signal.reason : "PROVIDER_OR_TOOL_ERROR";
                const message =
                    reason === "TIME_LIMIT"
                        ? "This response reached its time limit. Continue from saved progress to reuse retained drafts and completed modelling evidence."
                        : reason === "TOOL_LIMIT"
                          ? "This response reached its tool limit. Continue from saved progress to reuse completed work."
                          : reason === "USER_STOP"
                            ? "Response stopped. Continue from saved progress when ready."
                            : "The assistant was interrupted. Continue from saved progress to reuse retained drafts and completed modelling evidence.";
                content = content ? content + "\n\n" + message : message;
                reply.error = true;
                for (const tool of toolActivity) if (tool.status === "running") tool.status = "interrupted";
                conversation.run.status = "interrupted";
                conversation.run.reason = typeof reason === "string" ? reason : "INTERRUPTED";
                checkpoint();
                emit({ type: "error", message });
                console.error(
                    JSON.stringify({
                        event: "chat_turn_failed",
                        code: conversation.run.reason,
                        toolCount,
                        lastTool: toolActivity.at(-1)?.name || null,
                    }),
                );
            } finally {
                clearTimeout(timeout);
                clearInterval(heartbeat);
                clearInterval(snapshot);
                await mcp?.close?.();
                active.delete(key);
                turn.approval?.resolve(false);
                turn.choice?.cancel();
                if (!res.destroyed) res.end();
            }
        } catch (error) {
            if (res.headersSent) {
                res.end();
                return;
            }
            if (typeof error.message === "string" && error.message.startsWith("IDENTITY_")) {
                error.status =
                    error.status ||
                    (/ADMIN_REQUIRED|OWNER_REQUIRED/.test(error.message)
                        ? 403
                        : /NOT_FOUND/.test(error.message)
                          ? 404
                          : /EXISTS|LAST_ADMIN|OWNER_ALREADY/.test(error.message)
                            ? 409
                            : /BUSY|CORRUPT|CHAIN_INVALID/.test(error.message)
                              ? 503
                              : /LOGIN_INVALID/.test(error.message)
                                ? 401
                                : 400);
                error.message = /LOGIN_INVALID|BOOTSTRAP_INVALID|INVITATION_INVALID|RESET_INVALID/.test(error.message)
                    ? "The sign-in or one-time link is invalid or expired."
                    : /ADMIN_REQUIRED|OWNER_REQUIRED/.test(error.message)
                      ? "Platform owner or administrator permission is required."
                      : /LAST_ADMIN/.test(error.message)
                        ? "At least one active administrator must remain."
                        : "The identity request could not be completed.";
            }
            const status = [400, 401, 403, 404, 409, 413, 415, 421, 429, 503].includes(error.status)
                ? error.status
                : 500;
            json(res, status, {
                error: error.login
                    ? error.login.locked
                        ? "Sign-in is locked after 5 failed attempts. Use a saved recovery code or contact your administrator for a one-time recovery link."
                        : "Sign-in failed. " +
                          error.login.failedAttempts +
                          " of 5 attempts used; " +
                          error.login.remainingAttempts +
                          " attempts remain. Check your username, password and authenticator code, or use account recovery."
                    : status === 500
                      ? "The service could not complete the request."
                      : error.message,
                ...(error.login ? { login: error.login } : {}),
                ...(/^(?:CDR|ENGINE)_[A-Z_]{1,70}$/.test(error.code || "") ? { code: error.code } : {}),
            });
        }
    });
    // Receiving a 10 MiB source file can take longer than a small JSON request.
    // Keep uploads bounded, but allow slower connections two minutes to finish.
    server.requestTimeout = 120000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 40;
    server.on("close", () => {
        clearInterval(cleanup);
        provider.close?.();
        for (const turn of active.values()) turn.controller.abort();
        for (const draft of drafts.values()) draft.abort();
    });
    return server;
}
