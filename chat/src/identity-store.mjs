import { GLOBAL_PERMISSIONS } from "./access.mjs";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    randomUUID,
    scrypt,
    scryptSync,
    timingSafeEqual,
} from "node:crypto";
import {
    closeSync,
    chmodSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

const roles = new Set([
    "modelling-administrator",
    "modelling-modeller",
    "modelling-reviewer",
    "modelling-approver",
    "modelling-publisher",
]);
const now = () => Date.now();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const equal = (left, right) =>
    typeof left === "string" &&
    typeof right === "string" &&
    Buffer.byteLength(left) === Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right));
const token = (prefix = "") => prefix + randomBytes(32).toString("base64url");
const passwordHash = (password, salt = randomBytes(16).toString("hex")) => ({
    salt,
    hash: scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }).toString("hex"),
});
const passwordValid = (value) =>
    typeof value === "string" && value.length >= 12 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const usernameValid = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value);

function totp(secret, counterValue = Math.floor(Date.now() / 30000)) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(counterValue));
    const digest = createHmac("sha1", secret).update(counter).digest();
    const offset = digest.at(-1) & 15;
    const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return String(number).padStart(6, "0");
}
function base32(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0,
        value = 0,
        output = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}
function decodeBase32(value) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0,
        buffer = 0,
        output = [];
    for (const char of value.toUpperCase().replace(/=+$/, "")) {
        const index = alphabet.indexOf(char);
        if (index < 0) throw new Error("IDENTITY_TOTP_INVALID");
        buffer = (buffer << 5) | index;
        bits += 5;
        if (bits >= 8) {
            output.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(output);
}

export class IdentityStore {
    constructor(
        directory,
        { issuer = "https://localhost/identity/local", sessionSeconds = 3600, encryptionKey = "" } = {},
    ) {
        this.directory = directory;
        this.path = join(directory, "identity.json");
        this.lockPath = join(directory, "identity.lock");
        if (!/^[a-f0-9]{64}$/.test(encryptionKey)) throw new Error("IDENTITY_ENCRYPTION_KEY_REQUIRED");
        this.encryptionKey = Buffer.from(encryptionKey, "hex");
        this.issuer = issuer;
        this.sessionSeconds = sessionSeconds;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        const unlock = this.lock();
        try {
            if (!existsSync(this.path)) this.write(this.empty());
        } finally {
            unlock();
        }
        this.read();
    }

    empty() {
        return {
            schema: 1,
            bootstrap: null,
            users: [],
            invites: [],
            resets: [],
            sessions: [],
            serviceAccounts: [],
            audit: [],
        };
    }

    lock() {
        const deadline = Date.now() + 5000;
        while (true) {
            try {
                const fd = openSync(this.lockPath, "wx", 0o600);
                writeFileSync(fd, String(process.pid));
                return () => {
                    closeSync(fd);
                    try {
                        const owner = Number(readFileSync(this.lockPath, "utf8"));
                        if (owner === process.pid) unlinkSync(this.lockPath);
                    } catch {}
                };
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                try {
                    const pid = Number(readFileSync(this.lockPath, "utf8"));
                    process.kill(pid, 0);
                } catch (check) {
                    if (check.code === "ESRCH" || check.code === "ENOENT") {
                        try {
                            unlinkSync(this.lockPath);
                        } catch {}
                        continue;
                    }
                }
                if (Date.now() >= deadline) throw new Error("IDENTITY_STORE_BUSY");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
        }
    }

    read() {
        let state;
        if ((statSync(this.path).mode & 0o077) !== 0) throw new Error("IDENTITY_STORE_PERMISSIONS_INVALID");
        try {
            state = JSON.parse(readFileSync(this.path, "utf8"));
        } catch {
            throw new Error("IDENTITY_STORE_CORRUPT");
        }
        if (state.schema !== 1 || !Array.isArray(state.audit)) throw new Error("IDENTITY_STORE_CORRUPT");
        let previous = "0".repeat(64);
        for (const event of state.audit) {
            const { hash: recorded, ...body } = event;
            if (body.previous !== previous || hash(JSON.stringify(body)) !== recorded)
                throw new Error("IDENTITY_AUDIT_CHAIN_INVALID");
            previous = recorded;
        }
        // Existing installations retain their original bootstrap owner.
        state.ownerId ||= state.bootstrap?.consumed ? state.users[0]?.id : null;
        for (const user of state.users) user.isOwner = user.id === state.ownerId;
        return state;
    }

    write(state) {
        const temporary = this.path + "." + randomUUID() + ".tmp";
        const fd = openSync(temporary, "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(state));
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, this.path);
        const directory = openSync(this.directory, "r");
        try {
            fsyncSync(directory);
        } finally {
            closeSync(directory);
        }
    }

    mutate(actor, action, details, callback) {
        const unlock = this.lock();
        try {
            const state = this.read();
            state.sessions = state.sessions.filter((session) => !session.revoked && session.expires > now());
            state.invites = state.invites.filter((invite) => !invite.used && invite.expires > now());
            state.resets = state.resets.filter((entry) => entry.expires > now());
            const result = callback(state);
            const previous = state.audit.at(-1)?.hash || "0".repeat(64);
            const eventAction = typeof action === "function" ? action(result) : action;
            if (eventAction) {
                const event = {
                    sequence: state.audit.length + 1,
                    timestamp: new Date().toISOString(),
                    actor,
                    action: eventAction,
                    details,
                    previous,
                };
                event.hash = hash(JSON.stringify(event));
                state.audit.push(event);
            }
            this.write(state);
            return result;
        } finally {
            unlock();
        }
    }

    audit(state) {
        return state.audit.map(({ sequence, timestamp, actor, action, details, previous, hash: digest }) => ({
            sequence,
            timestamp,
            actor,
            action,
            details,
            previous,
            hash: digest,
        }));
    }

    bootstrapToken() {
        const value = token("boot_");
        this.mutate("operator", "OWNER_BOOTSTRAP_CREATED", { expires_in_seconds: 900 }, (state) => {
            if (state.users.length > 0 || state.bootstrap?.consumed) throw new Error("IDENTITY_OWNER_ALREADY_EXISTS");
            state.bootstrap = { digest: hash(value), expires: now() + 900000 };
        });
        return value;
    }

    bootstrap(value, username, displayName, password) {
        this.validateIdentityInput(username, displayName, password);
        const secret = base32(randomBytes(20));
        return this.mutate("bootstrap", "OWNER_BOOTSTRAP_ACCEPTED", { username: username.toLowerCase() }, (state) => {
            if (
                !state.bootstrap ||
                state.bootstrap.expires < now() ||
                !this.matches(value, state.bootstrap.digest) ||
                state.users.length > 0
            )
                throw new Error("IDENTITY_BOOTSTRAP_INVALID");
            state.bootstrap = { consumed: true, consumedAt: new Date().toISOString() };
            const user = this.newUser(username, displayName, password, [
                "modelling-administrator",
                "modelling-modeller",
                "modelling-reviewer",
                "modelling-approver",
                "modelling-publisher",
            ]);
            state.ownerId = user.id;
            user.isOwner = true;
            user.mfaSecret = this.encrypt(secret);
            user.mfaPending = true;
            state.users.push(user);
            const session = this.newSession(user, "mfa_setup");
            state.sessions.push(session.record);
            return { user: this.publicUser(user), sessionToken: session.raw, csrf: session.csrf, totpSecret: secret };
        });
    }

    signupAvailable() {
        const state = this.read();
        return (
            state.signupEnabled !== false &&
            state.users.some(
                (user) => user.id === state.ownerId && user.status === "active" && user.mfaEnabled && !user.mfaPending,
            )
        );
    }

    signup(username, displayName, password, address) {
        this.validateIdentityInput(username, displayName, password);
        const secret = base32(randomBytes(20));
        return this.mutate("registration", "USER_REGISTERED", { username: username.toLowerCase() }, (state) => {
            if (!this.signupAvailable()) throw new Error("IDENTITY_SIGNUP_CLOSED");
            state.registrations = (state.registrations || []).filter((entry) => entry.at > now() - 3600000);
            const client = hash(address);
            if (
                state.registrations.filter((entry) => entry.client === client).length >= 5 ||
                state.registrations.length >= 100 ||
                state.users.length >= 1000
            )
                throw Object.assign(new Error("Too many registrations. Try again later."), { status: 429 });
            const user = this.newUser(username, displayName, password, ["modelling-modeller"]);
            user.permissions = [];
            user.mfaSecret = this.encrypt(secret);
            user.mfaPending = true;
            state.users.push(user);
            state.registrations.push({ client, at: now() });
            const session = this.newSession(user, "mfa_setup");
            state.sessions.push(session.record);
            return { user: this.publicUser(user), sessionToken: session.raw, csrf: session.csrf, totpSecret: secret };
        });
    }

    setSignup(actor, enabled) {
        if (typeof enabled !== "boolean") throw new Error("IDENTITY_INPUT_INVALID");
        return this.mutate(actor, "SIGNUP_SETTING_CHANGED", { enabled }, (state) => {
            if (actor !== state.ownerId || !this.isAdmin(state, actor)) throw new Error("IDENTITY_OWNER_REQUIRED");
            state.signupEnabled = enabled;
            return { enabled };
        });
    }

    setPermissions(actor, userId, permissions) {
        if (
            !Array.isArray(permissions) ||
            permissions.length > GLOBAL_PERMISSIONS.length ||
            permissions.some((p) => !GLOBAL_PERMISSIONS.includes(p))
        )
            throw new Error("IDENTITY_PERMISSIONS_INVALID");
        return this.mutate(actor, "USER_PERMISSIONS_CHANGED", { user_id: userId, permissions }, (state) => {
            if (actor !== state.ownerId || !this.isAdmin(state, actor)) throw new Error("IDENTITY_OWNER_REQUIRED");
            const user = state.users.find((item) => item.id === userId);
            if (!user || user.id === state.ownerId) throw new Error("IDENTITY_USER_INPUT_INVALID");
            user.permissions = [...new Set(permissions)];
            for (const session of state.sessions) if (session.userId === userId) session.revoked = true;
            return this.publicUser(user);
        });
    }

    protectPrivilegedUser(state, actor, userId) {
        const user = state.users.find((item) => item.id === userId);
        if (actor !== state.ownerId && (userId === state.ownerId || user?.permissions?.length))
            throw new Error("IDENTITY_OWNER_REQUIRED");
    }

    invite(actor, email, rolesList, expiresSeconds = 86400) {
        if (
            !this.validEmail(email) ||
            !Number.isInteger(expiresSeconds) ||
            expiresSeconds < 300 ||
            expiresSeconds > 604800
        )
            throw new Error("IDENTITY_INVITE_INPUT_INVALID");
        this.assertRoles(rolesList);
        const value = token("inv_");
        const result = this.mutate(actor, "USER_INVITED", { email: email.toLowerCase(), roles: rolesList }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            const invitation = {
                id: randomUUID(),
                email: email.toLowerCase(),
                roles: [...new Set(rolesList)],
                digest: hash(value),
                expires: now() + expiresSeconds * 1000,
                createdBy: actor,
            };
            state.invites.push(invitation);
            return {
                invitation: {
                    id: invitation.id,
                    email: invitation.email,
                    roles: invitation.roles,
                    expires: new Date(invitation.expires).toISOString(),
                },
                token: value,
            };
        });
        return result;
    }

    acceptInvite(value, username, displayName, password) {
        this.validateIdentityInput(username, displayName, password);
        const secret = base32(randomBytes(20));
        return this.mutate("invitation", "INVITATION_ACCEPTED", { username: username.toLowerCase() }, (state) => {
            const invitation = state.invites.find(
                (item) => !item.used && item.expires > now() && this.matches(value, item.digest),
            );
            if (!invitation) throw new Error("IDENTITY_INVITATION_INVALID");
            if (state.users.some((user) => user.username === username.toLowerCase() || user.email === invitation.email))
                throw new Error("IDENTITY_USER_EXISTS");
            invitation.used = true;
            const user = this.newUser(username, displayName, password, invitation.roles, invitation.email);
            user.mfaSecret = this.encrypt(secret);
            user.mfaPending = true;
            state.users.push(user);
            const session = this.newSession(user, "mfa_setup");
            state.sessions.push(session.record);
            return { user: this.publicUser(user), sessionToken: session.raw, csrf: session.csrf, totpSecret: secret };
        });
    }

    failedLogin(username, increment = true) {
        const digest = hash(String(username).toLowerCase());
        const failure = this.mutate(
            "login",
            (result) => (result.changed ? "USER_LOGIN_FAILED" : null),
            { username_hash: digest },
            (state) => {
                state.loginFailures ||= {};
                const entry = state.loginFailures[digest] || { count: 0, at: now() };
                const previousCount = entry.count;
                if (increment) entry.count = Math.min(5, entry.count + 1);
                entry.at = now();
                state.loginFailures[digest] = entry;
                const user = state.users.find((item) => hash(item.username) === digest);
                if (user && entry.count >= 5) user.loginLocked = true;
                // Bound unknown-username counters while retaining real account locks.
                const known = new Set(state.users.map((item) => hash(item.username)));
                const unknown = Object.entries(state.loginFailures)
                    .filter(([key]) => !known.has(key))
                    .sort((a, b) => a[1].at - b[1].at);
                for (const [key] of unknown.slice(0, Math.max(0, unknown.length - 4096)))
                    delete state.loginFailures[key];
                return { count: entry.count, changed: entry.count !== previousCount };
            },
        );
        const attempts = failure.count;
        return Object.assign(new Error("IDENTITY_LOGIN_INVALID"), {
            status: 401,
            login: { failedAttempts: attempts, remainingAttempts: Math.max(0, 5 - attempts), locked: attempts >= 5 },
        });
    }

    clearLoginFailures(state, user) {
        if (state.loginFailures) delete state.loginFailures[hash(user.username)];
        user.loginLocked = false;
        state.resets = state.resets.filter(
            (entry) => entry.kind !== "rate" || entry.usernameHash !== hash(user.username),
        );
    }

    recoverWithCode(username, code, password) {
        const allowed = this.mutate("recovery_code", null, {}, (state) => {
            state.recoveryAttempts = (state.recoveryAttempts || []).filter((entry) => entry.at > now() - 900000);
            const digest = hash(String(username).toLowerCase());
            if (
                state.recoveryAttempts.length >= 1000 ||
                state.recoveryAttempts.filter((entry) => entry.digest === digest).length >= 10
            )
                return false;
            state.recoveryAttempts.push({ digest, at: now() });
            return true;
        });
        if (!allowed)
            throw Object.assign(
                new Error("Too many recovery attempts. Wait 15 minutes or contact your administrator."),
                { status: 429 },
            );
        this.validateIdentityInput(username, "Recovery", password);
        const secret = base32(randomBytes(20));
        return this.mutate("recovery_code", "ACCOUNT_RECOVERY_CODE_USED", {}, (state) => {
            const user = state.users.find(
                (item) => item.username === String(username).toLowerCase() && item.status === "active",
            );
            if (!user || typeof code !== "string" || !user.recoveryCodes.some((digest) => this.matches(code, digest)))
                throw new Error("IDENTITY_RESET_INVALID");
            user.password = passwordHash(password);
            this.clearLoginFailures(state, user);
            user.mfaSecret = this.encrypt(secret);
            user.mfaEnabled = false;
            user.mfaPending = true;
            user.mfaCounter = -1;
            user.recoveryCodes = user.recoveryCodes.filter((digest) => !this.matches(code, digest));
            for (const session of state.sessions) if (session.userId === user.id) session.revoked = true;
            state.resets = state.resets.filter((entry) => entry.userId !== user.id);
            const session = this.newSession(user, "mfa_setup");
            state.sessions.push(session.record);
            return { user: this.publicUser(user), sessionToken: session.raw, csrf: session.csrf, totpSecret: secret };
        });
    }

    async login(username, password, otp, recoveryCode, remoteKey) {
        const key = hash(String(remoteKey) + "\n" + String(username).toLowerCase());
        const allowed = this.mutate("system", null, {}, (state) => {
            state.resets = state.resets.filter((entry) => entry.kind !== "rate" || entry.expires > now());
            let item = state.resets.find((entry) => entry.kind === "rate" && entry.digest === key);
            if (!item || item.expires < now()) {
                item = {
                    kind: "rate",
                    digest: key,
                    usernameHash: hash(String(username).toLowerCase()),
                    attempts: 0,
                    expires: now() + 900000,
                };
                state.resets = state.resets.filter((entry) => entry.kind !== "rate" || entry.digest !== key);
                const rates = state.resets.filter((entry) => entry.kind === "rate");
                if (rates.length >= 4096) {
                    const oldest = rates.reduce((first, entry) => (entry.expires < first.expires ? entry : first));
                    state.resets = state.resets.filter((entry) => entry !== oldest);
                }
                state.resets.push(item);
            }
            item.attempts++;
            return item.attempts <= 8;
        });
        if (!allowed) throw this.failedLogin(username, false);
        const state = this.read();
        if ((state.loginFailures?.[hash(String(username).toLowerCase())]?.count || 0) >= 5)
            throw this.failedLogin(username, false);
        const user = state.users.find(
            (entry) => entry.username === String(username).toLowerCase() && entry.status === "active",
        );
        const fake = { salt: "0".repeat(32), hash: "0".repeat(128) };
        const candidate = await new Promise((resolve, reject) =>
            scrypt(
                String(password || ""),
                user?.password.salt || fake.salt,
                64,
                { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 },
                (error, value) => (error ? reject(error) : resolve(value.toString("hex"))),
            ),
        );
        if (!user || !equal(candidate, user.password.hash) || user.mfaPending) throw this.failedLogin(username);
        const response = this.mutate(
            user.id,
            (result) => (result.failed ? null : "USER_LOGIN_SUCCEEDED"),
            { user_id: user.id, roles: user.roles },
            (draft) => {
                const current = draft.users.find((entry) => entry.id === user.id);
                if (
                    current.loginLocked ||
                    current.status !== "active" ||
                    current.mfaPending ||
                    !equal(candidate, current.password.hash) ||
                    (current.mfaEnabled && !this.consumeMfa(current, otp, recoveryCode))
                )
                    return { failed: true };
                this.clearLoginFailures(draft, current);
                const session = this.newSession(current, "authenticated");
                draft.sessions.push(session.record);
                draft.resets = draft.resets.filter((entry) => !(entry.kind === "rate" && entry.digest === key));
                return { user: this.publicUser(current), sessionToken: session.raw, csrf: session.csrf };
            },
        );
        if (response.failed) throw this.failedLogin(username);
        return response;
    }

    createSessionForSetup(sessionToken) {
        const state = this.read();
        const session = state.sessions.find(
            (entry) => !entry.revoked && this.matches(sessionToken, entry.digest) && entry.expires > now(),
        );
        if (!session || session.kind !== "mfa_setup") return null;
        const user = state.users.find(
            (entry) => entry.id === session.userId && entry.status === "active" && entry.mfaPending,
        );
        if (!user) return null;
        return {
            ...session,
            csrf: this.decrypt(session.csrfEncrypted),
            user: this.publicUser(user),
            totpSecret: this.decrypt(user.mfaSecret),
        };
    }

    localSession(sessionToken) {
        const state = this.read();
        const session = state.sessions.find(
            (entry) => !entry.revoked && this.matches(sessionToken, entry.digest) && entry.expires > now(),
        );
        if (!session || session.kind !== "authenticated") return null;
        const user = state.users.find(
            (entry) => entry.id === session.userId && entry.status === "active" && !entry.mfaPending,
        );
        if (!user) return null;
        return {
            identity: this.issuer + "\n" + user.id,
            name: user.displayName,
            csrf: this.decrypt(session.csrfEncrypted),
            reviewIdentity: {
                issuer: this.issuer,
                subject: user.id,
                tenant: this.issuer,
                roles: user.roles,
                projectScopes: user.projectScopes || [],
                started: session.created,
                method: "interactive_local",
            },
            expires: session.expires,
            user: this.publicUser(user),
            sessionToken,
        };
    }

    renewSession(sessionToken) {
        return this.mutate("local_user", null, {}, (state) => {
            const session = state.sessions.find(
                (entry) =>
                    !entry.revoked &&
                    entry.kind === "authenticated" &&
                    this.matches(sessionToken, entry.digest) &&
                    entry.expires > now(),
            );
            const user =
                session &&
                state.users.find(
                    (entry) => entry.id === session.userId && entry.status === "active" && !entry.mfaPending,
                );
            if (!user) return null;
            // Renew inactivity expiry only; never refresh the authentication age
            // used for CDR/governance decisions, or exceed an eight-hour workday.
            const expires = Math.min(now() + this.sessionSeconds * 1000, session.created + 8 * 3600000);
            if (expires <= now()) return null;
            session.expires = expires;
            return expires;
        });
    }

    verifyMfaSetup(sessionToken, code) {
        const result = this.mutate("local_user", null, {}, (state) => {
            const session = state.sessions.find(
                (entry) =>
                    !entry.revoked &&
                    this.matches(sessionToken, entry.digest) &&
                    entry.expires > now() &&
                    entry.kind === "mfa_setup",
            );
            if (!session) return { error: "IDENTITY_SESSION_INVALID" };
            const user = state.users.find((entry) => entry.id === session.userId && entry.mfaPending);
            if (!user) return { error: "IDENTITY_SESSION_INVALID" };
            const challengeDigest = session.digest;
            let attempts = state.resets.find((entry) => entry.kind === "mfa_setup" && entry.digest === challengeDigest);
            if (!attempts) {
                attempts = { kind: "mfa_setup", digest: challengeDigest, attempts: 0, expires: session.expires };
                state.resets.push(attempts);
            }
            if (attempts.attempts >= 8) return { error: "IDENTITY_MFA_INVALID" };
            attempts.attempts++;
            const counter = this.verifyTotp(this.decrypt(user.mfaSecret), code, user.mfaCounter);
            if (counter === false) return { error: "IDENTITY_MFA_INVALID" };
            user.mfaCounter = counter;
            user.mfaPending = false;
            user.mfaEnabled = true;
            const recoveryCodes = Array.from({ length: 10 }, () => token("rc_"));
            user.recoveryCodes = recoveryCodes.map(hash);
            session.kind = "authenticated";
            state.resets = state.resets.filter(
                (entry) => !(entry.kind === "mfa_setup" && entry.digest === challengeDigest),
            );
            return {
                value: {
                    user: this.publicUser(user),
                    sessionToken,
                    csrf: this.decrypt(session.csrfEncrypted),
                    recoveryCodes,
                },
            };
        });
        if (result.error) throw new Error(result.error);
        return result.value;
    }

    revokeSession(sessionToken) {
        return this.mutate("local_user", "SESSION_REVOKED", {}, (state) => {
            const session = state.sessions.find((entry) => this.matches(sessionToken, entry.digest));
            if (session) session.revoked = true;
            return true;
        });
    }

    revokeUserSessions(actor, userId) {
        return this.mutate(actor, "USER_SESSIONS_REVOKED", { user_id: userId }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            this.protectPrivilegedUser(state, actor, userId);
            for (const session of state.sessions) if (session.userId === userId) session.revoked = true;
            return true;
        });
    }

    listUsers(actor) {
        const state = this.read();
        if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
        return {
            users: state.users.map((user) => this.publicUser(user)),
            signupEnabled: state.signupEnabled !== false,
            serviceAccounts: state.serviceAccounts.map(({ id, name, scopes, created, revoked }) => ({
                id,
                name,
                scopes,
                created,
                revoked,
            })),
            audit: this.auditSummary(state),
        };
    }
    recordMcpConnectionAccess(actor) {
        return this.mutate(actor, "MCP_CONNECTION_KEY_VIEWED", {}, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            return true;
        });
    }

    setRoles(actor, userId, rolesList) {
        this.assertRoles(rolesList);
        return this.mutate(actor, "USER_ROLES_CHANGED", { user_id: userId, roles: rolesList }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            this.protectPrivilegedUser(state, actor, userId);
            const user = state.users.find((entry) => entry.id === userId);
            if (!user) throw new Error("IDENTITY_USER_NOT_FOUND");
            if (user.id === state.ownerId && !rolesList.includes("modelling-administrator"))
                throw new Error("IDENTITY_LAST_ADMIN_REQUIRED");
            user.roles = [...new Set(rolesList)];
            for (const session of state.sessions) if (session.userId === userId) session.revoked = true;
            this.requireAdmin(state);
            return this.publicUser(user);
        });
    }

    disableUser(actor, userId) {
        return this.mutate(actor, "USER_DISABLED", { user_id: userId }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            this.protectPrivilegedUser(state, actor, userId);
            const user = state.users.find((entry) => entry.id === userId);
            if (!user) throw new Error("IDENTITY_USER_NOT_FOUND");
            if (user.id === state.ownerId) throw new Error("IDENTITY_LAST_ADMIN_REQUIRED");
            user.status = "disabled";
            for (const session of state.sessions) if (session.userId === userId) session.revoked = true;
            this.requireAdmin(state);
            return this.publicUser(user);
        });
    }

    inviteReset(actor, userId, expiresSeconds = 900) {
        const value = token("rst_");
        return this.mutate(
            actor,
            "PASSWORD_RESET_ISSUED",
            { user_id: userId, expires_in_seconds: expiresSeconds },
            (state) => {
                if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
                this.protectPrivilegedUser(state, actor, userId);
                const user = state.users.find((entry) => entry.id === userId && entry.status === "active");
                if (!user) throw new Error("IDENTITY_USER_NOT_FOUND");
                state.resets.push({
                    kind: "password_reset",
                    userId,
                    digest: hash(value),
                    expires: now() + expiresSeconds * 1000,
                });
                return { token: value, expires: new Date(now() + expiresSeconds * 1000).toISOString() };
            },
        );
    }

    issueAccountRecovery(actor, userId, expiresSeconds = 900) {
        const value = token("rec_");
        return this.mutate(
            actor,
            "ACCOUNT_RECOVERY_ISSUED",
            { user_id: userId, expires_in_seconds: expiresSeconds },
            (state) => {
                if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
                this.protectPrivilegedUser(state, actor, userId);
                const user = state.users.find((entry) => entry.id === userId && entry.status === "active");
                if (!user) throw new Error("IDENTITY_USER_NOT_FOUND");
                state.resets.push({
                    kind: "account_recovery",
                    userId,
                    digest: hash(value),
                    expires: now() + expiresSeconds * 1000,
                });
                return { token: value, expires: new Date(now() + expiresSeconds * 1000).toISOString() };
            },
        );
    }

    operatorOwnerRecovery() {
        const value = token("rec_");
        return this.mutate("server_operator", "OWNER_RECOVERY_ISSUED", { expires_in_seconds: 900 }, (state) => {
            const user = state.users.find((entry) => entry.id === state.ownerId && entry.status === "active");
            if (!user) throw new Error("IDENTITY_USER_NOT_FOUND");
            state.resets = state.resets.filter((entry) => entry.userId !== user.id);
            state.resets.push({
                kind: "account_recovery",
                userId: user.id,
                digest: hash(value),
                expires: now() + 900000,
            });
            return value;
        });
    }

    completeAccountRecovery(value, password) {
        if (!passwordValid(password)) throw new Error("IDENTITY_PASSWORD_POLICY");
        const secret = base32(randomBytes(20));
        return this.mutate("account_recovery", "ACCOUNT_RECOVERY_COMPLETED", {}, (state) => {
            const recovery = state.resets.find(
                (entry) =>
                    entry.kind === "account_recovery" && entry.expires > now() && this.matches(value, entry.digest),
            );
            if (!recovery) throw new Error("IDENTITY_RESET_INVALID");
            const user = state.users.find((entry) => entry.id === recovery.userId && entry.status === "active");
            if (!user) throw new Error("IDENTITY_RESET_INVALID");
            user.password = passwordHash(password);
            this.clearLoginFailures(state, user);
            user.mfaSecret = this.encrypt(secret);
            user.mfaEnabled = false;
            user.mfaPending = true;
            user.mfaCounter = -1;
            user.recoveryCodes = [];
            state.resets = state.resets.filter((entry) => entry !== recovery);
            for (const session of state.sessions) if (session.userId === user.id) session.revoked = true;
            const session = this.newSession(user, "mfa_setup");
            state.sessions.push(session.record);
            return { user: this.publicUser(user), sessionToken: session.raw, csrf: session.csrf, totpSecret: secret };
        });
    }

    resetPassword(value, password) {
        if (!passwordValid(password)) throw new Error("IDENTITY_PASSWORD_POLICY");
        return this.mutate("password_reset", "PASSWORD_RESET_COMPLETED", {}, (state) => {
            const reset = state.resets.find(
                (entry) =>
                    entry.kind === "password_reset" && entry.expires > now() && this.matches(value, entry.digest),
            );
            if (!reset) throw new Error("IDENTITY_RESET_INVALID");
            const user = state.users.find((entry) => entry.id === reset.userId && entry.status === "active");
            if (!user) throw new Error("IDENTITY_RESET_INVALID");
            user.password = passwordHash(password);
            this.clearLoginFailures(state, user);
            state.resets = state.resets.filter((entry) => entry !== reset);
            for (const session of state.sessions) if (session.userId === user.id) session.revoked = true;
            return true;
        });
    }

    issueServiceAccount(actor, name, scopes) {
        if (
            typeof name !== "string" ||
            !name.trim() ||
            name.length > 160 ||
            !Array.isArray(scopes) ||
            scopes.length === 0 ||
            scopes.some((scope) => !["modelling.read", "modelling.write"].includes(scope))
        )
            throw new Error("IDENTITY_SERVICE_ACCOUNT_INVALID");
        const value = token("svc_");
        return this.mutate(actor, "SERVICE_ACCOUNT_CREATED", { name, scopes: [...new Set(scopes)] }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            const account = {
                id: randomUUID(),
                name: name.trim(),
                scopes: [...new Set(scopes)],
                digest: hash(value),
                created: new Date().toISOString(),
                revoked: false,
            };
            state.serviceAccounts.push(account);
            return {
                account: { id: account.id, name: account.name, scopes: account.scopes, created: account.created },
                token: value,
            };
        });
    }

    authenticateServiceAccount(value) {
        if (typeof value !== "string") return null;
        const account = this.read().serviceAccounts.find(
            (entry) => !entry.revoked && this.matches(value, entry.digest),
        );
        return account ? { id: account.id, name: account.name, scopes: [...account.scopes], human: false } : null;
    }

    revokeServiceAccount(actor, id) {
        return this.mutate(actor, "SERVICE_ACCOUNT_REVOKED", { id }, (state) => {
            if (!this.isAdmin(state, actor)) throw new Error("IDENTITY_ADMIN_REQUIRED");
            const account = state.serviceAccounts.find((entry) => entry.id === id);
            if (!account) throw new Error("IDENTITY_SERVICE_ACCOUNT_NOT_FOUND");
            account.revoked = true;
            return true;
        });
    }

    adminRole(actor, userId) {
        const user = this.read().users.find((entry) => entry.id === userId);
        if (!user || user.status !== "active") return false;
        return this.read().users.some(
            (entry) =>
                entry.id === actor && entry.status === "active" && entry.roles.includes("modelling-administrator"),
        );
    }

    auditSummary(state = this.read()) {
        return {
            count: state.audit.length,
            head: state.audit.at(-1)?.hash || "0".repeat(64),
            events: state.audit.slice(-100),
        };
    }

    validateIdentityInput(username, displayName, password) {
        if (
            !usernameValid(username) ||
            typeof displayName !== "string" ||
            !displayName.trim() ||
            displayName.length > 160 ||
            !passwordValid(password)
        )
            throw new Error("IDENTITY_USER_INPUT_INVALID");
    }

    newUser(username, displayName, password, roleList, email = null) {
        this.assertRoles(roleList);
        const lower = username.toLowerCase();
        if (
            !usernameValid(username) ||
            !displayName.trim() ||
            displayName.length > 160 ||
            (email !== null && !this.validEmail(email)) ||
            this.read().users.some((user) => user.username === lower)
        )
            throw new Error("IDENTITY_USER_INPUT_INVALID");
        return {
            id: randomUUID(),
            username: lower,
            displayName: displayName.trim(),
            email,
            password: passwordHash(password),
            roles: [...new Set(roleList)],
            status: "active",
            created: new Date().toISOString(),
            mfaEnabled: false,
            mfaPending: false,
            mfaCounter: -1,
            recoveryCodes: [],
            projectScopes: [],
        };
    }

    newSession(user, kind) {
        const raw = token("ses_");
        const csrf = token("csrf_");
        return {
            raw,
            csrf,
            record: {
                digest: hash(raw),
                csrfEncrypted: this.encrypt(csrf),
                userId: user.id,
                kind,
                created: now(),
                expires: now() + this.sessionSeconds * 1000,
                revoked: false,
            },
        };
    }

    publicUser(user) {
        return {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            roles: [...user.roles],
            isOwner: !!user.isOwner,
            permissions: [...(user.permissions || [])],
            status: user.status,
            created: user.created,
            mfaEnabled: user.mfaEnabled,
            mfaPending: user.mfaPending,
            loginLocked: !!user.loginLocked,
        };
    }

    assertRoles(list) {
        if (!Array.isArray(list) || list.length === 0 || list.length > 5 || list.some((role) => !roles.has(role)))
            throw new Error("IDENTITY_ROLES_INVALID");
    }
    isAdmin(state, id) {
        return state.users.some(
            (user) => user.id === id && user.status === "active" && user.roles.includes("modelling-administrator"),
        );
    }
    requireAdmin(state) {
        if (!state.users.some((user) => user.status === "active" && user.roles.includes("modelling-administrator")))
            throw new Error("IDENTITY_LAST_ADMIN_REQUIRED");
    }
    validEmail(value) {
        return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }
    matches(value, digest) {
        return (
            typeof value === "string" &&
            typeof digest === "string" &&
            Buffer.byteLength(hash(value)) === Buffer.byteLength(digest) &&
            timingSafeEqual(Buffer.from(hash(value)), Buffer.from(digest))
        );
    }

    encrypt(value) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
    }
    decrypt(value) {
        const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
        const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    }
    verifyTotp(secret, value, previousCounter = -1) {
        if (typeof value !== "string" || !/^\d{6}$/.test(value)) return false;
        const current = Math.floor(Date.now() / 30000);
        for (const counter of [current - 1, current, current + 1]) {
            if (counter <= previousCounter) continue;
            const candidate = totp(decodeBase32(secret), counter);
            if (equal(value, candidate)) return counter;
        }
        return false;
    }
    consumeMfa(user, otp, recoveryCode) {
        if (otp) {
            const counter = this.verifyTotp(this.decrypt(user.mfaSecret), otp, user.mfaCounter);
            if (counter !== false) {
                user.mfaCounter = counter;
                return true;
            }
        }
        if (recoveryCode) {
            const index = user.recoveryCodes.findIndex((digest) => this.matches(recoveryCode, digest));
            if (index >= 0) {
                user.recoveryCodes.splice(index, 1);
                return true;
            }
        }
        return false;
    }
}
