export const INTEGRATION_ACTIONS = Object.freeze({
    modelling_project: { read: ["list", "get"], write: ["create"] },
    modelling_model: { read: ["list", "get"], write: ["provide"] },
    modelling_mapping: { read: ["help", "list", "get", "preview"], write: ["prepare"] },
    source_inspect: { read: ["inspect"], write: [] },
    modelling_engine: { read: ["fhir", "openehr"], write: [] },
});
export const isIntegrationTool = (name) => Object.hasOwn(INTEGRATION_ACTIONS, name);
export function integrationWrite(name, args) {
    if (!isIntegrationTool(name)) return false;
    if (INTEGRATION_ACTIONS[name].write.includes(args?.action)) return true;
    if (!INTEGRATION_ACTIONS[name].read.includes(args?.action)) return true;
    if (name === "modelling_engine") {
        try {
            return JSON.parse(args.arguments || "{}").operation === "package.install";
        } catch {
            return true;
        }
    }
    return false;
}
export function validateIntegrationCall(name, args) {
    const definition = INTEGRATION_ACTIONS[name];
    if (
        !definition ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).some((k) => !["action", "projectId", "arguments"].includes(k)) ||
        ![...definition.read, ...definition.write].includes(args.action) ||
        (args.projectId !== undefined &&
            (typeof args.projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(args.projectId)))
    )
        throw new Error("Invalid integration modelling request");
    if (args.arguments !== undefined) {
        if (typeof args.arguments !== "string") throw new Error("Integration arguments must be JSON text");
        const value = JSON.parse(args.arguments);
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Integration arguments must be an object");
    }
    return args;
}
