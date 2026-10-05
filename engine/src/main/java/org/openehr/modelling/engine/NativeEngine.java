package org.openehr.modelling.engine;

import com.nedap.archie.adlparser.ADLParser;
import com.nedap.archie.aom.*;
import com.nedap.archie.archetypevalidator.ArchetypeValidator;
import com.nedap.archie.archetypevalidator.ValidationResult;
import com.nedap.archie.serializer.adl.ADLArchetypeSerializer;
import org.openehr.referencemodels.BuiltinReferenceModels;
import org.ehrbase.openehr.sdk.aql.parser.AqlQueryParser;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Native processors only; no source retrieval, storage, workflow approval or query execution. */
final class NativeEngine {
    static final String ARCHIE_VERSION = "3.20.0";
    static final String SDK_VERSION = "2.35.0";

    Map<String, Object> execute(Request request) {
        var result = new LinkedHashMap<String, Object>();
        result.put("schema_version", 1);
        result.put("operation", request.operation());
        result.put("content_sha256", sha256(request.content()));
        result.put("engine", Map.of("adapter", "1.2.0", "archie", ARCHIE_VERSION, "aql", SDK_VERSION));
        result.put("clinical_approval", false);
        List<Map<String, Object>> findings = new ArrayList<>();
        result.put("findings", findings);
        if (request.operation().equals("validate/aql")) return aql(request, result, findings);
        if (LegacyEngine.xml(request.content())) return LegacyEngine.execute(request, result);
        result.put("profile", request.operation().endsWith("/opt") ? "OPT2_FLAT_AOM_BMM" : "ADL2_AOM2_BMM");
        PinnedRepository repository = new PinnedRepository();
        List<Map<String, Object>> manifest = new ArrayList<>();
        result.put("dependencies", manifest);
        Archetype source = parse(request.content(), findings, "source");
        if (source == null) return finish(result, false, "parse");
        boolean opt = request.operation().endsWith("/opt");
        if (opt != (source instanceof OperationalTemplate)
                || (request.operation().endsWith("/template") && !(source instanceof Template))
                || (request.operation().endsWith("/archetype") && source instanceof Template)) {
            throw new EngineException("ENGINE_DOCUMENT_KIND_MISMATCH");
        }
        checkProfile(source);
        result.put("identifier", source.getArchetypeId().getFullId());
        result.put("rm_release", source.getRmRelease());
        if (source instanceof OperationalTemplate operational) {
            if (!request.dependencies().isEmpty()) throw new EngineException("ENGINE_OPT_DEPENDENCIES_UNSUPPORTED");
            result.put("profile", "OPT2_FLAT_AOM_BMM");
            ValidationResult checked = OptValidation.validate(operational);
            appendValidation(checked, findings);
            if (checked.passes()) {
                result.put("inspection", inspect(operational));
                result.put("terminology_dependencies", terminologyDependencies(operational));
            }
            return finish(result, checked.passes(), "native_validation");
        }
        repository.addArchetype(source);
        for (Request.Dependency dependency : request.dependencies()) {
            Archetype parsed = parse(dependency.content(), findings, dependency.identifier());
            if (parsed == null) return finish(result, false, "parse");
            checkProfile(parsed);
            if (!source.getRmRelease().equals(parsed.getRmRelease())) throw new EngineException("ENGINE_DEPENDENCY_RM_MISMATCH");
            if (!dependency.identifier().equals(parsed.getArchetypeId().getFullId())) throw new EngineException("ENGINE_DEPENDENCY_ID_MISMATCH");
            if (parsed instanceof OperationalTemplate) throw new EngineException("ENGINE_DEPENDENCY_KIND_UNSUPPORTED");
            repository.addArchetype(parsed);
            manifest.add(Map.of("identifier", dependency.identifier(), "sha256", dependency.sha256(),
                    "rm_release", parsed.getRmRelease(), "selection", "explicit_hash_pinned_input"));
        }
        manifest.sort(Comparator.comparing(item -> (String) item.get("identifier")));
        var models = BuiltinReferenceModels.getMetaModelProvider();
        var validator = new ArchetypeValidator(models);
        boolean valid = true;
        for (Archetype model : repository.getAllArchetypes().stream()
                .sorted(Comparator.comparing(a -> a.getArchetypeId().getFullId())).toList()) {
            ValidationResult report = validator.validate(model, repository);
            appendValidation(report, findings);
            valid &= report.passes();
        }
        if (!valid) return finish(result, false, "native_validation");
        Archetype inspected = repository.getValidationResult(source.getArchetypeId().getFullId()).getFlattened();
        if (inspected == null) throw new EngineException("ENGINE_FLATTENING_FAILED");
        if (request.operation().equals("compile/template")) {
            OperationalTemplate compiled = (OperationalTemplate) new com.nedap.archie.flattener.Flattener(repository, models)
                    .createOperationalTemplate(true).flatten(source);
            if (compiled == null) throw new EngineException("ENGINE_COMPILATION_FAILED");
            String output = ADLArchetypeSerializer.serialize(compiled, repository::getFlattenedArchetype,
                    new com.nedap.archie.json.ArchieRMObjectMapperProvider());
            Archetype reparsed = parse(output, findings, "compiled_opt");
            if (!(reparsed instanceof OperationalTemplate)) return finish(result, false, "output_parse");
            ValidationResult outputValidation = OptValidation.validate((OperationalTemplate) reparsed);
            appendValidation(outputValidation, findings);
            if (!outputValidation.passes()) return finish(result, false, "output_validation");
            result.put("output", Map.of("format", "opt2_adl", "content", output, "sha256", sha256(output)));
            inspected = reparsed;
        }
        result.put("inspection", inspect(inspected));
        result.put("terminology_dependencies", terminologyDependencies(inspected));
        return finish(result, true, "native_validation");
    }

