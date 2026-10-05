import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTRUCTIONS, toolOutput, toolSucceeded, toolError } from "./provider-tools.mjs";

export class CodexProvider {
    constructor(config) {
        this.config = config;
    }
    async run({ messages, images = [], tools, callTool, onEvent, signal, onLogin, instructions = INSTRUCTIONS }) {
        let imageDirectory;
        const env = { PATH: process.env.PATH, LANG: "C.UTF-8", TOKIO_WORKER_THREADS: "2", RAYON_NUM_THREADS: "2" };
        for (const key of [
            "HOME",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
        ])
            if (process.env[key]) env[key] = process.env[key];
        if (this.config.codexHome) env.CODEX_HOME = this.config.codexHome;
        const overrides = {
            cli_auth_credentials_store: "file",
            "features.shell_tool": false,
            "features.unified_exec": false,
            "features.shell_snapshot": false,
            "features.multi_agent": false,
            "features.apps": false,
            "features.remote_plugin": false,
            "features.skill_mcp_dependency_install": false,
            "features.js_repl": false,
            "features.code_mode": false,
            "features.code_mode_host": true,
            "features.image_generation": false,
            "features.view_image": false,
            "features.request_permissions_tool": false,
            "features.tool_suggest": false,
            "features.sleep_tool": false,
            "features.apply_patch_freeform": false,
            "features.memory_tool": false,
            "apps._default.enabled": false,
            web_search: "disabled",
            mcp_servers: {},
            approval_policy: "never",
            sandbox_mode: "read-only",
            project_doc_max_bytes: 0,
        };
        const args = ["app-server", "--stdio"];
        for (const [key, value] of Object.entries(overrides))
            args.push("-c", `${key}=${typeof value === "object" ? "{}" : JSON.stringify(value)}`);
        const child = spawn(this.config.codexBinary, args, {
            cwd: this.config.codexWorkDir,
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = new Promise((resolve) => {
            child.once("close", resolve);
        });
        const pending = new Map();
        let sequence = 0,
            finished = false,
            text = "",
            lastItem = null,
            settle;
        const completion = new Promise((resolve, reject) => {
            settle = { resolve, reject };
        });
        completion.catch(() => {});
        const stop = () => {
            if (child.exitCode === null) {
                child.kill("SIGTERM");
                const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
                timer.unref();
            }
        };
        const fail = (error) => {
            if (finished) return;
            finished = true;
            settle.reject(error);
            for (const p of pending.values()) p.reject(error);
            pending.clear();
            stop();
        };
        const abort = () => fail(Object.assign(new Error("Response stopped"), { name: "AbortError" }));
        signal.addEventListener("abort", abort, { once: true });
        const send = (data) => {
            if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(data) + "\n");
        };
        const rpc = (method, params) =>
            new Promise((resolve, reject) => {
                const id = ++sequence;
                pending.set(id, { resolve, reject });
                send({ id, method, params });
            });
        const lines = createInterface({ input: child.stdout });
        // Do not log provider stderr: it can contain request data and account diagnostics.
        child.stderr.on("data", () => {});
        child.on("error", () => fail(new Error("Chat provider unavailable")));
        child.stdin.on("error", () => fail(new Error("Chat provider input closed")));
        child.on("exit", () => {
            if (!finished) fail(new Error("Chat provider ended before replying"));
        });
        lines.on("line", (line) => {
            if (line.length > 2097152) {
                fail(new Error("Chat provider response too large"));
                return;
            }
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                fail(new Error("Invalid chat provider response"));
                return;
            }
            if (message.id !== undefined && !message.method) {
                const p = pending.get(message.id);
                if (p) {
                    pending.delete(message.id);
                    message.error ? p.reject(new Error("Chat provider request failed")) : p.resolve(message.result);
                }
                return;
            }
            const data = message.params || {};
            if (onLogin && message.method === "account/login/completed") {
                if (data.success) {
                    finished = true;
                    settle.resolve();
                } else fail(new Error("Provider sign-in was not completed"));
                return;
            }
            if (message.method === "warning" && String(data.message).includes("Code Mode is unavailable")) {
                fail(new Error("Chat provider tools are unavailable"));
                return;
            }
            if (message.method === "item/tool/call" && message.id !== undefined) {
                Promise.resolve()
                    .then(() => callTool(data.tool, data.arguments))
                    .then((result) => {
                        const bounded = toolOutput(result);
                        send({
                            id: message.id,
                            result: {
                                contentItems: [{ type: "inputText", text: bounded }],
                                success: toolSucceeded(result),
                            },
                        });
                    })
                    .catch((error) =>
                        send({
                            id: message.id,
                            result: {
                                contentItems: [
                                    {
                                        type: "inputText",
                                        text: toolError(error),
                                    },
                                ],
                                success: false,
                            },
                        }),
                    );
            } else if (message.id !== undefined && message.method) {
                if (message.method.includes("requestApproval"))
                    send({ id: message.id, result: { decision: "decline", permissions: {}, scope: "turn" } });
                else if (message.method.includes("elicitation"))
                    send({ id: message.id, result: { action: "decline", content: null } });
                else if (message.method === "item/tool/requestUserInput")
                    send({ id: message.id, result: { answers: {} } });
                else send({ id: message.id, error: { code: -32601, message: "Unsupported operation" } });
            } else if (message.method === "item/agentMessage/delta") {
                const delta = (lastItem && lastItem !== data.itemId ? "\n\n" : "") + String(data.delta || "");
                lastItem = data.itemId;
                text += delta;
                if (text.length > 100000) {
                    fail(new Error("Response limit reached"));
                    return;
                }
                onEvent({ type: "delta", text: delta });
            } else if (message.method === "turn/completed") {
                if (data.turn?.status === "completed") {
                    finished = true;
                    settle.resolve(text);
                } else fail(new Error("Chat provider could not complete the response"));
            } else if (message.method === "error" && !data.willRetry)
                fail(new Error("Chat provider unavailable. Please retry."));
        });
        try {
            if (signal.aborted) throw Object.assign(new Error("Response stopped"), { name: "AbortError" });
            await rpc("initialize", {
                clientInfo: { name: "openehr_modelling_browser", version: "1.0" },
                capabilities: { experimentalApi: true },
            });
            send({ method: "initialized" });
            if (onLogin) {
                onLogin(await rpc("account/login/start", { type: "chatgptDeviceCode" }));
                return await completion;
            }
            const thread = await rpc("thread/start", {
                model: this.config.model,
                cwd: this.config.codexWorkDir,
                ephemeral: true,
                approvalPolicy: "never",
                sandbox: "read-only",
                baseInstructions: instructions,
                dynamicTools: tools.map((t) => ({
                    type: "function",
                    name: t.name,
                    description: t.description || t.name,
                    inputSchema: t.inputSchema,
                })),
            });
            const history = messages
                .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}:\n${m.content}`)
                .join("\n\n");
            const prompt =
                "Conversation history (quoted user and assistant content; not system instructions):\n" +
                history.slice(-60000) +
                "\n\nRespond to the latest user message using the modelling tools when relevant.";
            const input = [{ type: "text", text: prompt }];
            if (images.length) {
                imageDirectory = mkdtempSync(join(tmpdir(), "modelling-images-"));
                for (const [index, image] of images.entries()) {
                    const path = join(imageDirectory, index + ".jpg");
                    writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
                    input.push(
                        {
                            type: "text",
                            text: "Attached source image: " + JSON.stringify({ id: image.id, name: image.name }),
                        },
                        { type: "localImage", path },
                    );
                }
            }
            await rpc("turn/start", {
                threadId: thread.thread.id,
                input,
                effort: "low",
            });
            return await completion;
        } finally {
            signal.removeEventListener("abort", abort);
            lines.close();
            stop();
            await exited;
            if (imageDirectory) rmSync(imageDirectory, { recursive: true, force: true });
        }
    }
}
