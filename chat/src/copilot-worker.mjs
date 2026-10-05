import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
    ConnectionSettings,
    CopilotStudioClient,
    getCopilotStudioConnectionUrl,
} from "@microsoft/agents-copilotstudio-client";
import { copilotSession } from "./copilot.mjs";

// The SDK has no per-request AbortSignal. A private worker makes cancellation
// terminate every upstream stream, including a stream waiting on a client tool.
const settings = new ConnectionSettings({
    environmentId: workerData.settings.environmentId,
    schemaName: workerData.settings.schemaName,
    cloud: "Prod",
    copilotAgentType: "Published",
    enableDiagnostics: false,
});
const endpoint = new URL(getCopilotStudioConnectionUrl(settings));
const transport = globalThis.fetch;
const sent = new Set();
let responseBytes = 0;
globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (
        url.origin !== endpoint.origin ||
        !(url.pathname === endpoint.pathname || url.pathname.startsWith(endpoint.pathname + "/"))
    )
        return new Response("", { status: 403 });
    const key = url.href + ":" + (init?.body || "");
    // Do not replay a POST after a broken SSE stream: it may trigger an action.
    if (sent.has(key)) return new Response("", { status: 409 });
    sent.add(key);
    let response;
    try {
        response = await transport(input, { ...init, redirect: "error" });
    } catch {
        return new Response("", { status: 502 });
    }
    const body = response.body?.pipeThrough(
        new TransformStream({
            transform(chunk, controller) {
                responseBytes += chunk.byteLength;
                if (responseBytes > 8 * 1024 * 1024) throw new Error("Response limit reached");
                controller.enqueue(chunk);
            },
        }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};
const pending = new Map();
parentPort.on("message", (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error), { userSafe: true }));
    else request.resolve(message.result);
});
try {
    const text = await copilotSession(new CopilotStudioClient(settings, workerData.token), {
        ...workerData.input,
        signal: new AbortController().signal,
        onEvent: (event) => parentPort.postMessage({ type: "event", event }),
        callTool: (name, args) =>
            new Promise((resolve, reject) => {
                const id = randomUUID();
                pending.set(id, { resolve, reject });
                parentPort.postMessage({ type: "tool", id, name, args });
            }),
    });
    parentPort.postMessage({ type: "done", text });
} catch (error) {
    parentPort.postMessage({ type: "error", ...(error.userSafe ? { safeMessage: error.message } : {}) });
} finally {
    parentPort.close();
}
