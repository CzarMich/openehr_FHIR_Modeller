package org.openehr.modelling.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.nedap.archie.aom.Archetype;
import com.nedap.archie.aom.ArchetypeHRID;
import com.nedap.archie.rminfo.MetaModel;
import org.openehr.referencemodels.BuiltinReferenceModels;
import org.ehrbase.openehr.sdk.aql.dto.AqlQuery;
import org.ehrbase.openehr.sdk.aql.dto.containment.*;
import org.ehrbase.openehr.sdk.aql.dto.operand.StringPrimitive;
import org.ehrbase.openehr.sdk.aql.dto.path.*;
import java.util.*;
import java.util.stream.Collectors;

/** Structural paths against validated, hash-pinned OPTs; never an execution or value-semantic claim. */
final class AqlTemplatePaths {
    private record Node(String path, String type, String id, String archetype, boolean root, boolean excluded,
                        Map<String, Boolean> attributes) {}
    private record Match(String status, String reason, Set<String> paths) {
        static Match of(String status, String reason) { return new Match(status, reason, Set.of()); }
    }
    private final List<Node> nodes = new ArrayList<>();
    private final Map<String, Map<String, List<Node>>> children = new HashMap<>();
    private final Map<String, Set<String>> constrainedAttributes = new HashMap<>();
    private final Map<String, List<Node>> aliases = new HashMap<>();
    private final List<Map<String, Object>> rows = new ArrayList<>();
    private final MetaModel rm;
    private boolean unsupportedContainment;

    @SuppressWarnings("unchecked")
    static void validate(AqlQuery query, List<Request.Dependency> templates, Map<String, Object> result) {
        List<Map<String, Object>> reports = new ArrayList<>(), manifest = new ArrayList<>();
        List<Map<String, Object>> findings = (List<Map<String, Object>>) result.get("findings");
        String status = "PASS";
        for (Request.Dependency template : templates) {
            Map<String, Object> inspected = new NativeEngine().execute(new Request("inspect/opt", template.content(), List.of()));
            manifest.add(Map.of("identifier", template.identifier(), "sha256", template.sha256(), "selection", "explicit_hash_pinned_input"));
            var report = new LinkedHashMap<String, Object>();
            report.put("identifier", template.identifier()); report.put("sha256", template.sha256());
            report.put("template_id", inspected.getOrDefault("identifier", ""));
            report.put("template_profile", inspected.get("profile"));
            if (!Boolean.TRUE.equals(inspected.get("valid"))) {
                report.put("status", "FAIL"); report.put("paths", List.of());
                report.put("template_findings", inspected.get("findings"));
                findings.add(finding("error", "AQL_TEMPLATE_INVALID", template.identifier(), "The selected OPT did not pass its native validation profile."));
            } else {
                var validator = new AqlTemplatePaths(inspected);
                validator.containment(query.getFrom(), null);
                validator.paths(Json.MAPPER.valueToTree(query));
                String current = validator.rows.stream().anyMatch(row -> row.get("status").equals("FAIL")) ? "FAIL"
                        : validator.unsupportedContainment || validator.rows.stream().anyMatch(row -> row.get("status").equals("INCOMPLETE")) ? "INCOMPLETE" : "PASS";
                report.put("status", current); report.put("paths", validator.rows);
                if (!current.equals("PASS")) findings.add(finding(current.equals("FAIL") ? "error" : "warning", "AQL_TEMPLATE_PATHS_" + current,
                        template.identifier(), current.equals("FAIL") ? "One or more query paths are absent or excluded in this template." : "Some query paths or containment expressions could not be verified completely."));
            }
            String current = (String) report.get("status");
            if (current.equals("FAIL") || status.equals("PASS")) status = current;
            reports.add(report);
        }
        result.put("profile", "AQL_TEMPLATE_PATHS"); result.put("templates", reports); result.put("dependencies", manifest);
        result.put("status", status); result.put("valid", status.equals("PASS")); result.put("completed_stage", "template_paths");
        result.put("checks", Map.of("aql_syntax", "PASS", "model_paths", status, "query_execution", "NOT_EXECUTED",
                "predicate_values", "NOT_EXECUTED", "function_types", "NOT_EXECUTED", "clinical_review", "NOT_EXECUTED"));
        result.put("unexecuted", List.of("query_execution", "predicate_values", "function_types", "clinical_review"));
        result.put("limitations", List.of("Checks structural paths against every selected OPT and its native RM profile; does not execute queries or evaluate data values, function signatures, terminology or clinical meaning.",
                "Unresolved slots, polymorphic RM paths, version containment and boolean containment branches can produce INCOMPLETE; these are never reported as a successful complete path check."));
    }

