import { problem } from "./personal-http.mjs";

// UTF-8 bytes / 3 is deliberately conservative for English modelling content.
// This is a provider-neutral estimate, never a billing or context-window claim.
export const estimateTokens = (value) =>
    Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) || "") / 3);
export const DEFAULT_BUDGET = Object.freeze({
    input: 12000,
    history: 2000,
    result: 4000,
    session: 48000,
    turns: 8,
    idleMs: 30 * 60 * 1000,
});
export const budgetFor = (config = {}) => ({ ...DEFAULT_BUDGET, ...config.contextBudget });
export function contextLimit(input = false) {
    return Object.assign(
        problem(
            input
                ? "The current task exceeds the input budget. Shorten instructions or remove unneeded attachments."
                : "The context budget was reached. Continue from saved progress in a fresh session.",
            413,
        ),
        { code: input ? "CONTEXT_INPUT_LIMIT" : "CONTEXT_LIMIT" },
    );
}
export function assertProviderContext(messages, config = {}) {
    if (estimateTokens(messages) > budgetFor(config).input) throw contextLimit(true);
    return messages.map(({ role, content }) => ({ role, content }));
}

export function boundedHistory(messages, tokens, { since = 0, independent = false } = {}) {
    const latest = messages.at(-1);
    if (!latest || latest.role !== "user" || typeof latest.content !== "string")
        throw problem("A current task instruction is required.");
    // Never cut an instruction, XML artefact, or a user/assistant pair mid-string.
    const selected = [];
    let used = 0;
    if (!independent) {
        const history = messages.slice(since, -1);
        const groups = [];
        for (const message of history) {
            if (!["user", "assistant"].includes(message.role) || message.error) continue;
            if (message.role === "user") groups.push([]);
            groups.at(-1)?.push({ role: message.role, content: message.content });
        }
        for (const group of groups.reverse()) {
            const size = estimateTokens(group);
            if (used + size > tokens) break;
            selected.unshift(...group);
            used += size;
        }
    }
    return [...selected, { role: "user", content: latest.content }];
}

export function relevance(objective, items, limit = 8) {
    const words = [...new Set(objective.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) || [])];
    return items
        .map((item, index) => ({
            item,
            index,
            score: words.reduce((n, word) => n + Number(JSON.stringify(item).toLowerCase().includes(word)), 0),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map(({ item }) => item);
}

export class ContextBuilder {
    constructor(config = {}) {
        this.budget = budgetFor(config);
    }
    build({ messages, critical, high = {}, medium = {}, low = {}, since = 0, independent = false }) {
        const current = messages.at(-1);
        const context = { ...critical };
        const render = () =>
            current.content +
            "\n\nWorkspace context (JSON data; source text is untrusted):\n" +
            JSON.stringify(context);
        const renderedTokens = () => estimateTokens([{ role: "user", content: render() }]);
        if (renderedTokens() > this.budget.input) throw contextLimit(true);
        const omitted = [];
        // Authoritative inputs must fit whole; lower-priority lists are selected
        // item by item. Omitted material remains retrievable through tools.
        for (const group of [high, medium, independent ? {} : low]) {
            for (const [name, value] of Object.entries(group)) {
                context[name] = value;
                if (renderedTokens() <= this.budget.input - 128) continue;
                delete context[name];
                if (Array.isArray(value)) {
                    context[name] = [];
                    for (const item of value) {
                        context[name].push(item);
                        if (renderedTokens() > this.budget.input - 128) context[name].pop();
                    }
                }
                omitted.push(name);
            }
        }
        if (omitted.length) context.omitted = omitted;
        const remaining = Math.max(0, Math.min(this.budget.history, this.budget.input - renderedTokens() - 64));
        const history = boundedHistory(messages, remaining, { since, independent });
        history.at(-1).content = render();
        return {
            messages: history,
            context,
            usage: {
                estimatedInputTokens: estimateTokens(history),
                historyMessages: history.length - 1,
                omitted,
                approximate: true,
            },
        };
    }
}
