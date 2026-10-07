import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IdentityStore } from "../src/identity-store.mjs";

const password = "A-long-test-password-2026!";
const encryptionKey = "ab".repeat(32);
function code(secret) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let buffer = 0,
        bits = 0;
    const bytes = [];
    for (const char of secret) {
        buffer = (buffer << 5) | alphabet.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
    const offset = digest.at(-1) & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "identity-test-"));
    const store = new IdentityStore(directory, { issuer: "https://example.test/identity/local", encryptionKey });
    return { directory, store, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("one-time bootstrap, MFA enrollment, persistent login and logout revocation", async (t) => {
    const { store, close } = fixture();
    t.after(close);
    const bootstrap = store.bootstrapToken();
    const owner = store.bootstrap(bootstrap, "owner.admin", "Workspace Owner", password);
    assert.throws(() => store.bootstrapToken(), /IDENTITY_OWNER_ALREADY_EXISTS/);
    assert.equal(store.localSession(owner.sessionToken), null);
    const enrolled = store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    assert.equal(enrolled.recoveryCodes.length, 10);
    assert.notEqual(store.localSession(owner.sessionToken), null);
    assert.equal(store.localSession(owner.sessionToken).reviewIdentity.issuer, "https://example.test/identity/local");

    const login = await store.login("owner.admin", password, null, enrolled.recoveryCodes[0], "127.0.0.1");
    const restarted = new IdentityStore(store.directory, {
        issuer: "https://example.test/identity/local",
        encryptionKey,
    });
    assert.notEqual(restarted.localSession(login.sessionToken), null);
    restarted.revokeSession(login.sessionToken);
    assert.equal(restarted.localSession(login.sessionToken), null);
});

test("invitation is single-use and account recovery codes are one-use", async (t) => {
    const { store, close } = fixture();
    t.after(close);
    const bootstrap = store.bootstrapToken();
    const owner = store.bootstrap(bootstrap, "owner.admin", "Workspace Owner", password);
    store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    const invitation = store.invite(owner.user.id, "modeller@example.test", ["modelling-modeller"]);
    const member = store.acceptInvite(invitation.token, "model.author", "Model Author", password);
    assert.throws(
        () => store.acceptInvite(invitation.token, "model.other", "Another Author", password),
        /IDENTITY_INVITATION_INVALID/,
    );
    const recovery = store.verifyMfaSetup(member.sessionToken, code(member.totpSecret)).recoveryCodes[0];
    const recovered = await store.login("model.author", password, null, recovery, "127.0.0.1");
    assert.ok(recovered.sessionToken);
    await assert.rejects(store.login("model.author", password, null, recovery, "127.0.0.1"), /IDENTITY_LOGIN_INVALID/);
});

test("last administrator cannot be removed and audit chain detects tampering", (t) => {
    const { store, directory, close } = fixture();
    t.after(close);
    const bootstrap = store.bootstrapToken();
    const owner = store.bootstrap(bootstrap, "owner.admin", "Workspace Owner", password);
    assert.throws(
        () => store.setRoles(owner.user.id, owner.user.id, ["modelling-modeller"]),
        /IDENTITY_LAST_ADMIN_REQUIRED/,
    );
    const path = join(directory, "identity.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.audit[0].action = "TAMPERED";
    writeFileSync(path, JSON.stringify(state));
    assert.throws(() => store.read(), /IDENTITY_AUDIT_CHAIN_INVALID/);
});

test("MFA setup attempts are persisted and capped", (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Workspace Owner", password);
    for (let attempt = 0; attempt < 8; attempt++)
        assert.throws(() => store.verifyMfaSetup(owner.sessionToken, "000000"), /IDENTITY_MFA_INVALID/);
    assert.throws(() => store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret)), /IDENTITY_MFA_INVALID/);
    assert.equal(store.localSession(owner.sessionToken), null);
});

