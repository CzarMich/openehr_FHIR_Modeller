import { problem } from "./personal-http.mjs";

export function repositoryFolder(value) {
    if (typeof value === "string" && !value.trim().startsWith("/")) value = value.trim().replace(/\/+$/, "");
    if (
        typeof value !== "string" ||
        value.length > 200 ||
        (value !== "" &&
            (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(value) ||
                value.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))))
    )
        throw problem(
            "Use a relative repository folder with letters, numbers, hyphens or underscores; leave it empty for the repository root.",
        );
    return value;
}

export function projectFolder(name) {
    return (
        name
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^A-Za-z0-9_-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "project"
    );
}

export function requireFolderPath(path, folder) {
    folder = repositoryFolder(folder);
    if (folder && (typeof path !== "string" || !path.startsWith(folder + "/")))
        throw problem(
            "Save inside the selected repository folder. Use the full path shown in the workspace destination, or change Repository folder in Chat settings.",
        );
    return path;
}

export const ARTIFACT_FOLDERS = Object.freeze({
    archetypes: "archetypes",
    oet: "templates/oet",
    opt: "templates/opt",
    adlTemplates: "templates/adl",
    aql: "queries",
    json: "data/json",
    xml: "data/xml",
    csv: "data/csv",
    markdown: "documents/markdown",
    text: "documents/text",
    yaml: "config/yaml",
});
export const FHIR_ARTIFACT_FOLDERS = Object.freeze({
    fsh: "input/fsh",
    resources: "input/resources",
    examples: "input/examples",
    pages: "input/pagecontent",
    generated: "fsh-generated/resources",
    validation: "validation",
    mappings: "mappings",
});
export function fhirArtifactPath(path, folder = "", standard = "FHIR") {
    requireFolderPath(path, folder);
    const relative = folder ? path.slice(folder.length + 1) : path;
    if (
        typeof relative !== "string" ||
        relative.length > 240 ||
        relative.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
        /[\\\x00-\x1f\x7f]/u.test(relative)
    )
        throw problem("Use a safe relative FHIR artifact path.");
    const allowed =
        standard === "mappings"
            ? /^(mappings|validation|provenance|documentation)\/[A-Za-z0-9_.\/-]+$/
            : /^(?:(?:input\/(?:fsh|resources|examples|pagecontent|vocabulary)|fsh-generated\/resources|validation|provenance|mappings)\/[A-Za-z0-9_.\/-]+|sushi-config\.yaml|package(?:-lock)?\.json|ig\.ini|README\.md)$/;
    if (!allowed.test(relative))
        throw problem(
            "Use the selected standard's source layout: input/fsh, input/resources, input/examples, validation, provenance or mappings; project configuration stays at its root.",
        );
    return path;
}
const folderPrefixes = [
    ...new Set([
        ...Object.values(ARTIFACT_FOLDERS),
        "templates",
        "oet",
        "oets",
        "opt",
        "opts",
        "data",
        "documents",
        "config",
    ]),
].sort((a, b) => b.length - a.length);

export function artifactKind(path) {
    const extension =
        /\.(oet|opt)\.xml$/i.exec(path)?.[1].toLowerCase() || /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase();
    const kinds = {
        adl: "archetypes",
        adls: "archetypes",
        adlf: "archetypes",
        adlt: "adlTemplates",
        oet: "oet",
        opt: "opt",
        aql: "aql",
        json: "json",
        xml: "xml",
        csv: "csv",
        md: "markdown",
        txt: "text",
        yaml: "yaml",
        yml: "yaml",
    };
    return Object.hasOwn(kinds, extension) ? kinds[extension] : null;
}

// Keep every supported generated file type separate, retaining purpose subfolders
// such as requirements, terminology, examples and validation inside its type.
export function artifactPath(path, folder = "") {
    folder = repositoryFolder(folder);
    const relative = folder && path.startsWith(folder + "/") ? path.slice(folder.length + 1) : path;
    const category = ARTIFACT_FOLDERS[artifactKind(path)];
    if (!category) return (folder ? folder + "/" : "") + relative;
    const prefix = folderPrefixes.find((value) => relative.toLowerCase().startsWith(value + "/"));
    const name = prefix ? relative.slice(prefix.length + 1) : relative;
    return (folder ? folder + "/" : "") + category + "/" + name;
}
