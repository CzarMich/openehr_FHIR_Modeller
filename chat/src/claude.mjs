import Anthropic from "@anthropic-ai/sdk";
import { INSTRUCTIONS, toolOutput, toolSucceeded, toolError } from "./provider-tools.mjs";
import { assertProviderContext } from "./context-budget.mjs";

export class ClaudeProvider {
    constructor(
        config,
        apiKey,
        client = new Anthropic({
            apiKey,
            authToken: null,
            baseURL: "https://api.anthropic.com",
            maxRetries: 0,
            timeout: config.turnTimeoutMs,
        }),
    ) {
        this.config = config;
        this.client = client;
    }
    async run({ messages, images = [], tools, callTool, onEvent, onUsage, signal, instructions = INSTRUCTIONS }) {
        let text = "";
        const history = assertProviderContext(messages, this.config);
        while (history[0]?.role === "assistant") history.shift();
        if (images.length) {
            const latest = history.at(-1);
            latest.content = [
                ...images.flatMap((image) => [
                    {
                        type: "text",
                        text: "Attached source image: " + JSON.stringify({ id: image.id, name: image.name }),
                    },
                    { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } },
                ]),
                { type: "text", text: latest.content },
            ];
        }
        for (let step = 0; step < 65; step++) {
            signal.throwIfAborted();
            const stream = this.client.messages.stream(
                {
                    model: this.config.claudeModel,
                    max_tokens: 8192,
                    system: instructions,
                    messages: history,
                    tools: tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description || tool.name,
                        input_schema: tool.inputSchema,
                    })),
                },
                { signal },
            );
            try {
                for await (const event of stream) {
                    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                        text += event.delta.text;
                        if (text.length > 100000) throw new Error("Response limit reached");
                        onEvent({ type: "delta", text: event.delta.text });
                    }
                }
                const message = await stream.finalMessage();
                if (message.usage)
                    onUsage?.({
                        inputTokens: message.usage.input_tokens,
                        outputTokens: message.usage.output_tokens,
                        cachedInputTokens: message.usage.cache_read_input_tokens,
                        contextTokens:
                            (message.usage.input_tokens || 0) +
                            (message.usage.cache_read_input_tokens || 0) +
                            (message.usage.cache_creation_input_tokens || 0),
                    });
                if (message.stop_reason === "end_turn") return text;
                if (message.stop_reason !== "tool_use") throw new Error("Claude response was incomplete");
                const calls = message.content.filter((block) => block.type === "tool_use");
                if (!calls.length || calls.length > 16) throw new Error("Invalid tool response");
                history.push({ role: "assistant", content: message.content });
                const results = [];
                for (const call of calls) {
                    signal.throwIfAborted();
                    try {
                        const result = await callTool(call.name, call.input);
                        results.push({
                            type: "tool_result",
                            tool_use_id: call.id,
                            content: toolOutput(result),
                            is_error: !toolSucceeded(result),
                        });
                    } catch (error) {
                        signal.throwIfAborted();
                        results.push({
                            type: "tool_result",
                            tool_use_id: call.id,
                            content: toolError(error),
                            is_error: true,
                        });
                    }
                }
                history.push({ role: "user", content: results });
            } finally {
                stream.abort();
            }
        }
        throw new Error("Tool limit reached");
    }
}
