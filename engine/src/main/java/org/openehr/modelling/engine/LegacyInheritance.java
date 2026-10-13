package org.openehr.modelling.engine;

import com.nedap.archie.adlparser.antlr.Adl14Parser.*;
import com.nedap.archie.aom.*;
import com.nedap.archie.adl14.aom14.*;
import com.nedap.archie.rminfo.MetaModel;
import org.antlr.v4.runtime.ParserRuleContext;
import org.antlr.v4.runtime.misc.Interval;
import org.openehr.referencemodels.BuiltinReferenceModels;
import java.util.*;

/** Inherit original legacy syntax, without ADL2 conversion or changed terminology identities. */
final class LegacyInheritance {
    private final Map<String, LegacyArchetype> sources;
    private final Map<String, LegacyArchetype> flattened = new TreeMap<>();
    private final Set<String> visiting = new HashSet<>();
    private final Set<String> used;
    private final List<Map<String, String>> actions;
    private int nodes;

    LegacyInheritance(Map<String, LegacyArchetype> sources, Set<String> used, List<Map<String, String>> actions) {
        this.sources = sources; this.used = used; this.actions = actions;
    }

    LegacyArchetype resolve(String identifier) {
        used.add(identifier);
        if (flattened.containsKey(identifier)) return flattened.get(identifier);
        var child = sources.get(identifier);
        if (child == null) throw new EngineException("ENGINE_DEPENDENCY_MISSING");
        if (!visiting.add(identifier)) throw new EngineException("ENGINE_SPECIALIZATION_CYCLE");
        if (visiting.size() > 32) throw new EngineException("ENGINE_SPECIALIZATION_DEPTH_LIMIT");
        try {
            var specialization = child.syntax().specialization_section();
            if (specialization == null) { flattened.put(identifier, child); return child; }
            String parentId = specialization.archetype_ref().getText();
            var parent = resolve(parentId);
            if (!child.model().getOriginalLanguage().getCodeString().equals(parent.model().getOriginalLanguage().getCodeString()))
                throw new EngineException("ENGINE_SPECIALIZATION_LANGUAGE_MISMATCH");
            if (child.syntax().rules_section() != null || parent.syntax().rules_section() != null)
                throw new EngineException("ENGINE_ADL14_RULES_UNSUPPORTED");
            var rm = BuiltinReferenceModels.getMetaModelProvider().getMetaModel(child.model());
            String definition = object(parent.model().getDefinition(), parent.syntax().definition_section().c_complex_object(),
                    child.model().getDefinition(), child.syntax().definition_section().c_complex_object(), rm, 0);
            var original = child.syntax().definition_section().c_complex_object();
            String content = child.syntax().getStart().getInputStream().toString();
            content = content.substring(0, original.getStart().getStartIndex()) + definition
                    + content.substring(original.getStop().getStopIndex() + 1);
            var parsed = LegacyArchetype.parse(content);
            parsed.model().setRmRelease(child.model().getRmRelease());
            var ontology = mergeOntology(parent.ontology(), child.ontology());
            var result = new LegacyArchetype(parsed.model(), ontology, identifier, child.sourceSha256(), parsed.syntax(), true);
            flattened.put(identifier, result);
            actions.add(Map.of("code", "ADL14_SPECIALIZATION_FLATTENED", "location", identifier, "value", parentId));
            return result;
        } finally { visiting.remove(identifier); }
    }

    private String object(CObject parent, C_complex_objectContext parentSyntax, CObject child,
            C_complex_objectContext childSyntax, MetaModel rm, int depth) {
        if (depth > 64 || ++nodes > 20000) throw new EngineException("ENGINE_NODE_LIMIT");
        if (!codesConform(child.getNodeId(), parent.getNodeId()) || !child.typeNameConformsTo(parent, rm::rmTypesConformant))
            throw new EngineException("ENGINE_SPECIALIZATION_TYPE_OR_NODE_MISMATCH");
        if (childSyntax.c_occurrences() != null && !(parent.getOccurrences() == null ? new com.nedap.archie.base.MultiplicityInterval(1, 1) : parent.getOccurrences()).contains(child.getOccurrences()))
            throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
        String head = text(childSyntax.type_id()) + (childSyntax.atTypeId() == null ? "" : text(childSyntax.atTypeId()));
        var occurrence = childSyntax.c_occurrences() == null ? parentSyntax.c_occurrences() : childSyntax.c_occurrences();
        if (occurrence != null) head += " " + text(occurrence);
        var inherited = attributes(parent, parentSyntax);
        var local = attributes(child, childSyntax);
        List<String> attributes = new ArrayList<>();
        for (var entry : inherited.entrySet()) {
            var override = local.remove(entry.getKey());
            attributes.add(override == null ? text(entry.getValue().syntax())
                    : attribute(entry.getValue(), override, rm, depth + 1));
        }
        for (var value : local.values()) attributes.add(text(value.syntax()));
        return head + " matches { " + (attributes.isEmpty() ? "*" : String.join("\n", attributes)) + " }";
    }

