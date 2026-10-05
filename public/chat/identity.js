"use strict";
const $ = (id) => document.getElementById(id);
const roles = [
    ["modelling-administrator", "Administrator"],
    ["modelling-modeller", "Modeller"],
    ["modelling-reviewer", "Reviewer"],
    ["modelling-approver", "Approver"],
    ["modelling-publisher", "Publisher"],
];
let session = null;
const query = new URLSearchParams(location.hash.slice(1));
function notice(message, admin = false) {
    const target = $(admin ? "identity-admin-notice" : "identity-auth-notice");
    if (target) target.textContent = message || "";
}
async function post(path, data) {
    const response = await fetch("/chat/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.csrf ? { "X-CSRF-Token": session.csrf } : {}) },
        body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}
async function adminRequest(path, method = "GET", data = undefined) {
    const response = await fetch("/chat/api/identity/" + path, {
        method,
        headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-CSRF-Token": session?.csrf || "" },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    if (response.status === 401) document.dispatchEvent(new Event("workspace:session-expired"));
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}
function clearMfaSetup() {
    $("mfa-qr").removeAttribute("src");
    $("mfa-qr").hidden = true;
    $("mfa-qr-error").hidden = true;
    $("mfa-manual").open = false;
    $("otp-auth-link").removeAttribute("href");
    $("totp-secret").textContent = "";
    $("mfa-code").value = "";
}
$("mfa-qr").addEventListener("error", () => {
    if (!$("mfa-qr").hasAttribute("src")) return;
    $("mfa-qr").hidden = true;
    $("mfa-qr-error").hidden = false;
    $("mfa-manual").open = true;
});
function showOnly(formId) {
    const entry = formId === "local-login" || formId === "owner-home";
    $("account-entry-options").hidden = !entry;
    $("signup-prompt").hidden = !entry || !session?.signupEnabled || session?.identitySetupRequired;
    const titles = {
        "local-login": "Welcome back",
        "owner-home": "Welcome to your workspace",
        "signup-form": "Create an account",
        "owner-bootstrap": "Set up your workspace",
        "code-recovery-form": "Recover your account",
        "account-recovery": "Recover your account",
        "password-reset": "Reset your password",
        "invite-accept": "Join your workspace",
        "mfa-enrollment": "Secure your account",
        "recovery-codes": "Save your recovery codes",
    };
    $("account-dialog-title").textContent = titles[formId] || "Workspace account";
    if (formId !== "mfa-enrollment") clearMfaSetup();
    for (const id of [
        "local-login",
        "signup-form",
        "code-recovery-form",
        "owner-bootstrap",
        "invite-accept",
        "password-reset",
        "account-recovery",
        "mfa-enrollment",
        "recovery-codes",
    ])
        $(id).hidden = id !== formId;
}
function setupMfa(result) {
    session = { ...(session || {}), ...result, mfaSetupRequired: true };
    authCsrf(result.csrf);
    if ($("otp-auth-link").getAttribute("href") !== result.otpAuthUrl) {
        clearMfaSetup();
        $("mfa-qr").hidden = false;
        $("mfa-qr").src = "/chat/auth/mfa-qr";
    }
    $("otp-auth-link").href = result.otpAuthUrl;
    $("totp-secret").textContent = result.totpSecret;
    showOnly("mfa-enrollment");
    openAccountDialog();
    notice("Keep the setup page private while you enroll your authenticator.");
}
function authCsrf(value) {
    session = { ...(session || {}), csrf: value };
}
function clearTokenFromUrl() {
    for (const key of ["invite", "reset", "recovery"]) query.delete(key);
    history.replaceState(null, "", location.pathname + "#chat");
}
function field(label, type, value = "") {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    input.readOnly = type === "text";
    wrapper.append(input);
    return { wrapper, input };
}
function button(label, action, className = "secondary-button") {
    const control = document.createElement("button");
    control.type = "button";
    control.className = className;
    control.textContent = label;
    control.onclick = action;
    return control;
}
function linkResult(token, kind) {
    const url = new URL("/chat/", location.origin);
    url.hash = kind + "=" + encodeURIComponent(token);
    revealOneTimeValue(url.href, "One-time link");
}
function revealOneTimeValue(value, label) {
    document.querySelector("label[for='identity-link']").textContent = label;
    $("identity-link").value = value;
    $("identity-link-result").hidden = false;
}
async function loadAdmin() {
    try {
        const data = await adminRequest("users");
        $("owner-signup-settings").hidden = !session?.access?.owner;
        $("allow-signup").checked = data.signupEnabled !== false;
        renderUsers(data.users);
        renderServices(data.serviceAccounts || []);
        renderAudit(data.audit?.events || []);
    } catch (error) {
        notice(error.message, true);
    }
}
function renderUsers(users) {
    const root = $("identity-users");
    root.replaceChildren();
    for (const user of users) {
        const row = document.createElement("article");
        row.className = "identity-user";
        const heading = document.createElement("div");
        heading.className = "identity-user-heading";
        const title = document.createElement("strong");
        title.textContent = user.displayName + " · " + user.username + (user.isOwner ? " · Platform owner" : "");
        const state = document.createElement("span");
        state.textContent =
            user.status +
            (user.loginLocked ? " · Sign-in locked" : "") +
            (user.mfaEnabled ? " · MFA" : " · MFA setup pending");
        heading.append(title, state);
        const email = document.createElement("p");
        email.textContent = user.email || "No email address";
        const fieldset = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = "Roles";
        fieldset.append(legend);
        const selectedRoles = new Set(user.roles);
        for (const [role, label] of roles) {
            const item = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = role;
            checkbox.checked = selectedRoles.has(role);
            item.append(checkbox, document.createTextNode(" " + label));
            fieldset.append(item);
        }
        row.append(heading, email, fieldset);
        if (!session?.access?.owner && (user.isOwner || user.permissions?.length)) fieldset.disabled = true;
        if (session?.access?.owner && !user.isOwner) {
            const permissions = document.createElement("fieldset");
            const legend = document.createElement("legend");
            legend.textContent = "Shared workspace permissions";
            permissions.append(legend);
            for (const [value, title] of [
                ["use-global-connections", "Use shared AI connections and repositories"],
                ["manage-global-providers", "Manage shared AI connections"],
                ["manage-global-repositories", "Manage shared repositories and sources"],
            ]) {
                const label = document.createElement("label"),
                    input = document.createElement("input");
                input.type = "checkbox";
                input.value = value;
                input.checked = user.permissions?.includes(value);
                label.append(input, document.createTextNode(" " + title));
                permissions.append(label);
            }
            permissions.append(
                button("Save shared permissions", async () => {
                    try {
                        await adminRequest("users/" + user.id + "/permissions", "PUT", {
                            permissions: [...permissions.querySelectorAll("input:checked")].map((input) => input.value),
                        });
                        notice("Permissions saved. The user must sign in again.", true);
                        await loadAdmin();
                    } catch (error) {
                        notice(error.message, true);
                    }
                }),
            );
            row.append(permissions);
        }
        const actions = document.createElement("div");
        actions.className = "identity-actions";
        actions.append(
            button("Save roles", async () => {
                try {
                    const selected = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
                    await adminRequest("users/" + user.id + "/roles", "PUT", { roles: selected });
                    notice("Roles updated; affected sessions were revoked.", true);
                    await loadAdmin();
                } catch (error) {
                    notice(error.message, true);
                }
            }),
        );
        actions.append(
            button("Reset password", async () => {
                try {
                    const result = await adminRequest("users/" + user.id + "/reset", "POST", {});
                    linkResult(result.token, "reset");
                    notice(
                        "Password reset link created. Deliver it through your approved channel; email was not sent.",
                        true,
                    );
                } catch (error) {
                    notice(error.message, true);
                }
            }),
        );
        actions.append(
            button("Recover account", async () => {
                try {
                    const result = await adminRequest("users/" + user.id + "/recovery", "POST", {});
                    linkResult(result.token, "recovery");
                    notice(
                        "Account recovery link created. It resets MFA and requires new enrollment; deliver it through your approved channel.",
                        true,
                    );
                } catch (error) {
                    notice(error.message, true);
                }
            }),
        );
        actions.append(
            button("Revoke sessions", async () => {
                try {
                    await adminRequest("users/" + user.id + "/sessions", "DELETE");
                    notice("Sessions revoked.", true);
                } catch (error) {
                    notice(error.message, true);
                }
            }),
        );
        if (user.status === "active" && !user.isOwner)
            actions.append(
                button("Disable user", async () => {
                    try {
                        await adminRequest("users/" + user.id + "/disable", "POST", {});
                        notice("User disabled and sessions revoked.", true);
                        await loadAdmin();
                    } catch (error) {
                        notice(error.message, true);
                    }
                }),
            );
        if (!session?.access?.owner && (user.isOwner || user.permissions?.length))
            for (const control of actions.querySelectorAll("button")) control.disabled = true;
        row.append(actions);
        root.append(row);
    }
}
function renderServices(accounts) {
    const root = $("identity-services");
    root.replaceChildren();
    for (const account of accounts) {
        const row = document.createElement("div");
        row.className = "identity-service";
        const summary = document.createElement("span");
        summary.textContent =
            account.name + " · " + account.scopes.join(", ") + (account.revoked ? " · revoked" : " · active");
        row.append(summary);
        if (!account.revoked)
            row.append(
                button("Revoke", async () => {
                    try {
                        await adminRequest("service-accounts/" + account.id, "DELETE");
                        await loadAdmin();
                        notice("Service credential revoked.", true);
                    } catch (error) {
                        notice(error.message, true);
                    }
                }),
            );
        root.append(row);
    }
    if (!accounts.length) root.textContent = "No service credentials.";
}
function renderAudit(events) {
    const root = $("identity-audit");
    root.replaceChildren();
    for (const event of [...events].reverse()) {
        const row = document.createElement("li");
        row.textContent = `${event.timestamp} · ${event.action} · ${JSON.stringify(event.details)}`;
        root.append(row);
    }
}
function openAccountDialog() {
    const dialog = $("account-dialog");
    if (!dialog.open) dialog.showModal();
    const form = [...dialog.querySelectorAll(".identity-form")].find((item) => !item.hidden);
    (
        form?.querySelector("input, button") || (!$("oidc-login").hidden ? $("oidc-login") : $("show-owner-setup"))
    )?.focus();
}
function closeAccountDialog() {
    if (!$("recovery-codes").hidden) {
        notice("Save your recovery codes, then choose I saved these codes to continue.");
        return;
    }
    $("account-dialog").close();
    for (const input of $("account-dialog").querySelectorAll(
        'input[type="password"], #local-code, #code-recovery-code, #bootstrap-token',
    ))
        input.value = "";
    clearMfaSetup();
}
$("close-account-dialog").onclick = closeAccountDialog;
$("account-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAccountDialog();
});
document.addEventListener("workspace:open-account", () => {
    $("oidc-login").href =
        document.body.dataset.section === "governance" ? "/chat/auth/login?review=1" : "/chat/auth/login";
    if (session?.mfaSetupRequired) setupMfa(session);
    openAccountDialog();
});
function update(value) {
    const previous = session;
    session = value;
    const admin =
        value.authenticated && value.identityEnabled && value.user?.roles?.includes("modelling-administrator");
    $("tab-accounts").hidden = !admin;
    $("oidc-login").hidden = value.identityEnabled && !value.oidcEnabled;
    $("oidc-login").href =
        document.body.dataset.section === "governance" ? "/chat/auth/login?review=1" : "/chat/auth/login";
    $("show-owner-setup").hidden = !value.identitySetupRequired;
    if (value.mfaSetupRequired) {
        // Do not interrupt a form being filled or reopen a dismissed window on each refresh.
        if (!previous?.mfaSetupRequired || previous.otpAuthUrl !== value.otpAuthUrl) setupMfa(value);
        return;
    }
    if (value.authenticated) {
        clearMfaSetup();
        if ($("recovery-codes").hidden) $("account-dialog").close();
        if (admin && document.body.dataset.section === "accounts") loadAdmin();
        return;
    }
    const sameSignIn =
        previous &&
        !previous.authenticated &&
        !previous.mfaSetupRequired &&
        previous.identitySetupRequired === value.identitySetupRequired &&
        previous.identityEnabled === value.identityEnabled;
    if (sameSignIn && $("account-dialog").open) return;
    if (query.has("invite") || query.has("reset") || query.has("recovery")) {
        showOnly(query.has("invite") ? "invite-accept" : query.has("reset") ? "password-reset" : "account-recovery");
        openAccountDialog();
    } else {
        showOnly(value.identitySetupRequired ? "owner-home" : "local-login");
        $("local-login").hidden = !value.identityEnabled || !!value.identitySetupRequired;
    }
}
$("local-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("local-code").value.trim();
    try {
        await post("auth/local", {
            username: $("local-username").value,
            password: $("local-password").value,
            ...(code ? (/^\d{6}$/.test(code) ? { otp: code } : { recoveryCode: code }) : {}),
        });
        location.reload();
    } catch (error) {
        notice(error.message);
    }
});
$("owner-bootstrap").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/bootstrap", {
            token: $("bootstrap-token").value,
            username: $("bootstrap-username").value,
            displayName: $("bootstrap-name").value,
            password: $("bootstrap-password").value,
        });
        setupMfa(result);
    } catch (error) {
        notice(error.message);
    }
});
$("invite-accept").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/invitations/accept", {
            token: query.get("invite"),
            username: $("invite-username").value,
            displayName: $("invite-name").value,
            password: $("invite-password").value,
        });
        clearTokenFromUrl();
        setupMfa(result);
    } catch (error) {
        notice(error.message);
    }
});
$("password-reset").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        await post("auth/password-reset", { token: query.get("reset"), password: $("reset-password").value });
        clearTokenFromUrl();
        notice("Password reset. Sign in with your new password and existing MFA.");
        $("password-reset").hidden = true;
        $("local-login").hidden = false;
    } catch (error) {
        notice(error.message);
    }
});
$("account-recovery").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/account-recovery", {
            token: query.get("recovery"),
            password: $("recovery-password").value,
        });
        clearTokenFromUrl();
        setupMfa(result);
    } catch (error) {
        notice(error.message);
    }
});
$("mfa-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/mfa", { code: $("mfa-code").value });
        session = { ...session, mfaSetupRequired: false, authenticated: true };
        authCsrf(result.csrf);
        $("recovery-code-list").textContent = result.recoveryCodes.join("\n");
        showOnly("recovery-codes");
        notice("Multi-factor authentication is active.");
    } catch (error) {
        notice(error.message);
    }
});
$("finish-recovery-codes").onclick = () => location.reload();
$("invite-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const selected = [...document.querySelectorAll("input[name='invite-role']:checked")].map(
            (input) => input.value,
        );
        const result = await adminRequest("invitations", "POST", { email: $("new-user-email").value, roles: selected });
        linkResult(result.token, "invite");
        $("new-user-email").value = "";
        notice("Invitation link created. Deliver it through your approved channel; email was not sent.", true);
        await loadAdmin();
    } catch (error) {
        notice(error.message, true);
    }
});
$("service-account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        const scopes = [...document.querySelectorAll("input[name='service-scope']:checked")].map(
            (input) => input.value,
        );
        const result = await adminRequest("service-accounts", "POST", {
            name: $("service-account-name").value,
            scopes,
        });
        $("service-account-name").value = "";
        const token = result.token;
        revealOneTimeValue(token, "One-time service credential");
        notice(
            "Credential created. Copy it now; it will not be shown again. Service credentials cannot approve reviews.",
            true,
        );
        await loadAdmin();
    } catch (error) {
        notice(error.message, true);
    }
});
$("copy-identity-link").onclick = () =>
    navigator.clipboard
        .writeText($("identity-link").value)
        .then(() => notice("Copied.", true))
        .catch(() => notice("Copy is unavailable in this browser.", true));
