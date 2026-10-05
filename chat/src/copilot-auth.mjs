import { PublicClientApplication } from "@azure/msal-node";
import { CopilotProvider } from "./copilot.mjs";
import { problem } from "./personal-http.mjs";

const scope = "https://api.powerplatform.com/.default";
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function copilotSettings(input) {
    const settings = Object.fromEntries(
        ["tenantId", "clientId", "environmentId", "schemaName"].map((key) => [
            key,
            typeof input?.[key] === "string" ? input[key].trim() : "",
        ]),
    );
    if (
        !guid.test(settings.tenantId) ||
        !guid.test(settings.clientId) ||
        !guid.test(settings.environmentId.replace(/^Default-/i, "")) ||
        !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(settings.schemaName)
    )
        throw problem(
            "Enter the tenant ID, application ID, environment ID and agent schema name from the setup guide.",
        );
    return settings;
}

// Microsoft sign-in is separate from workspace sign-in. Tokens never enter the
// browser, chat history, MCP tools or diagnostic logs.
export function microsoftAuth(settings, signal) {
    const request = async (url, options = {}, method) => {
        const target = new URL(url);
        if (target.origin !== "https://login.microsoftonline.com" || target.username || target.password)
            throw new Error("Unexpected Microsoft identity endpoint");
        const response = await fetch(target, {
            method,
            headers: options.headers,
            body: options.body,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        });
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body || []) {
            size += chunk.byteLength;
            if (size > 1048576) throw new Error("Identity response exceeded its limit");
            chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return { status: response.status, headers: Object.fromEntries(response.headers), body: JSON.parse(text) };
    };
    return new PublicClientApplication({
        auth: { clientId: settings.clientId, authority: "https://login.microsoftonline.com/" + settings.tenantId },
        system: {
            loggerOptions: { loggerCallback() {}, piiLoggingEnabled: false },
            networkClient: {
                sendGetRequestAsync: (url, options) => request(url, options, "GET"),
                sendPostRequestAsync: (url, options) => request(url, options, "POST"),
            },
        },
    });
}

const connectionError = () =>
    problem(
        "Microsoft connection failed or expired. Check the setup guide, tenant consent and agent access, then reconnect.",
        409,
    );

export class CopilotAccounts {
    constructor(
        config,
        store,
        { auth = microsoftAuth, provider = (settings, token) => new CopilotProvider(config, settings, token) } = {},
    ) {
        Object.assign(this, { config, store, auth, provider });
        this.logins = new Map();
        this.busy = new Set();
        this.errors = new Map();
    }
    status(identity) {
        const record = this.store?.get(identity, "copilot");
        const failure = this.errors.get(identity);
        if (failure && failure.expires < Date.now()) this.errors.delete(identity);
        return {
            id: "copilot",
            name: "Copilot Studio",
            connected: !!record,
            signingIn: this.logins.has(identity),
            ...(record ? { settings: record.credential.settings } : {}),
            ...(this.errors.has(identity) ? { error: this.errors.get(identity).message } : {}),
        };
    }
    async start(identity, input) {
        const settings = copilotSettings(input);
        if (
            this.logins.has(identity) ||
            this.busy.has(identity) ||
            this.logins.size >= (this.config.maxConcurrentTurns || 3)
        )
            throw problem("A Microsoft connection is already in progress. Please try again shortly.", 409);
        if (this.store.get(identity, "copilot"))
            throw problem("Disconnect Copilot Studio before changing its agent.", 409);
        this.errors.delete(identity);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 600000);
        const startup = setTimeout(() => controller.abort(), 30000);
        timeout.unref();
        startup.unref();
        let show, reject;
        const ready = new Promise((resolve, fail) => {
            show = resolve;
            reject = fail;
        });
        const client = this.auth(settings, controller.signal);
        const request = {
            scopes: [scope],
            timeout: 600,
            deviceCodeCallback: (code) => {
                if (controller.signal.aborted) return;
                if (
                    ![
                        "https://microsoft.com/devicelogin",
                        "https://www.microsoft.com/devicelogin",
                        "https://login.microsoftonline.com/common/oauth2/deviceauth",
                    ].includes(code.verificationUri) ||
                    !/^[A-Za-z0-9-]{4,32}$/.test(code.userCode || "")
                ) {
                    controller.abort();
                    reject(connectionError());
                    return;
                }
                clearTimeout(startup);
                show({ verificationUrl: code.verificationUri, userCode: code.userCode });
            },
        };
        controller.signal.addEventListener(
            "abort",
            () => {
                request.cancel = true;
                reject(connectionError());
            },
            { once: true },
        );
        const pending = { controller };
        this.logins.set(identity, pending);
        pending.done = (async () => {
            const result = await client.acquireTokenByDeviceCode(request);
            controller.signal.throwIfAborted();
            if (
                !result?.accessToken ||
                result.tenantId?.toLowerCase() !== settings.tenantId.toLowerCase() ||
                !result.account?.homeAccountId
            )
                throw connectionError();
            // Verify access to the published agent before reporting a connection.
            await this.provider(settings, result.accessToken).probe(controller.signal);
            if (!controller.signal.aborted && this.logins.get(identity) === pending)
                this.store.set(identity, "copilot", {
                    settings,
                    accountId: result.account.homeAccountId,
                    cache: client.getTokenCache().serialize(),
                });
        })()
            .catch(() => {
                if (this.logins.get(identity) === pending) {
                    if (this.errors.size >= 100) this.errors.delete(this.errors.keys().next().value);
                    this.errors.set(identity, { message: connectionError().message, expires: Date.now() + 900000 });
                }
                reject(connectionError());
            })
            .finally(() => {
                clearTimeout(timeout);
                clearTimeout(startup);
                if (this.logins.get(identity) === pending) this.logins.delete(identity);
            });
        return ready;
    }
    cancel(identity) {
        const pending = this.logins.get(identity);
        this.logins.delete(identity);
        pending?.controller.abort();
        this.errors.delete(identity);
    }
    async run(identity, options) {
        if (this.busy.has(identity) || this.logins.has(identity))
            throw problem("Your Copilot Studio connection is busy. Please retry shortly.", 409);
        const record = this.store.get(identity, "copilot");
        if (!record) throw connectionError();
        this.busy.add(identity);
        const { settings, accountId, cache } = record.credential;
        const client = this.auth(settings, options.signal);
        try {
            client.getTokenCache().deserialize(cache);
            let token;
            try {
                const account = (await client.getTokenCache().getAllAccounts()).find(
                    (item) => item.homeAccountId === accountId,
                );
                if (!account) throw connectionError();
                token = await client.acquireTokenSilent({ account, scopes: [scope] });
                if (!token?.accessToken || token.tenantId?.toLowerCase() !== settings.tenantId.toLowerCase())
                    throw connectionError();
            } catch {
                options.signal.throwIfAborted();
                throw connectionError();
            }
            options.signal.throwIfAborted();
            if (this.store.get(identity, "copilot")?.revision !== record.revision) throw connectionError();
            return await this.provider(settings, token.accessToken).run(options);
        } finally {
            try {
                if (this.store.get(identity, "copilot")?.revision === record.revision)
                    this.store.set(
                        identity,
                        "copilot",
                        { ...record.credential, cache: client.getTokenCache().serialize() },
                        record.revision,
                    );
            } finally {
                this.busy.delete(identity);
            }
        }
    }
    close() {
        for (const identity of this.logins.keys()) this.cancel(identity);
    }
}
