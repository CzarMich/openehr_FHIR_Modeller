package org.openehr.modelling.engine;

import com.nedap.archie.aom.ArchetypeSlot;
import com.nedap.archie.aom.primitives.CString;
import com.nedap.archie.base.MultiplicityInterval;
import com.nedap.archie.rules.*;
import java.util.*;
import java.util.regex.Pattern;
import org.openehr.referencemodels.BuiltinReferenceModels;
import org.w3c.dom.*;
import static org.openehr.modelling.engine.SafeXml.*;

/** Closed OET compatibility profile. Unsupported edits are errors, never ignored. */
final class LegacyTemplateCompiler {
    static final String RM_RELEASE = "1.0.2";
    private final Map<String, LegacyArchetype> sources = new TreeMap<>();
    private final Set<String> used = new HashSet<>();
    private final List<Map<String, String>> actions = new ArrayList<>();
    private final List<Map.Entry<Element, String>> annotations = new ArrayList<>();
    private LegacyOptWriter writer;
    private int placements;
    private final Set<Element> openAttributes = Collections.newSetFromMap(new IdentityHashMap<>());

    record Result(String content, String identifier, List<Map<String, String>> actions) {}

    Result compile(String content, List<Request.Dependency> dependencies) {
        for (var dependency : dependencies) {
            if (!NativeEngine.sha256(dependency.content()).equals(dependency.sha256())) throw new EngineException("ENGINE_DEPENDENCY_HASH_MISMATCH");
            var source = LegacyArchetype.parse(dependency.content());
            if (!source.identifier().equals(dependency.identifier())) throw new EngineException("ENGINE_DEPENDENCY_ID_MISMATCH");
            if (sources.putIfAbsent(source.identifier(), source) != null) throw new EngineException("ENGINE_DEPENDENCY_ID_DUPLICATE");
            String explicit = source.model().getRmRelease();
            if (explicit != null && !RM_RELEASE.equals(explicit)) throw new EngineException("ENGINE_DEPENDENCY_RM_MISMATCH");
            source.model().setRmRelease(RM_RELEASE);
        }
        Element oet = parse(content).getDocumentElement();
        closed(oet, OET, Set.of("id", "name", "description", "definition"), Set.of());
        if (!"template".equals(oet.getLocalName())) throw new EngineException("ENGINE_DOCUMENT_KIND_MISMATCH");
        String uid = scalar(one(oet, "id", true));
        String name = scalar(one(oet, "name", true));
        if (uid.isBlank() || name.isBlank() || uid.length() > 200 || name.length() > 200) throw new EngineException("ENGINE_TEMPLATE_ID_INVALID");
        Element definition = one(oet, "definition", true);
        var rootSource = source(definition);
        String language = rootSource.model().getOriginalLanguage().getCodeString();
        writer = new LegacyOptWriter(language, BuiltinReferenceModels.getMetaModelProvider().getMetaModel(rootSource.model()));
        LegacyOptWriter.phrase(add(writer.template, "language"), rootSource.model().getOriginalLanguage());
        Element description = one(oet, "description", false);
        description(description, rootSource, name);
        // OET id is source identity; it is preserved verbatim in the build actions. Only actual UUIDs become OPT uid.
        if (uid.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) value(add(writer.template, "uid"), "value", uid);
        actions.add(Map.of("code", "OET_SOURCE_ID", "location", "/", "value", uid));
        value(add(writer.template, "template_id"), "value", name);
        value(writer.template, "concept", name);
        Element root = assemble(definition, "definition", 0);
        writer.template.appendChild(root);
        if (!used.equals(sources.keySet())) throw new EngineException("ENGINE_UNUSED_DEPENDENCY");
        actions.addAll(writer.referenceActions);
        finishSlots(root);
        validateMultiplicityTree(root);
        writer.ontology(writer.template, "ontology", rootSource);
        for (var source : writer.components.values()) if (!source.identifier().equals(rootSource.identifier())) writer.ontology(writer.template, "component_ontologies", source);
        for (var annotation : annotations) {
            Element target = add(writer.template, "annotations"); target.setAttribute("path", path(annotation.getKey()));
            value(target, "items", annotation.getValue()).setAttribute("id", "annotation");
        }
        String output = serialize(writer.document);
        LegacyOptSchema.validate(output);
        return new Result(output, name, List.copyOf(actions));
    }

