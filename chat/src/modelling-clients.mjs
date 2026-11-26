import { McpClient } from "./mcp.mjs";
import { isIntegrationTool } from "./integration-tools.mjs";

export class ModellingClients {
    constructor(config, core, signal) {
        this.legacy = new McpClient(config, signal);
        this.modern = core.ready
            ? new McpClient(
                  { ...config, mcpUrl: core.origin + "/mcp", mcpKey: core.key, mcpKeyHeader: "X-API-Key" },
                  signal,
              )
            : null;
    }
    async tools() {
        const results = await Promise.allSettled([this.legacy.tools(), this.modern ? this.modern.tools() : []]);
        if (results.every((result) => result.status === "rejected"))
            throw new Error("Modelling services are unavailable");
        const legacy = results[0].status === "fulfilled" ? results[0].value : [];
        const modern = results[1].status === "fulfilled" ? results[1].value : [];
        return [...legacy, ...modern.filter((tool) => isIntegrationTool(tool.name))];
    }
    async call(name, args) {
        if (isIntegrationTool(name)) {
            if (!this.modern) throw new Error("Integration modelling is unavailable");
            return this.modern.call(name, args);
        }
        return this.legacy.call(name, args);
    }
    async close() {
        await Promise.allSettled([this.legacy.close(), this.modern?.close()]);
    }
}
