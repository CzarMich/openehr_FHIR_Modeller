import { randomBytes, timingSafeEqual } from "node:crypto";
import { unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as oidc from "openid-client";
import { IdentityStore } from "./identity-store.mjs";
import { ProviderStore } from "./provider-store.mjs";

export function equal(a, b) {
    return (
        typeof a === "string" &&
        typeof b === "string" &&
        Buffer.byteLength(a) === Buffer.byteLength(b) &&
        timingSafeEqual(Buffer.from(a), Buffer.from(b))
    );
}
function token() {
    return randomBytes(32).toString("hex");
}
export function cookies(req) {
    return Object.fromEntries(
        (req.headers.cookie || "")
            .split(";")
            .map((v) => v.trim().split(/=(.*)/s).slice(0, 2))
            .filter((v) => v.length === 2),
    );
}
export class Auth {
    constructor(config) {
        this.config = config;
        this.sessions = new Map();
        this.sessionStore = config.providerEncryptionKey
            ? new ProviderStore(join(config.dataDir, "browser-sessions"), config.providerEncryptionKey, ["session"])
            : null;
        if (this.sessionStore) {
            for (const name of readdirSync(this.sessionStore.directory)) {
                if (!/^[a-f0-9]{64}-session\.json$/.test(name)) continue;
                const path = join(this.sessionStore.directory, name);
                if (statSync(path).mtimeMs < Date.now() - 8 * 3600000) unlinkSync(path);
            }
        }
        this.transactions = new Map();
        this.discovery = null;
        this.identityStore = config.identityEnabled
            ? new IdentityStore(config.dataDir + "/identity", {
                  issuer: config.localIssuer,
                  sessionSeconds: config.sessionSeconds,
                  encryptionKey: config.identityEncryptionKey,
              })
            : null;
    }
    cookie(name, value, maxAge) {
        return `${this.config.secure ? "__Host-" : ""}${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config.secure ? "; Secure" : ""}`;
    }
    value(req, name) {
        return cookies(req)[`${this.config.secure ? "__Host-" : ""}${name}`];
    }
    cleanup() {
        for (const map of [this.sessions, this.transactions])
            for (const [id, data] of map) if (data.expires < Date.now()) map.delete(id);
    }
    async client() {
        if (!this.discovery)
            this.discovery = oidc
                .discovery(new URL(this.config.issuer), this.config.clientId, this.config.clientSecret, undefined, {
                    execute: [oidc.enableNonRepudiationChecks],
                })
                .catch((error) => {
                    this.discovery = null;
                    throw error;
                });
        return this.discovery;
    }
    async login(req, res) {
        this.cleanup();
        if (!this.config.issuer || !this.config.clientId || !this.config.clientSecret)
            throw Object.assign(new Error("Organisation sign-in is not configured. Use local account sign-in."), {
                status: 503,
            });
        if (this.transactions.size >= 1000) throw Object.assign(new Error("Please try again later"), { status: 429 });
        const client = await this.client(),
            id = token(),
            state = oidc.randomState(),
            nonce = oidc.randomNonce(),
            verifier = oidc.randomPKCECodeVerifier();
        const destination =
            !this.config.enabled || new URL(req.url, this.config.origin).searchParams.get("review") === "1"
                ? "/chat/reviews"
                : "/chat/";
        this.transactions.set(id, { state, nonce, verifier, destination, expires: Date.now() + 300000 });
        res.setHeader("Set-Cookie", this.cookie("ModellingLogin", id, 300));
        res.writeHead(302, {
            Location: oidc.buildAuthorizationUrl(client, {
                redirect_uri: this.config.origin + "/chat/auth/callback",
                scope: "openid profile email",
                state,
                nonce,
                code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
                code_challenge_method: "S256",
            }).href,
        });
        res.end();
    }
    async callback(req, res) {
        this.cleanup();
        const id = this.value(req, "ModellingLogin"),
            transaction = this.transactions.get(id);
        this.transactions.delete(id);
        if (!transaction || this.sessions.size >= 1000)
            throw Object.assign(new Error("Sign-in expired. Please try again."), { status: 401 });
        const tokens = await oidc.authorizationCodeGrant(await this.client(), new URL(req.url, this.config.origin), {
            pkceCodeVerifier: transaction.verifier,
            expectedState: transaction.state,
            expectedNonce: transaction.nonce,
            idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!claims?.sub) throw Object.assign(new Error("Sign-in failed"), { status: 401 });
        if (
            this.config.allowedGroups.length &&
            !this.config.allowedGroups.some((group) => Array.isArray(claims.groups) && claims.groups.includes(group))
        )
            throw Object.assign(new Error("Access is not enabled for this account."), { status: 403 });
        let reviewIdentity;
        if (this.config.reviewEnabled || this.config.cdrEnabled) {
            const claim = (path) =>
                path
                    .split(".")
                    .reduce((value, key) => (value && Object.hasOwn(value, key) ? value[key] : undefined), claims);
            const roles = claim(this.config.reviewRolesClaim) ?? [];
            const tenant = this.config.reviewTenantClaim ? claim(this.config.reviewTenantClaim) : claims.iss;
            const projectScopes = claim(this.config.reviewProjectScopesClaim) ?? [];
            if (
                !Array.isArray(roles) ||
                roles.length > 100 ||
                roles.some((role) => typeof role !== "string" || role.length > 200) ||
                !Array.isArray(projectScopes) ||
                projectScopes.length > 100 ||
                projectScopes.some(
                    (scope) =>
                        typeof scope !== "string" ||
                        !/^(?:projects:admin|projects:create|project:[A-Za-z0-9._-]{1,100}:(?:read|write))$/.test(
                            scope,
                        ),
                ) ||
                typeof tenant !== "string" ||
                !tenant ||
                tenant.length > 300
            )
                throw Object.assign(new Error("Review identity claims are not configured correctly."), { status: 403 });
            reviewIdentity = {
                issuer: claims.iss,
                subject: claims.sub,
                tenant,
                roles,
                projectScopes,
                started: Math.floor(Date.now() / 1000),
                method: "interactive_oidc",
            };
        }
        const sessionId = token();
        this.sessions.set(sessionId, {
            identity: claims.iss + "\n" + claims.sub,
            name: String(claims.name || claims.preferred_username || "User").slice(0, 160),
            csrf: token(),
            reviewIdentity,
            started: Date.now(),
            expires: Date.now() + this.config.sessionSeconds * 1000,
        });
        this.sessionStore?.set(sessionId, "session", this.sessions.get(sessionId));
        res.setHeader("Set-Cookie", [
            this.cookie("ModellingSession", sessionId, this.config.sessionSeconds),
            this.cookie("ModellingLogin", "", 0),
        ]);
        res.writeHead(302, {
            Location: transaction.destination === "/chat/reviews" || !this.config.enabled ? "/chat/reviews" : "/chat/",
        });
        res.end();
    }
    session(req) {
        this.cleanup();
        const sessionToken = this.value(req, "ModellingSession");
        if (this.identityStore) {
            const local = this.identityStore.localSession(sessionToken);
            if (local) return local;
            const setup = this.identityStore.createSessionForSetup(sessionToken);
            if (setup)
                return {
                    identity: this.config.localIssuer + "\n" + setup.user.id,
                    name: setup.user.displayName,
                    csrf: setup.csrf,
                    expires: setup.expires,
                    user: setup.user,
                    mfaSetupRequired: true,
                    totpSecret: setup.totpSecret,
                    otpAuthUrl: this.otpAuthUrl(setup.totpSecret, setup.user.username),
                };
        }
        if (!sessionToken) return undefined;
        const session = this.sessions.get(sessionToken) || this.sessionStore?.get(sessionToken, "session")?.credential;
        if (session && session.expires <= Date.now()) {
            this.sessions.delete(sessionToken);
            this.sessionStore?.delete(sessionToken, "session");
            return undefined;
        }
        if (session) this.sessions.set(sessionToken, session);
        return session;
    }
    async localLogin(input, req, res) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = await this.identityStore.login(
            input.username,
            input.password,
            input.otp,
            input.recoveryCode,
            req.socket.remoteAddress || "unknown",
        );
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return { user: result.user, csrf: result.csrf };
    }
    signup(input, req, res) {
        if (!this.identityStore || this.config.signupEnabled === false)
            throw Object.assign(new Error("Self-registration is unavailable."), { status: 403 });
        const result = this.identityStore.signup(
            input.username,
            input.displayName,
            input.password,
            req.socket.remoteAddress || "unknown",
        );
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return {
            user: result.user,
            csrf: result.csrf,
            totpSecret: result.totpSecret,
            otpAuthUrl: this.otpAuthUrl(result.totpSecret, result.user.username),
            mfaSetupRequired: true,
        };
    }
    bootstrap(input, res) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = this.identityStore.bootstrap(input.token, input.username, input.displayName, input.password);
        try {
            unlinkSync(this.config.dataDir + "/owner-bootstrap.token");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return {
            user: result.user,
            csrf: result.csrf,
            totpSecret: result.totpSecret,
            otpAuthUrl: this.otpAuthUrl(result.totpSecret, result.user.username),
            mfaSetupRequired: true,
        };
    }
    acceptInvite(input, res) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = this.identityStore.acceptInvite(input.token, input.username, input.displayName, input.password);
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return {
            user: result.user,
            csrf: result.csrf,
            totpSecret: result.totpSecret,
            otpAuthUrl: this.otpAuthUrl(result.totpSecret, result.user.username),
            mfaSetupRequired: true,
        };
    }
    recoverWithCode(input, res) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = this.identityStore.recoverWithCode(input.username, input.recoveryCode, input.password);
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return {
            user: result.user,
            csrf: result.csrf,
            totpSecret: result.totpSecret,
            otpAuthUrl: this.otpAuthUrl(result.totpSecret, result.user.username),
            mfaSetupRequired: true,
        };
    }
    completeAccountRecovery(input, res) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = this.identityStore.completeAccountRecovery(input.token, input.password);
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", result.sessionToken, this.config.sessionSeconds));
        return {
            user: result.user,
            csrf: result.csrf,
            totpSecret: result.totpSecret,
            otpAuthUrl: this.otpAuthUrl(result.totpSecret, result.user.username),
            mfaSetupRequired: true,
        };
    }
    finishMfa(req, input) {
        if (!this.identityStore) throw Object.assign(new Error("Local identity is not enabled."), { status: 503 });
        const result = this.identityStore.verifyMfaSetup(this.value(req, "ModellingSession"), input.code);
        return { user: result.user, csrf: result.csrf, recoveryCodes: result.recoveryCodes };
    }
    otpAuthUrl(secret, username) {
        const label = encodeURIComponent("openEHR Modelling Assistant:" + username);
        return `otpauth://totp/${label}?secret=${secret}&issuer=openEHR%20Modelling%20Assistant&algorithm=SHA1&digits=6&period=30`;
    }
    require(req, mutation = false, allowMfaSetup = false) {
        const session = this.session(req);
        if (!session) throw Object.assign(new Error("Please sign in to continue."), { status: 401 });
        if (session.mfaSetupRequired && !allowMfaSetup)
            throw Object.assign(new Error("Complete multi-factor setup before continuing."), { status: 403 });
        if (
            mutation &&
            (req.headers.origin !== this.config.origin || !equal(req.headers["x-csrf-token"], session.csrf))
        )
            throw Object.assign(new Error("Request could not be verified"), { status: 403 });
        return session;
    }
    logout(req, res) {
        this.require(req, true);
        const sessionToken = this.value(req, "ModellingSession");
        this.sessions.delete(sessionToken);
        this.sessionStore?.delete(sessionToken, "session");
        if (this.identityStore) this.identityStore.revokeSession(sessionToken);
        res.setHeader("Set-Cookie", this.cookie("ModellingSession", "", 0));
    }
    renew(req, res) {
        const session = this.require(req, true);
        const token = this.value(req, "ModellingSession");
        let expires;
        if (session.user) expires = this.identityStore.renewSession(token);
        else {
            session.started ??= session.expires - this.config.sessionSeconds * 1000;
            expires = Math.min(Date.now() + this.config.sessionSeconds * 1000, session.started + 8 * 3600000);
            if (expires > Date.now()) session.expires = expires;
            this.sessionStore?.set(token, "session", session);
        }
        if (!expires || expires <= Date.now())
            throw Object.assign(new Error("Please sign in again to continue your saved work."), { status: 401 });
        res.setHeader(
            "Set-Cookie",
            this.cookie("ModellingSession", token, Math.max(1, Math.floor((expires - Date.now()) / 1000))),
        );
        return { expires };
    }
}