    private Element assemble(Element specification, String elementName, int depth) {
        if (depth > 32 || ++placements > 1024) throw new EngineException("ENGINE_COMPONENT_LIMIT");
        closed(specification, OET, Set.of("Content", "Item", "Items", "Rule"),
                Set.of("archetype_id", "path", "min", "max", "name", "annotation"));
        var source = source(specification);
        if (!type(specification).equals(source.model().getDefinition().getRmTypeName())) throw new EngineException("ENGINE_OET_RM_TYPE_MISMATCH");
        used.add(source.identifier());
        Element root = writer.root(source, elementName);
        if (depth == 0 && (specification.hasAttribute("min") || specification.hasAttribute("max"))) {
            int min = specification.hasAttribute("min") ? number(specification.getAttribute("min"), false) : 1;
            int max = specification.hasAttribute("max") ? number(specification.getAttribute("max"), true) : 1;
            if (min != 1 || max != 1) throw new EngineException("ENGINE_TEMPLATE_ROOT_MULTIPLICITY");
        }
        applyName(root, specification);
        if (specification.hasAttribute("annotation")) annotations.add(Map.entry(root, specification.getAttribute("annotation")));
        Map<Element, List<Element>> fills = new IdentityHashMap<>();
        for (Element item : children(specification)) {
            if ("Rule".equals(item.getLocalName())) continue;
            String placementElement = switch (source.model().getDefinition().getRmTypeName()) {
                case "COMPOSITION" -> "Content"; case "SECTION" -> "Item"; default -> "Items";
            };
            if (!placementElement.equals(item.getLocalName())) throw new EngineException("ENGINE_OET_PLACEMENT_KIND_INVALID");
            if (!item.hasAttribute("path")) throw new EngineException("ENGINE_OET_PATH_REQUIRED");
            Element target = placementTarget(root, item.getAttribute("path"));
            Element placement = assemble(item, "children", depth + 1);
            if ("attributes".equals(target.getLocalName()) && (openAttributes.contains(target) || children(target, "children").isEmpty())) {
                openAttributes.add(target);
                Element owner = (Element) target.getParentNode();
                String attributeName = text(target, "rm_attribute_name");
                if (!writer.rm.typeConformant(text(owner, "rm_type_name"), attributeName, text(placement, "rm_type_name")))
                    throw new EngineException("ENGINE_RM_CHILD_TYPE_INVALID");
                if (upper(one(target, "existence", true)) == 0) throw new EngineException("ENGINE_ATTRIBUTE_EXCLUDED");
                int min = item.hasAttribute("min") ? number(item.getAttribute("min"), false) : lower(one(placement, "occurrences", true));
                int max = item.hasAttribute("max") ? number(item.getAttribute("max"), true) : upper(one(placement, "occurrences", true));
                if (!writer.rm.isMultiple(text(owner, "rm_type_name"), attributeName) && max > 1)
                    throw new EngineException("ENGINE_MULTIPLICITY_INVALID");
                replaceInterval(placement, "occurrences", min, max);
                target.insertBefore(placement, one(target, "cardinality", false));
                actions.add(Map.of("code", "RM_UNCONSTRAINED_ATTRIBUTE_NARROWED", "location", path(target), "value", source(item).identifier()));
                continue;
            }
            var candidates = "attributes".equals(target.getLocalName()) ? children(target, "children") : List.of(target);
            var matches = new ArrayList<Element>();
            for (Element candidate : candidates) {
                var slot = writer.slots.get(candidate);
                if (slot != null && slotMatches(slot, source(item))) matches.add(candidate);
            }
            if (matches.size() != 1) throw new EngineException(matches.isEmpty() ? "ENGINE_SLOT_NO_MATCH" : "ENGINE_SLOT_AMBIGUOUS");
            Element slot = matches.getFirst();
            if (upper(one(slot, "occurrences", true)) == 0) throw new EngineException("ENGINE_SLOT_EXCLUDED");
            // Each placement is bounded by the slot. Aggregated slot bounds are checked below.
            var bounds = intervalOf(slot, "occurrences");
            int min = item.hasAttribute("min") ? number(item.getAttribute("min"), false) : bounds.getLower();
            int max = item.hasAttribute("max") ? number(item.getAttribute("max"), true) : upper(one(slot, "occurrences", true));
            replaceInterval(placement, "occurrences", min, max);
            slot.getParentNode().insertBefore(placement, slot);
            fills.computeIfAbsent(slot, ignored -> new ArrayList<>()).add(placement);
        }
        for (var fill : fills.entrySet()) {
            checkAggregate(fill.getValue(), one(fill.getKey(), "occurrences", true));
            fill.getKey().getParentNode().removeChild(fill.getKey());
        }
        for (Element rule : children(specification, "Rule")) applyRule(root, rule);
        return root;
    }