    record Attribute(CAttribute model, C_attributeContext syntax) {}
    private Map<String, Attribute> attributes(CObject object, C_complex_objectContext syntax) {
        if (object.getAttributes().size() != syntax.c_attribute_def().size())
            throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
        var result = new LinkedHashMap<String, Attribute>();
        for (int i = 0; i < object.getAttributes().size(); i++) {
            var attribute = syntax.c_attribute_def(i).c_attribute();
            if (attribute == null || attribute.attribute_id() == null)
                throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
            String name = object.getAttributes().get(i).getRmAttributeName();
            if (result.putIfAbsent(name, new Attribute(object.getAttributes().get(i), attribute)) != null)
                throw new EngineException("ENGINE_RM_ATTRIBUTE_INVALID");
        }
        return result;
    }

    private String attribute(Attribute parent, Attribute child, MetaModel rm, int depth) {
        if (!child.model().existenceConformsTo(parent.model()) || !child.model().cardinalityConformsTo(parent.model()))
            throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
        var p = parent.syntax(); var c = child.syntax();
        String head = text(c.attribute_id());
        var existence = c.c_existence() == null ? p.c_existence() : c.c_existence();
        var cardinality = c.c_cardinality() == null ? p.c_cardinality() : c.c_cardinality();
        if (existence != null) head += " " + text(existence);
        if (cardinality != null) head += " " + text(cardinality);
        if (c.c_objects() == null) {
            if (c.CONTAINED_REGEXP() != null) {
                if (p.CONTAINED_REGEXP() != null && !text(c).equals(text(p)))
                    throw new EngineException("ENGINE_SPECIALIZATION_CONSTRAINT_UNSUPPORTED");
                if (!parent.model().getChildren().isEmpty() && p.CONTAINED_REGEXP() == null)
                    throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
                return head + " matches " + c.CONTAINED_REGEXP().getText();
            }
            if (p.c_objects() != null) return head + " matches { " + text(p.c_objects()) + " }";
            if (p.CONTAINED_REGEXP() != null) return head + " matches " + p.CONTAINED_REGEXP().getText();
            return head + " matches {*}";
        }
        if (parent.model().getChildren().isEmpty()) return head + " matches { " + text(c.c_objects()) + " }";
        if (c.c_objects().c_primitive_object() != null || p.c_objects() == null || p.c_objects().c_primitive_object() != null) {
            // Source syntax equivalence is essential for legacy domain extensions and open lists.
            if (p.c_objects() == null || !c.c_objects().getText().equals(p.c_objects().getText()))
                throw new EngineException("ENGINE_SPECIALIZATION_CONSTRAINT_UNSUPPORTED");
            return head + " matches { " + text(c.c_objects()) + " }";
        }
        var parentNodes = p.c_objects().c_non_primitive_object_ordered();
        var childNodes = c.c_objects().c_non_primitive_object_ordered();
        if (parentNodes.size() != parent.model().getChildren().size() || childNodes.size() != child.model().getChildren().size())
            throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
        List<String> values = new ArrayList<>(); Set<Integer> replaced = new HashSet<>();
        for (int i = 0; i < childNodes.size(); i++) {
            var node = child.model().getChildren().get(i);
            List<Integer> matches = new ArrayList<>();
            for (int j = 0; j < parentNodes.size(); j++) {
                var candidate = parent.model().getChildren().get(j);
                if (codesConform(node.getNodeId(), candidate.getNodeId()) && node.typeNameConformsTo(candidate, rm::rmTypesConformant)) matches.add(j);
            }
            if (matches.size() > 1) {
                var exact = matches.stream().filter(j -> node.getRmTypeName().equals(parent.model().getChildren().get(j).getRmTypeName())).toList();
                if (exact.size() == 1) matches = new ArrayList<>(exact);
            }
            if (matches.size() > 1) throw new EngineException("ENGINE_SPECIALIZATION_NODE_AMBIGUOUS");
            if (matches.isEmpty()) {
                if (child.model().getCardinality() == null || node.getNodeId() == null || !node.getNodeId().matches("at0(?:\\.0)*\\.[1-9][0-9]*"))
                    throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
                values.add(text(childNodes.get(i))); continue;
            }
            int j = matches.getFirst();
            if (!replaced.add(j)) throw new EngineException("ENGINE_SPECIALIZATION_NODE_AMBIGUOUS");
            var parentNode = parentNodes.get(j).c_non_primitive_object();
            var childNode = childNodes.get(i).c_non_primitive_object();
            if (childNodes.get(i).sibling_order() != null) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
            if (parentNode.c_complex_object() != null && childNode.c_complex_object() != null) {
                values.add(object(parent.model().getChildren().get(j), parentNode.c_complex_object(), node, childNode.c_complex_object(), rm, depth));
            } else {
                if (!childNodes.get(i).getText().equals(parentNodes.get(j).getText()))
                    throw new EngineException("ENGINE_SPECIALIZATION_CONSTRAINT_UNSUPPORTED");
                values.add(text(childNodes.get(i)));
            }
        }
        // Omitted constraints are inherited; explicit occurrences {0} is required to exclude a node.
        for (int j = 0; j < parentNodes.size(); j++) if (!replaced.contains(j)) values.add(text(parentNodes.get(j)));
        return head + " matches { " + String.join("\n", values) + " }";
    }