    @SuppressWarnings("unchecked")
    private AqlTemplatePaths(Map<String, Object> inspected) {
        var view = new Archetype(); view.setArchetypeId(new ArchetypeHRID("openEHR-EHR-COMPOSITION.aql_check.v1.0.0"));
        view.setRmRelease((String) inspected.getOrDefault("rm_release", LegacyTemplateCompiler.RM_RELEASE));
        rm = BuiltinReferenceModels.getMetaModelProvider().getMetaModel(view);
        var inspection = (Map<String, Object>) inspected.get("inspection");
        for (Map<String, Object> item : (List<Map<String, Object>>) inspection.get("paths")) {
            String path = (String) item.get("path"), kind = (String) item.get("constraint_kind");
            Map<String, Boolean> attributes = new HashMap<>();
            for (Map<String, Object> attr : (List<Map<String, Object>>) item.get("attributes"))
                attributes.put((String) attr.get("name"), zero(attr.get("existence")));
            nodes.add(new Node(path, (String) item.get("rm_type"), Objects.toString(item.get("node_id"), ""),
                    Objects.toString(item.get("archetype"), ""), path.equals("/") || Set.of("CArchetypeRoot", "C_ARCHETYPE_ROOT").contains(kind), zero(item.get("occurrences")), attributes));
        }
        // Excluded ancestors also exclude their descendants.
        List<String> excluded = nodes.stream().filter(Node::excluded).map(Node::path).toList();
        for (Node node : nodes) {
            if (node.path().equals("/")) continue;
            int slash = node.path().lastIndexOf('/');
            constrainedAttributes.computeIfAbsent(slash == 0 ? "/" : node.path().substring(0, slash), key -> new HashSet<>())
                    .add(node.path().substring(slash + 1).split("\\[", 2)[0]);
        }
        nodes.removeIf(node -> excluded.stream().anyMatch(path -> node.path().equals(path) || below(node.path(), path)));
        for (Node node : nodes) {
            if (node.path().equals("/")) continue;
            int slash = node.path().lastIndexOf('/');
            String parent = slash == 0 ? "/" : node.path().substring(0, slash);
            String attribute = node.path().substring(slash + 1).split("\\[", 2)[0];
            children.computeIfAbsent(parent, key -> new HashMap<>()).computeIfAbsent(attribute, key -> new ArrayList<>()).add(node);
        }
    }

    private static boolean zero(Object value) { return value != null && Set.of("0", "0..0", "|0..0|").contains(value.toString()); }
    private static boolean below(String path, String parent) { return parent.equals("/") ? !path.equals("/") : path.startsWith(parent + "/"); }