    private Element placementTarget(Element root, String path) {
        try { return resolve(root, path); }
        catch (EngineException error) {
            if (!error.code.equals("ENGINE_OET_PATH_MISSING")) throw error;
            int split = path.lastIndexOf('/');
            String name = path.substring(split + 1);
            if (!name.matches("[a-z][a-z0-9_]*")) throw error;
            Element owner = resolve(root, split == 0 ? "/" : path.substring(0, split));
            if ("attributes".equals(owner.getLocalName())) throw error;
            String rmType = text(owner, "rm_type_name");
            if (!writer.rm.attributeExists(rmType, name)) throw new EngineException("ENGINE_RM_ATTRIBUTE_INVALID");
            if (attribute(owner, name) != null) throw error;
            Element target = add(owner, "attributes");
            Node before = one(owner, "archetype_id", false);
            if (before != null) owner.insertBefore(target, before);
            boolean multiple = writer.rm.isMultiple(rmType, name);
            type(target, multiple ? "C_MULTIPLE_ATTRIBUTE" : "C_SINGLE_ATTRIBUTE");
            value(target, "rm_attribute_name", name);
            LegacyOptWriter.interval(add(target, "existence"), new MultiplicityInterval(writer.rm.isNullable(rmType, name) ? 0 : 1, 1));
            if (multiple) {
                Element cardinality = add(target, "cardinality");
                var property = writer.rm.getBmmModel().propertyAtPath(rmType, name);
                if (!(property instanceof org.openehr.bmm.core.BmmContainerProperty container))
                    throw new EngineException("ENGINE_RM_CONTAINER_UNSUPPORTED");
                String kind = container.getType().getContainerType().getName().toLowerCase(Locale.ROOT);
                if (!Set.of("list", "set", "array").contains(kind)) throw new EngineException("ENGINE_RM_CONTAINER_UNSUPPORTED");
                value(cardinality, "is_ordered", !kind.equals("set")); value(cardinality, "is_unique", kind.equals("set"));
                LegacyOptWriter.interval(add(cardinality, "interval"), writer.rm.referenceModelPropMultiplicity(rmType, name));
            }
            openAttributes.add(target);
            return target;
        }
    }

    private LegacyArchetype source(Element element) {
        String id = element.getAttribute("archetype_id");
        var source = sources.get(id);
        if (source == null) throw new EngineException("ENGINE_DEPENDENCY_MISSING");
        return source;
    }

    private static boolean slotMatches(ArchetypeSlot slot, LegacyArchetype source) {
        var rm = BuiltinReferenceModels.getMetaModelProvider().getMetaModel(source.model());
        if (!rm.rmTypesConformant(source.model().getDefinition().getRmTypeName(), slot.getRmTypeName())) return false;
        // ADL 1.4 include clauses restrict eligibility; ADL 2 recommendation semantics do not apply here.
        boolean includes = slot.getIncludes() == null || slot.getIncludes().isEmpty();
        if (slot.getIncludes() != null) for (var include : slot.getIncludes()) includes |= assertion(include.getExpression(), source);
        boolean excludes = false;
        if (slot.getExcludes() != null) for (var exclude : slot.getExcludes()) excludes |= assertion(exclude.getExpression(), source);
        return includes && !excludes;
    }