test("password reset, MFA recovery and service credentials remain scoped and non-human", async (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Workspace Owner", password);
    const enrolled = store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    const invitation = store.invite(owner.user.id, "modeller@example.test", ["modelling-modeller"]);
    const member = store.acceptInvite(invitation.token, "model.author", "Model Author", password);
    store.verifyMfaSetup(member.sessionToken, code(member.totpSecret));

    const reset = store.inviteReset(owner.user.id, member.user.id);
    assert.equal(store.resetPassword(reset.token, "A-new-and-different-password-2026!"), true);
    await assert.rejects(store.login("model.author", password, null, null, "reset-check"), /IDENTITY_LOGIN_INVALID/);

    const recovery = store.issueAccountRecovery(owner.user.id, member.user.id);
    const recovered = store.completeAccountRecovery(recovery.token, "A-recovery-password-2026!");
    assert.equal(store.localSession(recovered.sessionToken), null);
    store.verifyMfaSetup(recovered.sessionToken, code(recovered.totpSecret));

    const credential = store.issueServiceAccount(owner.user.id, "Build agent", ["modelling.read"]);
    assert.equal(store.authenticateServiceAccount(credential.token).human, false);
    assert.deepEqual(store.authenticateServiceAccount(credential.token).scopes, ["modelling.read"]);
    store.revokeServiceAccount(owner.user.id, credential.account.id);
    assert.equal(store.authenticateServiceAccount(credential.token), null);
    assert.ok(enrolled.recoveryCodes.length === 10);
});

test("active local sessions renew without extending authentication age or reviving revoked sessions", (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Owner", password);
    assert.equal(store.renewSession(owner.sessionToken), null, "MFA setup cannot be renewed");
    store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    const initial = store.localSession(owner.sessionToken);
    const expires = store.renewSession(owner.sessionToken);
    assert(expires >= initial.expires);
    assert.equal(store.localSession(owner.sessionToken).reviewIdentity.started, initial.reviewIdentity.started);
    store.revokeSession(owner.sessionToken);
    assert.equal(store.renewSession(owner.sessionToken), null);
});

test("five failures persist across restarts and recovery codes unlock without email", async (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Owner", password);
    const codes = store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret)).recoveryCodes;
    for (let attempt = 1; attempt <= 5; attempt++) {
        for (const username of ["owner.admin", "unknown.user"]) {
            await assert.rejects(store.login(username, "wrong", null, null, "ip-" + attempt), (error) => {
                assert.deepEqual(error.login, {
                    failedAttempts: attempt,
                    remainingAttempts: 5 - attempt,
                    locked: attempt === 5,
                });
                return true;
            });
        }
    }
    const restarted = new IdentityStore(store.directory, { issuer: store.issuer, encryptionKey });
    await assert.rejects(
        restarted.login("owner.admin", password, null, codes[0], "new-ip"),
        (error) => error.login.locked,
    );
    assert.equal(restarted.listUsers(owner.user.id).users[0].loginLocked, true);
    assert.throws(() => restarted.recoverWithCode("owner.admin", "incorrect-code", password), /RESET_INVALID/);
    const recovered = restarted.recoverWithCode("owner.admin", codes[0], "New-recovery-password-2026!");
    assert.equal(restarted.localSession(owner.sessionToken), null);
    assert.equal(restarted.localSession(recovered.sessionToken), null, "MFA enrollment is mandatory");
    assert.throws(() => restarted.recoverWithCode("owner.admin", codes[0], password), /RESET_INVALID/);
    const refreshed = restarted.verifyMfaSetup(recovered.sessionToken, code(recovered.totpSecret));
    assert.equal(refreshed.recoveryCodes.length, 10);
    assert.throws(() => restarted.recoverWithCode("owner.admin", codes[1], password), /RESET_INVALID/);
    assert.ok(
        (
            await restarted.login(
                "owner.admin",
                "New-recovery-password-2026!",
                null,
                refreshed.recoveryCodes[0],
                "new-ip",
            )
        ).sessionToken,
    );
    assert.equal(restarted.read().users[0].loginLocked, false);
});

