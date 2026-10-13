package org.openehr.modelling.engine;

import java.util.*;

final class LegacyEngine {
    static boolean xml(String content) { return content.replaceFirst("^\\ufeff", "").stripLeading().startsWith("<"); }

    static boolean adl(String content) {
        // Select by successful grammar parsing, never by a declared version allowlist.
        try { LegacyArchetype.parse(content); return true; }
        catch (EngineException error) { return false; }
    }

    static Map<String, Object> archetype(Request request, Map<String, Object> result) {
        if (!request.operation().endsWith("/archetype")) throw new EngineException("ENGINE_DOCUMENT_KIND_MISMATCH");
        var source = LegacyArchetype.parse(request.content());
        var sources = new TreeMap<String, LegacyArchetype>(); sources.put(source.identifier(), source);
        if (source.model().getRmRelease() != null && !LegacyTemplateCompiler.RM_RELEASE.equals(source.model().getRmRelease()))
            throw new EngineException("ENGINE_DEPENDENCY_RM_MISMATCH");
        source.model().setRmRelease(LegacyTemplateCompiler.RM_RELEASE);
        for (var dependency : request.dependencies()) {
            var parsed = LegacyArchetype.parse(dependency.content());
            if (!parsed.identifier().equals(dependency.identifier())) throw new EngineException("ENGINE_DEPENDENCY_ID_MISMATCH");
            if (parsed.model().getRmRelease() != null && !LegacyTemplateCompiler.RM_RELEASE.equals(parsed.model().getRmRelease()))
                throw new EngineException("ENGINE_DEPENDENCY_RM_MISMATCH");
            parsed.model().setRmRelease(LegacyTemplateCompiler.RM_RELEASE);
            if (sources.putIfAbsent(parsed.identifier(), parsed) != null) throw new EngineException("ENGINE_DEPENDENCY_ID_DUPLICATE");
        }
        Set<String> used = new HashSet<>(); List<Map<String, String>> actions = new ArrayList<>();
        var flat = new LegacyInheritance(sources, used, actions).resolve(source.identifier());
        if (!used.equals(sources.keySet())) throw new EngineException("ENGINE_UNUSED_DEPENDENCY");
        var writer = new LegacyOptWriter(flat.model().getOriginalLanguage().getCodeString(),
                org.openehr.referencemodels.BuiltinReferenceModels.getMetaModelProvider().getMetaModel(flat.model()));
        var root = writer.root(flat, "definition");
        // Exercise faithful legacy domain constraints independently of a generated template.
        checkValues(root);
        result.put("profile", "ADL14_PARSE_RM_STRUCTURE");
        result.put("identifier", source.identifier()); result.put("adl_version", source.model().getAdlVersion());
        result.put("rm_release", LegacyTemplateCompiler.RM_RELEASE);
        result.put("rm_release_basis", "explicit_legacy_compatibility_profile");
        result.put("dependencies", request.dependencies().stream().map(d -> Map.of("identifier", d.identifier(), "sha256", d.sha256())).toList());
        result.put("inspection", NativeEngine.inspect(flat.model()));
        result.put("original_ontology", flat.ontology());
        result.put("compilation_actions", actions);
        result.put("valid", true); result.put("status", "PASS"); result.put("completed_stage", "legacy_profile");
        result.put("checks", Map.of("adl14_parse", "PASS", "rm_structure_profile", "PASS", "full_aom_semantics", "NOT_EXECUTED", "clinical_review", "NOT_EXECUTED", "declared_language_release_qualification", "NOT_EXECUTED"));
        result.put("limitations", List.of("Legacy grammar and RM 1.0.2 compatibility checks, not complete AOM conformance or historical-language qualification.",
                "Parser selection follows source grammar, not a declared-version allowlist; unsupported constructs fail."));
        return result;
    }

    private static void checkValues(org.w3c.dom.Element element) {
        if (element.hasAttributeNS(SafeXml.XSI, "type")) LegacyValueValidation.check(element, SafeXml.type(element));
        for (var child : SafeXml.children(element)) checkValues(child);
    }

    static Map<String, Object> execute(Request request, Map<String, Object> result) {
        boolean template = request.operation().endsWith("/template");
        if (!template && !request.operation().endsWith("/opt")) throw new EngineException("ENGINE_DOCUMENT_KIND_MISMATCH");
        String content = request.content();
        List<Map<String, String>> actions = List.of();
        if (template) {
            var compiled = new LegacyTemplateCompiler().compile(content, request.dependencies());
            content = compiled.content(); actions = compiled.actions();
            result.put("profile", "OET14_COMPILATION_RM_STRUCTURE");
        } else {
            if (!request.dependencies().isEmpty()) throw new EngineException("ENGINE_OPT_DEPENDENCIES_UNSUPPORTED");
            result.put("profile", "OPT14_XML_RM_STRUCTURE");
        }
        var inspected = LegacyOptProfile.inspect(content);
        result.put("identifier", inspected.identifier());
        result.put("rm_release", LegacyTemplateCompiler.RM_RELEASE);
        result.put("rm_release_basis", "explicit_legacy_compatibility_profile");
        result.put("dependencies", request.dependencies().stream().sorted(Comparator.comparing(Request.Dependency::identifier)).map(dependency -> Map.of(
                "identifier", dependency.identifier(), "sha256", dependency.sha256(), "rm_release", LegacyTemplateCompiler.RM_RELEASE,
                "adl_version", Objects.toString(LegacyArchetype.parse(dependency.content()).model().getAdlVersion(), "undeclared"),
                "selection", "explicit_hash_pinned_input")).toList());
        result.put("inspection", Map.of("paths", inspected.paths()));
        result.put("terminology_dependencies", inspected.bindings());
        result.put("compilation_actions", actions);
        // Qualify generated OPTs with an independent downstream consumer before
        // calling compilation successful. Existing imported OPT validation keeps
        // its explicitly structural scope.
        if (template) {
            var webTemplate = LegacyWebTemplate.generate(content);
            if (request.operation().equals("compile/template")) result.put("web_template", webTemplate);
        }
        if (request.operation().equals("compile/template")) result.put("output", Map.of("format", "opt14_xml", "content", content, "sha256", NativeEngine.sha256(content)));
        result.put("valid", true); result.put("status", "PASS"); result.put("completed_stage", "legacy_profile");
        result.put("checks", Map.of("oet_application", template ? "PASS" : "NOT_EXECUTED", "adl14_parse", template ? "PASS" : "NOT_EXECUTED",
                "opt14_xml_schema", "PASS", "rm_structure_profile", "PASS", "full_aom_semantics", "NOT_EXECUTED",
                "web_template_generation", template ? "PASS" : "NOT_EXECUTED",
                "external_terminology", "NOT_EXECUTED", "clinical_review", "NOT_EXECUTED", "declared_language_release_qualification", "NOT_EXECUTED"));
        result.put("limitations", List.of("Explicit legacy compatibility profile; not complete AOM conformance.",
                "Unsupported OET/ADL constructs fail closed. No external modeller round-trip qualification is inferred."));
        return result;
    }
}