    private static boolean assertion(Expression expression, LegacyArchetype source) {
        if (expression instanceof BinaryOperator binary && binary.getOperator() == OperatorKind.matches
                && binary.getLeftOperand() instanceof ModelReference reference && reference.getVariableReferencePrefix() == null
                && binary.getRightOperand() instanceof Constraint<?> constraint && constraint.getItem() instanceof CString strings) {
            String subject = switch (reference.getPath()) {
                case "archetype_id", "archetype_id/value" -> source.identifier();
                case "short_concept_name" -> source.model().getArchetypeId().getConceptId();
                default -> throw new EngineException("ENGINE_SLOT_ASSERTION_UNSUPPORTED");
            };
            boolean match = false;
            for (String value : strings.getConstraint()) {
                if (CString.isRegexConstraint(value)) {
                    try { match |= Pattern.compile(value.substring(1, value.length() - 1)).matcher(subject).matches(); }
                    catch (IllegalArgumentException e) { throw new EngineException("ENGINE_SLOT_PATTERN_INVALID"); }
                } else match |= subject.equals(value);
            }
            return match;
        }
        if (expression instanceof BinaryOperator binary && Set.of(OperatorKind.and, OperatorKind.or, OperatorKind.xor).contains(binary.getOperator())) {
            boolean left = assertion(binary.getLeftOperand(), source), right = assertion(binary.getRightOperand(), source);
            return switch (binary.getOperator()) { case and -> left && right; case or -> left || right; default -> left ^ right; };
        }
        if (expression instanceof UnaryOperator unary && unary.getOperator() == OperatorKind.not) return !assertion(unary.getOperand(), source);
        throw new EngineException("ENGINE_SLOT_ASSERTION_UNSUPPORTED");
    }

    private void applyRule(Element root, Element rule) {
        closed(rule, OET, Set.of("constraint"), Set.of("path", "min", "max", "name", "annotation"));
        Element target = resolve(root, rule.getAttribute("path"));
        String interval = "attributes".equals(target.getLocalName()) ? "existence" : "occurrences";
        if (rule.hasAttribute("min") || rule.hasAttribute("max")) {
            Element old = one(target, interval, true);
            int min = rule.hasAttribute("min") ? number(rule.getAttribute("min"), false) : lower(old);
            int max = rule.hasAttribute("max") ? number(rule.getAttribute("max"), true) : upper(old);
            if (min < lower(old) || max > upper(old)) throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
            replaceInterval(target, interval, min, max);
        }
        applyName(target, rule);
        Element constraint = one(rule, "constraint", false);
        if (constraint != null) LegacyOetConstraints.apply(target, constraint);
        if (rule.hasAttribute("annotation")) annotations.add(Map.entry(target, rule.getAttribute("annotation")));
    }

    private void applyName(Element target, Element rule) {
        if (!rule.hasAttribute("name")) return;
        String name = rule.getAttribute("name");
        if (name.isBlank() || name.length() > 1000) throw new EngineException("ENGINE_NAME_CONSTRAINT_INVALID");
        if ("attributes".equals(target.getLocalName())) throw new EngineException("ENGINE_NAME_CONSTRAINT_INVALID");
        Element attribute = attribute(target, "name");
        if (attribute != null && !children(attribute, "children").isEmpty()) {
            narrowExistingName(attribute, name);
            actions.add(Map.of("code", "EXISTING_NAME_CONSTRAINT_NARROWED", "location", path(target), "value", name));
            return;
        }
        if (attribute == null) {
            attribute = add(target, "attributes");
            Node before = one(target, "archetype_id", false);
            if (before != null) target.insertBefore(attribute, before);
            type(attribute, "C_SINGLE_ATTRIBUTE"); value(attribute, "rm_attribute_name", "name");
            LegacyOptWriter.interval(add(attribute, "existence"), new MultiplicityInterval(1, 1));
        }
        Element dv = add(attribute, "children"); type(dv, "C_COMPLEX_OBJECT");
        common(dv, "DV_TEXT");
        Element valueAttribute = add(dv, "attributes"); type(valueAttribute, "C_SINGLE_ATTRIBUTE");
        value(valueAttribute, "rm_attribute_name", "value"); LegacyOptWriter.interval(add(valueAttribute, "existence"), new MultiplicityInterval(1, 1));
        Element value = add(valueAttribute, "children"); type(value, "C_PRIMITIVE_OBJECT"); common(value, "String");
        Element item = add(value, "item"); type(item, "C_STRING"); value(item, "list", name);
    }