    private void containment(Containment containment, List<Node> parents) {
        if (containment == null) return;
        if (containment instanceof ContainmentSetOperator set) {
            unsupportedContainment = true;
            row("FROM", "INCOMPLETE", "Boolean containment branches require separate interpretation; path matches are reported without an overall pass.", Set.of());
            for (Containment child : set.getValues()) containment(child, parents);
            return;
        }
        if (containment instanceof ContainmentNotOperator || !(containment instanceof ContainmentClassExpression expression)) {
            unsupportedContainment = true;
            row("FROM", "INCOMPLETE", "Version or negated containment is not verified by the selected-template path check.", Set.of());
            return;
        }
        List<Node> matches;
        if (expression.getType().equals("EHR")) {
            matches = List.of(new Node("@EHR", "EHR", "", "", false, false, Map.of()));
        } else {
            matches = nodes.stream().filter(node -> parents == null || parents.stream().anyMatch(parent -> parent.path().equals("@EHR") || below(node.path(), parent.path())))
                    .filter(node -> node.type().equals(expression.getType()) || rm.rmTypesConformant(node.type(), expression.getType()))
                    .filter(node -> predicateMatches(node, expression.getPredicates())).toList();
        }
        if (expression.getIdentifier() != null) aliases.put(expression.getIdentifier(), matches);
        String label = "FROM " + expression.getType() + " " + Objects.toString(expression.getIdentifier(), "");
        if (matches.isEmpty()) row(label, unsupportedContainment ? "INCOMPLETE" : "FAIL", "No matching included node was found in the selected template.", Set.of());
        else {
            Match predicates = predicates(matches, expression.getPredicates());
            row(label, predicates.status(), predicates.reason(), pathsOf(matches));
        }
        containment(expression.getContains(), matches);
    }

    private void paths(JsonNode value) {
        if (value.isObject() && "IdentifiedPath".equals(value.path("_type").asText())) {
            String root = value.path("root").asText(), path = value.path("path").asText("");
            List<Node> starts = aliases.get(root);
            String label = root + (path.isEmpty() ? "" : "/" + path);
            Match checked;
            if (starts == null) checked = Match.of("INCOMPLETE", "The path alias could not be resolved in the supported containment profile.");
            else if (starts.isEmpty()) checked = Match.of(unsupportedContainment ? "INCOMPLETE" : "FAIL", "The selected template has no matching node for this alias.");
            else {
                String rootPredicate = value.path("rootPredicate").asText("");
                var rootPredicates = rootPredicate.isEmpty() ? List.<AndOperatorPredicate>of() : AqlObjectPath.parse("root" + rootPredicate).getPathNodes().getFirst().getPredicateOrOperands();
                starts = starts.stream().filter(node -> predicateMatches(node, rootPredicates)).toList();
                Match predicate = predicates(starts, rootPredicates);
                checked = starts.isEmpty() ? Match.of("FAIL", "The root node predicate has no matching included node in this template.")
                        : path.isEmpty() ? new Match("PASS", "The selected node is present.", pathsOf(starts)) : walk(starts, AqlObjectPath.parse(path).getPathNodes(), 0);
                checked = combine(checked, predicate);
            }
            row(label, checked.status(), checked.reason(), checked.paths());
        }
        if (value.isContainerNode()) value.elements().forEachRemaining(this::paths);
    }