    private static ArchetypeOntology mergeOntology(ArchetypeOntology parent, ArchetypeOntology child) {
        // Separate item maps prevent a specialised translation/binding from mutating another component.
        var result = new ArchetypeOntology();
        mergeItems(result.getTermDefinitions(), parent.getTermDefinitions());
        result.setConstraintDefinitions(new HashMap<>());
        mergeItems(result.getConstraintDefinitions(), parent.getConstraintDefinitions());
        mergeBindings(result.getTermBindings(), parent.getTermBindings());
        result.setConstraintBindings(new HashMap<>());
        if (parent.getConstraintBindings() != null) parent.getConstraintBindings().forEach((system, terms) -> {
            var copy = newConstraintBindings(); copy.getItems().putAll(terms.getItems());
            result.getConstraintBindings().put(system, copy);
        });
        mergeItems(result.getTermDefinitions(), child.getTermDefinitions());
        if (result.getConstraintDefinitions() == null) result.setConstraintDefinitions(new HashMap<>());
        mergeItems(result.getConstraintDefinitions(), child.getConstraintDefinitions());
        mergeBindings(result.getTermBindings(), child.getTermBindings());
        if (result.getConstraintBindings() == null) result.setConstraintBindings(new HashMap<>());
        if (child.getConstraintBindings() != null) child.getConstraintBindings().forEach((system, terms) -> {
            var target = result.getConstraintBindings().computeIfAbsent(system, key -> newConstraintBindings());
            target.getItems().putAll(terms.getItems());
        });
        return result;
    }
    private static void mergeItems(Map<String, TermCodeList> target, Map<String, TermCodeList> source) {
        if (source != null) source.forEach((language, terms) -> {
            var selected = target.computeIfAbsent(language, key -> newTerms());
            selected.getItems().putAll(terms.getItems());
        });
    }
    private static void mergeBindings(Map<String, TermBindingsList> target, Map<String, TermBindingsList> source) {
        if (source != null) source.forEach((system, terms) -> {
            var selected = target.computeIfAbsent(system, key -> newBindings());
            selected.getItems().putAll(terms.getItems());
        });
    }
    private static TermCodeList newTerms() {
        var value = new TermCodeList(); value.setItems(new HashMap<>()); return value;
    }
    private static TermBindingsList newBindings() {
        var value = new TermBindingsList(); value.setItems(new HashMap<>()); return value;
    }
    private static ConstraintBindingsList newConstraintBindings() {
        var value = new ConstraintBindingsList(); value.setItems(new HashMap<>()); return value;
    }
    private static boolean codesConform(String child, String parent) {
        return Objects.equals(child, parent) || (child != null && parent != null && child.startsWith(parent + "."));
    }
    private static String text(ParserRuleContext context) {
        return context.getStart().getInputStream().getText(Interval.of(context.getStart().getStartIndex(), context.getStop().getStopIndex()));
    }
}