    private static void narrowExistingName(Element attribute, String name) {
        Element text = one(attribute, "children", true);
        if (!"C_COMPLEX_OBJECT".equals(type(text)) || !"DV_TEXT".equals(text(text, "rm_type_name"))) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        Element valueAttribute = attribute(text, "value");
        if (valueAttribute == null || !"C_SINGLE_ATTRIBUTE".equals(type(valueAttribute))) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        Element primitive = one(valueAttribute, "children", true);
        if (!"C_PRIMITIVE_OBJECT".equals(type(primitive))) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        if (!"string".equals(text(primitive, "rm_type_name"))) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        Element item = one(primitive, "item", true);
        if (!"C_STRING".equals(type(item))) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        if (!children(item, "pattern").isEmpty() || !children(item, "range").isEmpty()) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        if (!children(item, "list_open").isEmpty()) {
            throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        }
        List<Element> values = children(item, "list");
        if (values.isEmpty()) throw new EngineException("ENGINE_NAME_REFINEMENT_UNSUPPORTED");
        Element assumed = one(item, "assumed_value", false);
        if (assumed != null && values.stream().noneMatch(value -> assumed.getTextContent().equals(value.getTextContent()))) {
            throw new EngineException("ENGINE_NAME_CONSTRAINT_INVALID_" + assumed.getTextContent() + "_" + values.stream().map(Element::getTextContent).toList());
        }
        boolean matched = false;
        for (Element value : values) {
            if (name.equals(value.getTextContent())) matched = true;
            else item.removeChild(value);
        }
        if (!matched) throw new EngineException("ENGINE_NAME_CONSTRAINT_EMPTY");
        if (assumed != null) assumed.setTextContent(name);
    }

    private void finishSlots(Element root) {
        for (Element attribute : children(root, "attributes")) {
            for (Element child : children(attribute, "children")) {
                if (writer.slots.containsKey(child)) {
                    if (lower(one(child, "occurrences", true)) > 0) throw new EngineException("ENGINE_REQUIRED_SLOT_UNFILLED");
                    // Preserve an explicit exclusion instead of accidentally making an empty attribute unconstrained.
                    replaceInterval(child, "occurrences", 0, 0);
                    type(child, "C_COMPLEX_OBJECT");
                    actions.add(Map.of("code", "OPTIONAL_SLOT_EXCLUDED", "location", path(child), "value", text(child, "rm_type_name")));
                } else finishSlots(child);
            }
        }
    }

    private static void validateMultiplicityTree(Element root) {
        for (Element attribute : children(root, "attributes")) {
            var objects = children(attribute, "children");
            if ("C_MULTIPLE_ATTRIBUTE".equals(type(attribute)) && !objects.isEmpty()) {
                Element range = one(one(attribute, "cardinality", true), "interval", true);
                long minimum = 0, maximum = 0;
                for (Element child : objects) { minimum += lower(one(child, "occurrences", true)); maximum += upper(one(child, "occurrences", true)); }
                if (minimum > upper(range) || maximum < lower(range)) throw new EngineException("ENGINE_CARDINALITY_UNSATISFIABLE");
            }
            for (Element object : objects) validateMultiplicityTree(object);
        }
    }

    static Element resolve(Element root, String path) {
        if ("/".equals(path)) return root;
        if (path.length() > 2048 || !path.startsWith("/") || path.endsWith("/")) throw new EngineException("ENGINE_OET_PATH_INVALID");
        Element current = root;
        String[] segments = path.substring(1).split("/", -1);
        for (int i = 0; i < segments.length; i++) {
            var match = Pattern.compile("([a-z][a-z0-9_]*)(?:\\[([A-Za-z0-9_.:-]+)\\])?").matcher(segments[i]);
            if (!match.matches()) throw new EngineException("ENGINE_OET_PATH_UNSUPPORTED");
            Element attribute = attribute(current, match.group(1));
            if (attribute == null) throw new EngineException("ENGINE_OET_PATH_MISSING");
            String predicate = match.group(2);
            if (predicate == null && i == segments.length - 1) return attribute;
            var matches = children(attribute, "children").stream().filter(child -> predicate == null || predicate.equals(text(child, "node_id"))
                    || (one(child, "archetype_id", false) != null && predicate.equals(text(one(child, "archetype_id", true), "value")))).toList();
            if (matches.size() != 1) throw new EngineException("ENGINE_OET_PATH_AMBIGUOUS");
            current = matches.getFirst();
        }
        return current;
    }