    private Map<String, Object> aql(Request request, Map<String, Object> result, List<Map<String, Object>> findings) {
        result.put("profile", "AQL_SYNTAX");
        org.ehrbase.openehr.sdk.aql.dto.AqlQuery query;
        try {
            query = AqlQueryParser.parse(request.content());
        } catch (org.ehrbase.openehr.sdk.aql.parser.AqlParseException | IllegalArgumentException e) {
            findings.add(finding("error", "AQL_PARSE_ERROR", "/", safe(e.getMessage()), "source"));
            return finish(result, false, "parse");
        }
        result.put("normalized_query", query.render());
        result.put("ast", Json.MAPPER.valueToTree(query));
        result.put("unexecuted", List.of("model_path_validation", "model_compatibility", "query_execution"));
        finish(result, true, "parse");
        if (!request.dependencies().isEmpty()) AqlTemplatePaths.validate(query, request.dependencies(), result);
        return result;
    }

    private static Archetype parse(String content, List<Map<String, Object>> findings, String location) {
        ADLParser parser = new ADLParser(BuiltinReferenceModels.getMetaModelProvider());
        Archetype model = null;
        try { model = parser.parse(content); }
        catch (Exception e) {
            findings.add(finding("error", "ADL_PARSE_ERROR", "/", "Native parser rejected the document.", location));
        }
        if (parser.getErrors() != null) {
            for (var error : parser.getErrors().getErrors()) {
                findings.add(finding("error", "ADL_PARSE_ERROR", "/", safe(error.getMessage()), location));
                limit(findings);
            }
            if (parser.getErrors().hasErrors()) return null;
        }
        if (model == null && findings.isEmpty()) findings.add(finding("error", "ADL_PARSE_ERROR", "/", "No parsed archetype.", location));
        return model;
    }

    private static void checkProfile(Archetype source) {
        if (!"2.0.6".equals(source.getAdlVersion()) && !"2.0.5".equals(source.getAdlVersion()) && !"2.0.0".equals(source.getAdlVersion()) && !"2.0".equals(source.getAdlVersion())) {
            throw new EngineException("ENGINE_ADL_VERSION_UNSUPPORTED");
        }
        if (source.getArchetypeId() == null || source.getDefinition() == null || source.getRmRelease() == null
                || !source.getArchetypeId().getRmPublisher().equalsIgnoreCase("openehr")
                || !Set.of("1.0.2", "1.0.3", "1.0.4", "1.1.0").contains(source.getRmRelease())) {
            throw new EngineException("ENGINE_RM_PROFILE_UNSUPPORTED");
        }
    }

    private static void appendValidation(ValidationResult report, List<Map<String, Object>> findings) {
        for (var message : report.getErrors()) {
            findings.add(finding(message.isWarning() ? "warning" : "error", message.getType().getCode(),
                    message.getPathInArchetype() == null ? "/" : message.getPathInArchetype(), safe(message.toString()), report.getArchetypeId()));
            limit(findings);
        }
        if (report.getOverlayValidations() != null) for (var overlay : report.getOverlayValidations()) appendValidation(overlay, findings);
    }