test("successful login clears failures and failed MFA never produces success audit", async (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Owner", password);
    const codes = store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret)).recoveryCodes;
    await assert.rejects(
        store.login("owner.admin", password, null, "bad-code", "ip"),
        (error) => error.login.failedAttempts === 1,
    );
    assert.equal(store.read().audit.filter((event) => event.action === "USER_LOGIN_SUCCEEDED").length, 0);
    await store.login("owner.admin", password, null, codes[0], "ip");
    await assert.rejects(
        store.login("owner.admin", "wrong", null, null, "ip"),
        (error) => error.login.failedAttempts === 1,
    );
    assert.equal(store.read().audit.filter((event) => event.action === "USER_LOGIN_SUCCEEDED").length, 1);
});

test("signup requires completed owner setup and cannot inherit or delegate shared privileges", (t) => {
    const { store, close } = fixture();
    t.after(close);
    assert.throws(() => store.signup("alice", "Alice", password, "ip"), /SIGNUP_CLOSED/);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Owner", password);
    assert.throws(() => store.signup("alice", "Alice", password, "ip"), /SIGNUP_CLOSED/);
    store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    const member = store.signup("alice", "Alice", password, "ip");
    assert.deepEqual(member.user.permissions, []);
    assert.deepEqual(member.user.roles, ["modelling-modeller"]);
    assert.equal(store.localSession(member.sessionToken), null);
    store.verifyMfaSetup(member.sessionToken, code(member.totpSecret));
    assert.throws(
        () => store.setPermissions(member.user.id, member.user.id, ["use-global-connections"]),
        /OWNER_REQUIRED/,
    );
    store.setPermissions(owner.user.id, member.user.id, ["use-global-connections"]);
    assert.equal(store.localSession(member.sessionToken), null);
    store.setSignup(owner.user.id, false);
    assert.throws(() => store.signup("bob", "Bob", password, "ip2"), /SIGNUP_CLOSED/);
    store.setSignup(owner.user.id, true);
    const admin = store.signup("second.admin", "Admin", password, "ip2");
    store.verifyMfaSetup(admin.sessionToken, code(admin.totpSecret));
    store.setRoles(owner.user.id, admin.user.id, ["modelling-administrator"]);
    for (const target of [owner.user.id, member.user.id]) {
        assert.throws(() => store.inviteReset(admin.user.id, target), /OWNER_REQUIRED/);
        assert.throws(() => store.issueAccountRecovery(admin.user.id, target), /OWNER_REQUIRED/);
        assert.throws(() => store.setRoles(admin.user.id, target, ["modelling-administrator"]), /OWNER_REQUIRED/);
    }
    assert.throws(() => store.disableUser(owner.user.id, owner.user.id), /LAST_ADMIN_REQUIRED/);
    store.mutate("test", null, {}, (state) => {
        delete state.ownerId;
    });
    assert.equal(store.read().ownerId, owner.user.id, "migration keeps bootstrap owner");
});

test("server operator recovery preserves owner identity, expires and supersedes earlier links", (t) => {
    const { store, close } = fixture();
    t.after(close);
    const owner = store.bootstrap(store.bootstrapToken(), "owner.admin", "Owner", password);
    store.verifyMfaSetup(owner.sessionToken, code(owner.totpSecret));
    const old = store.operatorOwnerRecovery(),
        current = store.operatorOwnerRecovery();
    assert.throws(() => store.completeAccountRecovery(old, password), /RESET_INVALID/);
    const recovered = store.completeAccountRecovery(current, "Operator-reset-password-2026!");
    assert.equal(recovered.user.id, owner.user.id);
    assert.equal(store.localSession(owner.sessionToken), null);
    assert.equal(store.read().audit.find((event) => event.action === "OWNER_RECOVERY_ISSUED").actor, "server_operator");
    const expiring = store.operatorOwnerRecovery();
    store.mutate("test", null, {}, (state) => {
        state.resets.forEach((entry) => {
            entry.expires = 1;
        });
    });
    assert.throws(() => store.completeAccountRecovery(expiring, password), /RESET_INVALID/);
});
