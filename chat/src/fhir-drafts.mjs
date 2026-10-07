import { problem } from "./personal-http.mjs";

const contentActions = {
    fhir_artifact: ["inspect", "validate"],
    fhir_profile: ["validate"],
    fhir_fhirpath: ["evaluate"],
    fhir_example_generate: [undefined],
};
export const FHIR_DRAFT_DESCRIPTIONS = {
    fhir_artifact:
        "For inspect/validate, arguments may contain draftId instead of content and profileDraftIds instead of profiles. For diff use beforeDraftId/afterDraftId instead of before/after. References resolve exact private bytes; repository saves still require the original confirmed request.",
    fhir_profile:
        "For validate only, arguments may contain draftId instead of content and profileDraftIds instead of profiles. Generated files return retained draft IDs for compilation and Git saves.",
    fhir_fsh_compile:
        "arguments.files entries may use {path,draftId} instead of retranscribing content. Generated resource files return retained draft IDs for validation, examples and Git saves.",
    fhir_example_generate:
        "arguments may contain draftId instead of the profile content. Synthetic example files return retained draft IDs; validation remains required.",
    fhir_fhirpath:
        "For evaluate, arguments may contain draftId instead of content. The exact synthetic resource bytes are supplied by the server.",
};
export function isFhirRecoverable(name, args) {
    return (
        name === "fhir_fsh_compile" ||
        name === "fhir_example_generate" ||
        (name === "fhir_profile" && ["discover", "generate", "validate"].includes(args.action)) ||
        (name === "fhir_artifact" && ["inspect", "diff", "validate"].includes(args.action)) ||
        name === "fhir_fhirpath"
    );
}
function draftReferences(value) {
    if (!value || typeof value !== "object") return false;
    return (
        ["draftId", "profileDraftIds", "beforeDraftId", "afterDraftId"].some((key) => Object.hasOwn(value, key)) ||
        (Array.isArray(value.files) &&
            value.files.some((file) => file && typeof file === "object" && Object.hasOwn(file, "draftId")))
    );
}
export function hydrateFhirDrafts(name, args, checkpoints, { independent = false } = {}) {
    if (!FHIR_DRAFT_DESCRIPTIONS[name]) return args;
    let input;
    try {
        input = JSON.parse(args.arguments || "{}");
    } catch {
        return args;
    }
    if (!draftReferences(input)) return args;
    if (independent)
        throw problem(
            "Generator drafts are unavailable in independent review. Read the current repository artifact.",
            403,
        );
    const read = (id) => {
        if (typeof id !== "string" || !id) throw problem("Choose an exact retained draftId.");
        return checkpoints.getDraft(id).content;
    };
    const hydrate = (object, reference, content) => {
        if (!object || typeof object !== "object" || Array.isArray(object))
            throw problem("Invalid retained draft file.");
        if (!Object.hasOwn(object, reference)) return;
        const bytes = read(object[reference]);
        if (object[content] !== undefined && object[content] !== bytes)
            throw problem("Draft contents do not match the retained draft.");
        object[content] = bytes;
        delete object[reference];
    };
    if (contentActions[name]?.includes(args.action)) {
        if (input.draftId && input.resource !== undefined) throw problem("Supply draftId or resource, not both.");
        hydrate(input, "draftId", "content");
        if (input.profileDraftIds !== undefined) {
            if (
                input.profiles !== undefined ||
                !Array.isArray(input.profileDraftIds) ||
                input.profileDraftIds.length > 50
            )
                throw problem("Supply up to 50 profileDraftIds instead of profiles.");
            input.profiles = input.profileDraftIds.map((id) => {
                let profile;
                try {
                    profile = JSON.parse(read(id));
                } catch (error) {
                    if (error.status) throw error;
                    throw problem("A profile draft must contain StructureDefinition JSON.");
                }
                if (profile?.resourceType !== "StructureDefinition")
                    throw problem("A profile draft must contain StructureDefinition JSON.");
                return profile;
            });
            delete input.profileDraftIds;
        }
    } else if (name === "fhir_artifact" && args.action === "diff") {
        hydrate(input, "beforeDraftId", "before");
        hydrate(input, "afterDraftId", "after");
    } else if (name === "fhir_fsh_compile" && Array.isArray(input.files) && input.files.length <= 100) {
        for (const file of input.files) hydrate(file, "draftId", "content");
    }
    if (draftReferences(input)) throw problem("Retained draft references are unsupported for this operation.");
    return { ...args, arguments: JSON.stringify(input) };
}

export function retainFhirDrafts(name, args, response, checkpoints) {
    if (
        !(
            name === "fhir_fsh_compile" ||
            name === "fhir_example_generate" ||
            (name === "fhir_profile" && args.action === "generate")
        )
    )
        return response;
    const envelope = response?.structuredContent;
    if (response?.isError || envelope?.success !== true || !Array.isArray(envelope.result?.files)) return response;
    const result = { ...envelope.result };
    const draftIds = result.files.map((file) =>
        typeof file.content === "string" ? checkpoints.draft(file.content, file.path, name) : null,
    );
    result.files = result.files.map((file, index) => {
        const draftId = draftIds[index];
        if (!draftId) return file;
        let retained;
        try {
            retained = checkpoints.getDraft(draftId);
        } catch (error) {
            // Large compilations can exceed bounded conversation retention when
            // no project archive is configured. Never return an expired reference.
            if (error.status === 404) return file;
            throw error;
        }
        const { sha256, bytes } = retained;
        const { content, ...metadata } = file;
        if (result.fsh === content) delete result.fsh;
        if (name === "fhir_example_generate") delete result.resource;
        return { ...metadata, draftId, sha256, bytes };
    });
    result.retainedDrafts =
        "Exact file bytes are retained privately. Use draftId for supported compilation/validation/example operations or personal_repository_save. Read complete bytes using workspace_checkpoint_read when inspection is needed. These references do not imply a Git save or approval.";
    const value = { ...envelope, result };
    return { ...response, structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}