    private static Map<String, Object> inspect(Archetype model) {
        List<Map<String, Object>> paths = new ArrayList<>();
        Deque<CObject> pending = new ArrayDeque<>();
        pending.add(model.getDefinition());
        while (!pending.isEmpty()) {
            CObject node = pending.removeFirst();
            if (paths.size() >= 20000) throw new EngineException("ENGINE_NODE_LIMIT");
            var item = new LinkedHashMap<String, Object>();
            item.put("path", node.getPath()); item.put("node_id", node.getNodeId()); item.put("rm_type", node.getRmTypeName());
            item.put("constraint_kind", node.getClass().getSimpleName());
            if (node == model.getDefinition()) item.put("archetype", model.getArchetypeId().getFullId());
            else if (node instanceof CArchetypeRoot root) item.put("archetype", root.getArchetypeRef());
            item.put("occurrences", node.getOccurrences() == null ? null : node.getOccurrences().toString());
            item.put("terminology", node.getTerm());
            List<Map<String, Object>> attributes = new ArrayList<>();
            for (CAttribute attribute : node.getAttributes()) {
                var attr = new LinkedHashMap<String, Object>();
                attr.put("name", attribute.getRmAttributeName()); attr.put("path", attribute.getPath());
                attr.put("cardinality", attribute.getCardinality() == null ? null : attribute.getCardinality().toString());
                attr.put("existence", attribute.getExistence() == null ? null : attribute.getExistence().toString());
                attributes.add(attr); pending.addAll(attribute.getChildren());
            }
            item.put("attributes", attributes); paths.add(item);
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("paths", paths); result.put("terminology", model.getTerminology());
        if (model instanceof OperationalTemplate opt) result.put("component_terminologies", opt.getComponentTerminologies());
        return result;
    }

    /** Exact native binding URIs; no guessed CodeSystem, version or server validation. */
    private static List<Map<String, Object>> terminologyDependencies(Archetype model) {
        var scopes = new TreeMap<String, com.nedap.archie.aom.terminology.ArchetypeTerminology>();
        scopes.put(model.getArchetypeId().getFullId(), model.getTerminology());
        if (model instanceof OperationalTemplate opt && opt.getComponentTerminologies() != null) {
            scopes.putAll(opt.getComponentTerminologies());
        }
        List<Map<String, Object>> bindings = new ArrayList<>();
        scopes.forEach((scope, terminology) -> {
            if (terminology == null || terminology.getTermBindings() == null) return;
            new TreeMap<>(terminology.getTermBindings()).forEach((system, terms) ->
                new TreeMap<>(terms).forEach((local, uri) -> {
                    if (bindings.size() >= 4096) throw new EngineException("ENGINE_TERMINOLOGY_LIMIT");
                    bindings.add(Map.of("archetype", scope, "terminology", system,
                            "local_code_or_path", local, "binding_uri", uri.toString(),
                            "validation", "NOT_EXECUTED"));
                }));
        });
        return bindings;
    }

    private static Map<String, Object> finish(Map<String, Object> result, boolean valid, String stage) {
        result.put("valid", valid); result.put("status", valid ? "PASS" : "FAIL"); result.put("completed_stage", stage);
        Map<String, String> checks = new LinkedHashMap<>();
        if (result.get("operation").equals("validate/aql")) {
            checks.put("aql_syntax", valid ? "PASS" : "FAIL");
            checks.put("model_paths", "NOT_EXECUTED");
            checks.put("query_execution", "NOT_EXECUTED");
        } else {
            checks.put("adl_parse", stage.equals("parse") ? "FAIL" : "PASS");
            checks.put("native_aom_rm_profile", stage.equals("parse") ? "NOT_EXECUTED"
                    : (valid || stage.startsWith("output_")) ? "PASS" : "FAIL");
            if (result.get("operation").equals("compile/template")) {
                checks.put("opt_output_parse", stage.equals("output_parse") ? "FAIL"
                        : (valid || stage.equals("output_validation")) ? "PASS" : "NOT_EXECUTED");
                checks.put("opt_output_native_profile", valid ? "PASS" : stage.equals("output_validation") ? "FAIL" : "NOT_EXECUTED");
            }
        }
        checks.put("external_terminology", "NOT_EXECUTED");
        checks.put("clinical_review", "NOT_EXECUTED");
        result.put("checks", checks);
        return result;
    }
    private static Map<String, Object> finding(String severity, String code, String location, String message, String source) {
        return Map.of("severity", severity, "code", code, "location", location, "message", message,
                "evidence", Map.of("source", source), "remediation", "Correct the reported native constraint or dependency and revalidate.");
    }
    private static void limit(List<?> list) { if (list.size() > 1000) throw new EngineException("ENGINE_FINDING_LIMIT"); }
    private static String safe(String message) { return message == null ? "Native validation failed." : message.substring(0, Math.min(2000, message.length())); }
    static String sha256(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