    private Match walk(List<Node> starts, List<AqlObjectPath.PathNode> steps, int index) {
        if (steps.size() > 128) throw new EngineException("ENGINE_FINDING_LIMIT");
        if (index == steps.size()) return new Match("PASS", "Path is present in the selected template or its reference model.", pathsOf(starts));
        var step = steps.get(index);
        List<Node> next = new ArrayList<>();
        boolean uncertain = false;
        for (Node node : starts) {
            if (Boolean.TRUE.equals(node.attributes().get(step.getAttribute()))) continue;
            List<Node> constrained = children.getOrDefault(node.path(), Map.of()).getOrDefault(step.getAttribute(), List.of());
            if (!constrained.isEmpty()) {
                next.addAll(constrained.stream().filter(child -> predicateMatches(child, step.getPredicateOrOperands())).toList());
                continue;
            }
            if (constrainedAttributes.getOrDefault(node.path(), Set.of()).contains(step.getAttribute())) continue;
            if (!rm.attributeExists(node.type(), step.getAttribute())) continue;
            boolean hasPredicates = steps.subList(index, steps.size()).stream().anyMatch(part -> part.getPredicateOrOperands() != null && !part.getPredicateOrOperands().isEmpty());
            if (hasPredicates || node.attributes().containsKey(step.getAttribute())) { uncertain = true; continue; }
            String remaining = "/" + steps.subList(index, steps.size()).stream().map(AqlObjectPath.PathNode::getAttribute).collect(Collectors.joining("/"));
            if (rm.hasReferenceModelPath(node.type(), remaining)) return new Match("PASS", "Path is defined by the template's reference model.", Set.of(node.path() + remaining));
            // A subtype may expose additional fields; an unconstrained abstract tail is not proven invalid.
            String firstType = rm.getBmmModel().effectivePropertyType(node.type(), step.getAttribute());
            var definition = rm.getBmmModel().getClassDefinition(firstType);
            if (definition == null || definition.isAbstract()) uncertain = true;
        }
        if (next.isEmpty()) return Match.of(uncertain ? "INCOMPLETE" : "FAIL", uncertain
                ? "An unconstrained or polymorphic part of this path cannot be verified from the selected template."
                : "Attribute or node predicate is absent or excluded in the selected template: " + step.getAttribute());
        Match checked = walk(next, steps, index + 1);
        return combine(checked, predicates(next, step.getPredicateOrOperands()));
    }

    private boolean predicateMatches(Node node, List<AndOperatorPredicate> alternatives) {
        if (alternatives == null || alternatives.isEmpty()) return true;
        return alternatives.stream().anyMatch(and -> and.getOperands().stream().allMatch(predicate -> {
            if (!predicate.getPath().render().equals("archetype_node_id") || !predicate.getOperator().name().equals("EQ") || !(predicate.getValue() instanceof StringPrimitive literal)) return true;
            String id = literal.getValue();
            return id.equals(node.id()) || (node.root() && id.equals(node.archetype()));
        }));
    }

    private Match predicates(List<Node> starts, List<AndOperatorPredicate> alternatives) {
        if (alternatives == null || alternatives.isEmpty()) return Match.of("PASS", "Included node is present.");
        Match result = Match.of("PASS", "Predicate paths are defined; predicate values are not evaluated.");
        for (AndOperatorPredicate and : alternatives) for (ComparisonOperatorPredicate predicate : and.getOperands()) {
            result = combine(result, walk(starts, predicate.getPath().getPathNodes(), 0));
            if (predicate.getPath().render().equals("archetype_node_id") && (!(predicate.getValue() instanceof StringPrimitive) || !predicate.getOperator().name().equals("EQ")))
                result = combine(result, Match.of("INCOMPLETE", "A dynamic or non-equality archetype predicate cannot be resolved to an exact template node."));
            if (predicate.getValue() instanceof AqlObjectPath other) result = combine(result, walk(starts, other.getPathNodes(), 0));
        }
        return result;
    }

    private static Match combine(Match one, Match two) {
        if (one.status().equals("FAIL")) return one;
        if (two.status().equals("FAIL")) return two;
        if (one.status().equals("INCOMPLETE")) return one;
        if (two.status().equals("INCOMPLETE")) return two;
        return one;
    }
    private static Set<String> pathsOf(List<Node> nodes) { return nodes.stream().map(Node::path).collect(Collectors.toCollection(TreeSet::new)); }
    private void row(String queryPath, String status, String reason, Set<String> matches) {
        if (rows.size() >= 1000) throw new EngineException("ENGINE_FINDING_LIMIT");
        rows.add(Map.of("query_path", queryPath, "status", status, "message", reason, "matched_paths", matches));
    }
    private static Map<String, Object> finding(String severity, String code, String source, String message) {
        return Map.of("severity", severity, "code", code, "location", source, "message", message,
                "evidence", Map.of("source", source), "remediation", "Review the per-path results and the selected template revision.");
    }
}