    static Element attribute(Element object, String name) {
        var matches = children(object, "attributes").stream().filter(value -> name.equals(text(value, "rm_attribute_name"))).toList();
        if (matches.size() > 1) throw new EngineException("ENGINE_DUPLICATE_ATTRIBUTE");
        return matches.isEmpty() ? null : matches.getFirst();
    }
    static String path(Element node) {
        if (node.getParentNode() == null || "definition".equals(node.getLocalName())) return "/";
        if ("attributes".equals(node.getLocalName())) return path((Element) node.getParentNode()).replaceAll("/$", "") + "/" + text(node, "rm_attribute_name");
        Element parent = (Element) node.getParentNode();
        String id = one(node, "archetype_id", false) == null ? text(node, "node_id") : text(one(node, "archetype_id", true), "value");
        return path(parent) + (id.isEmpty() ? "" : "[" + id + "]");
    }
    static int number(String text, boolean unbounded) {
        if (unbounded && "-1".equals(text)) return Integer.MAX_VALUE;
        if (!text.matches("0|[1-9][0-9]{0,8}")) throw new EngineException("ENGINE_MULTIPLICITY_INVALID");
        return Integer.parseInt(text);
    }
    static int lower(Element interval) { return Integer.parseInt(text(interval, "lower")); }
    static int upper(Element interval) { return "true".equals(text(interval, "upper_unbounded")) ? Integer.MAX_VALUE : Integer.parseInt(text(interval, "upper")); }
    static MultiplicityInterval intervalOf(Element node, String name) {
        Element interval = one(node, name, true);
        return upper(interval) == Integer.MAX_VALUE ? MultiplicityInterval.createUpperUnbounded(lower(interval)) : new MultiplicityInterval(lower(interval), upper(interval));
    }
    static void replaceInterval(Element object, String name, int min, int max) {
        if (min < 0 || max < min) throw new EngineException("ENGINE_MULTIPLICITY_INVALID");
        Element interval = one(object, name, true);
        while (interval.hasChildNodes()) interval.removeChild(interval.getFirstChild());
        LegacyOptWriter.interval(interval, max == Integer.MAX_VALUE ? MultiplicityInterval.createUpperUnbounded(min) : new MultiplicityInterval(min, max));
    }
    private static void checkAggregate(List<Element> fills, Element interval) {
        long min = 0, max = 0;
        for (var fill : fills) { min += lower(one(fill, "occurrences", true)); max += upper(one(fill, "occurrences", true)); }
        if (min < lower(interval) || (upper(interval) != Integer.MAX_VALUE && max > upper(interval))) throw new EngineException("ENGINE_SLOT_OCCURRENCES_INVALID");
    }
    private static void common(Element object, String type) {
        value(object, "rm_type_name", type); LegacyOptWriter.interval(add(object, "occurrences"), new MultiplicityInterval(1, 1)); value(object, "node_id", "");
    }
    private void description(Element source, LegacyArchetype root, String name) {
        String lifecycle = "Initial";
        Element sourceDetails = null;
        if (source != null) {
            closed(source, OET, Set.of("lifecycle_state", "details"), Set.of());
            lifecycle = scalar(one(source, "lifecycle_state", true));
            sourceDetails = one(source, "details", false);
            if (sourceDetails != null) closed(sourceDetails, OET, Set.of("purpose", "use", "misuse"), Set.of());
        }
        actions.add(Map.of("code", "OET_SOURCE_LIFECYCLE", "location", "/", "value", lifecycle));
        // The OPT XSD permits no description, but downstream Web Template parsers
        // need a description with language details. Do not invent a human author.
        Element description = add(writer.template, "description");
        value(description, "original_author", "openEHR Modelling Assistant").setAttribute("id", "generator");
        value(description, "lifecycle_state", lifecycle);
        Element details = add(description, "details");
        LegacyOptWriter.phrase(add(details, "language"), root.model().getOriginalLanguage());
        Element purpose = sourceDetails == null ? null : one(sourceDetails, "purpose", false);
        value(details, "purpose", purpose == null ? "Draft model: " + name : scalar(purpose));
        for (String field : List.of("use", "misuse")) {
            Element value = sourceDetails == null ? null : one(sourceDetails, field, false);
            if (value != null) value(details, field, scalar(value));
        }
        actions.add(Map.of("code", "OPT_DESCRIPTION_FOR_INTEROPERABILITY", "location", "/description", "value", "Template language, lifecycle and purpose; generator attribution only."));
    }
    private static String scalar(Element source) {
        closed(source, OET, Set.of(), Set.of());
        return source.getTextContent();
    }
}
