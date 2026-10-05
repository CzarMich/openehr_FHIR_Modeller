import { GLOBAL_IDENTITY } from "./access.mjs";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "./provider-store.mjs";
import { CodexProvider } from "./codex.mjs";
import { ClaudeProvider } from "./claude.mjs";
import { CopilotAccounts } from "./copilot-auth.mjs";

export class Providers {
    constructor(
        config,
        {
            store,
            codex = (settings) => new CodexProvider(settings),
            claude = (key) => new ClaudeProvider(config, key),
            copilot,
        } = {},
    ) {
        this.config = config;
        this.store =
            store ||
            (config.enabled
                ? new ProviderStore(join(config.dataDir, "providers"), config.providerEncryptionKey)
                : null);
        this.codex = codex;
        this.claude = claude;
        this.copilot = new CopilotAccounts(config, this.store, copilot);
        this.logins = new Map();
        this.busy = new Set();
    }
    credentialIdentity(identity, provider) {
        if (!["codex", "claude", "copilot"].includes(provider)) return identity;
        if (
            identity !== GLOBAL_IDENTITY &&
            !this.store?.get(identity, provider) &&
            this.canUseGlobal?.(identity) &&
            this.store?.get(GLOBAL_IDENTITY, provider)
        )
            return GLOBAL_IDENTITY;
        return identity;
    }
    status(identity) {
        const personal = [
            ...["codex", "claude"].map((id) => ({
                id,
                name: id === "codex" ? "Codex" : "Claude",
                connected: !!this.store?.get(identity, id),
                signingIn: id === "codex" && this.logins.has(identity),
            })),
            this.copilot.status(identity),
        ];
        if (identity === GLOBAL_IDENTITY) return personal;
        return personal.map((item) => {
            const shared = !!this.canUseGlobal?.(identity) && !!this.store?.get(GLOBAL_IDENTITY, item.id);
            return {
                ...item,
                personalConnected: item.connected,
                sharedAvailable: shared,
                connected: item.connected || shared,
                scope: item.connected ? "personal" : shared ? "global" : "personal",
            };
        });
    }
    connectCodexKey(identity, apiKey) {
        if (typeof apiKey !== "string" || !/^sk-[A-Za-z0-9_-]{20,500}$/.test(apiKey))
            throw Object.assign(new Error("Enter an OpenAI project API key."), { status: 400 });
        this.store.set(identity, "codex", { OPENAI_API_KEY: apiKey });
    }
    assertConnected(identity, provider) {
        identity = this.credentialIdentity(identity, provider);
        if (!["codex", "claude", "copilot"].includes(provider) || !this.store?.get(identity, provider))
            throw Object.assign(new Error("Connect your provider account before sending a message."), { status: 409 });
    }
    connectClaude(identity, apiKey) {
        if (typeof apiKey !== "string" || !/^sk-ant-[A-Za-z0-9_-]{20,500}$/.test(apiKey))
            throw Object.assign(new Error("Enter an Anthropic API key."), { status: 400 });
        this.store.set(identity, "claude", apiKey);
    }
    async startLogin(identity) {
        if (
            this.logins.has(identity) ||
            this.busy.has(identity) ||
            this.logins.size + this.busy.size >= (this.config.maxConcurrentTurns || 3)
        )
            throw Object.assign(new Error("A connection is already in progress. Please try again shortly."), {
                status: 409,
            });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
        timer.unref();
        const startup = setTimeout(() => controller.abort(), 30000);
        startup.unref();
        let show, reject;
        const ready = new Promise((resolve, fail) => {
            show = resolve;
            reject = fail;
        });
        const pending = { controller };
        this.logins.set(identity, pending);
        pending.done = this.withCodex(null, async (provider, directory) => {
            await provider.run({
                signal: controller.signal,
                onLogin: (result) => {
                    clearTimeout(startup);
                    if (
                        result.verificationUrl !== "https://auth.openai.com/codex/device" ||
                        !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode || "")
                    ) {
                        reject(new Error("Invalid provider sign-in response"));
                        controller.abort();
                        return;
                    }
                    show({ verificationUrl: result.verificationUrl, userCode: result.userCode });
                },
            });
            if (!controller.signal.aborted && this.logins.get(identity) === pending) {
                const credential = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"));
                this.store.set(identity, "codex", credential);
            }
        })
            .catch(() =>
                reject(Object.assign(new Error("Codex sign-in is unavailable. Please retry."), { status: 503 })),
            )
            .finally(() => {
                clearTimeout(timer);
                clearTimeout(startup);
                if (this.logins.get(identity) === pending) this.logins.delete(identity);
            });
        return ready;
    }
    cancelLogin(identity) {
        this.logins.get(identity)?.controller.abort();
        this.copilot.cancel(identity);
    }
    disconnect(identity, provider) {
        if (provider === "codex") this.logins.get(identity)?.controller.abort();
        if (provider === "copilot") this.copilot.cancel(identity);
        this.store.delete(identity, provider);
    }
    async withCodex(credential, operation) {
        const directory = mkdtempSync(join(tmpdir(), "modelling-codex-"));
        try {
            if (credential) writeFileSync(join(directory, "auth.json"), JSON.stringify(credential), { mode: 0o600 });
            return await operation(this.codex({ ...this.config, codexHome: directory }), directory);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }
    async run({ identity, provider, ...options }) {
        this.assertConnected(identity, provider);
        identity = this.credentialIdentity(identity, provider);
        const record = this.store.get(identity, provider);
        if (provider === "claude") return this.claude(record.credential).run(options);
        if (provider === "copilot") return this.copilot.run(identity, options);
        // API keys have no rotating refresh token and support concurrent isolated runtimes.
        if (record.credential.OPENAI_API_KEY) return this.withCodex(record.credential, (client) => client.run(options));
        // Serialize a user's Codex turns so refresh-token rotation cannot race itself.
        if (
            this.busy.has(identity) ||
            this.logins.has(identity) ||
            this.logins.size + this.busy.size >= (this.config.maxConcurrentTurns || 3)
        )
            throw new Error("Codex account is busy");
        this.busy.add(identity);
        try {
            return await this.withCodex(record.credential, async (client, directory) => {
                try {
                    return await client.run(options);
                } finally {
                    if (this.store.get(identity, provider)?.revision === record.revision) {
                        const refreshed = JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"));
                        this.store.set(identity, provider, refreshed, record.revision);
                    }
                }
            });
        } finally {
            this.busy.delete(identity);
        }
    }
    close() {
        this.copilot.close();
        for (const pending of this.logins.values()) pending.controller.abort();
    }
}
