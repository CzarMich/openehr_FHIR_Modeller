package org.openehr.modelling.engine;

import java.util.*;

final class LegacyEngine {
    static boolean xml(String content) { return content.replaceFirst("^\\ufeff", "").stripLeading().startsWith("<"); }

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
                "external_terminology", "NOT_EXECUTED", "clinical_review", "NOT_EXECUTED"));
        result.put("limitations", List.of("Explicit legacy compatibility profile; not complete AOM conformance.",
                "Unsupported OET/ADL constructs fail closed. No external modeller round-trip qualification is inferred."));
        return result;
    }
}