document.addEventListener("workspace:session", (event) => update(event.detail));
document.addEventListener("workspace:accounts", loadAdmin);
fetch("/chat/api/session")
    .then((response) => response.json())
    .then(update)
    .catch(() => {});

$("show-signup").onclick = () => {
    showOnly("signup-form");
    $("signup-name").focus();
};
function backToSignIn() {
    notice("");
    showOnly(session?.identitySetupRequired ? "owner-home" : "local-login");
    $("local-login").hidden = !session?.identityEnabled || !!session?.identitySetupRequired;
    openAccountDialog();
}
$("back-to-signin").onclick = backToSignIn;
$("owner-back-to-signin").onclick = backToSignIn;
$("show-owner-setup").onclick = () => {
    showOnly("owner-bootstrap");
    openAccountDialog();
};
$("signup-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/signup", {
            username: $("signup-username").value,
            displayName: $("signup-name").value,
            password: $("signup-password").value,
        });
        $("signup-password").value = "";
        setupMfa(result);
    } catch (error) {
        notice(error.message);
    }
};
$("save-signup-settings").onclick = async () => {
    try {
        await adminRequest("signup", "PUT", { enabled: $("allow-signup").checked });
        notice("Registration setting saved.", true);
    } catch (error) {
        notice(error.message, true);
    }
};

$("show-code-recovery").onclick = () => {
    showOnly("code-recovery-form");
    $("code-recovery-username").value = $("local-username").value;
    $("code-recovery-code").focus();
    notice("");
};
$("recovery-back-to-signin").onclick = backToSignIn;
$("code-recovery-form").onsubmit = async (event) => {
    event.preventDefault();
    try {
        const result = await post("auth/recovery-code", {
            username: $("code-recovery-username").value,
            recoveryCode: $("code-recovery-code").value.trim(),
            password: $("code-recovery-password").value,
        });
        $("code-recovery-code").value = "";
        $("code-recovery-password").value = "";
        setupMfa(result);
    } catch (error) {
        notice(error.message);
    }
};
