package org.openehr.modelling.engine;

import java.math.BigDecimal;
import java.util.*;
import org.w3c.dom.*;
import static org.openehr.modelling.engine.SafeXml.*;
import static org.openehr.modelling.engine.LegacyTemplateCompiler.*;

/** Narrow existing value constraints; never silently replace a different value domain. */
final class LegacyOetConstraints {
    static void apply(Element target, Element constraint) {
        Element attribute = "attributes".equals(target.getLocalName()) ? target : attribute(target, "value");
        if (attribute == null) throw new EngineException("ENGINE_OET_VALUE_PATH_INVALID");
        List<Element> alternatives = children(attribute, "children");
        if (alternatives.isEmpty()) throw new EngineException("ENGINE_OET_UNCONSTRAINED_VALUE_UNSUPPORTED");
        String kind = type(constraint);
        if ("multipleConstraint".equals(kind)) {
            closed(constraint, OET, Set.of("includedTypes"), Set.of());
            var included = values(constraint, "includedTypes");
            if (included.isEmpty()) throw new EngineException("ENGINE_OET_EMPTY_VALUE_DOMAIN");
            if (!alternatives.stream().map(v -> text(v, "rm_type_name")).toList().containsAll(included)) throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
            alternatives.stream().filter(v -> !included.contains(text(v, "rm_type_name"))).forEach(attribute::removeChild);
            return;
        }
        if (alternatives.size() != 1) throw new EngineException("ENGINE_OET_VALUE_TYPE_AMBIGUOUS");
        Element value = alternatives.getFirst();
        switch (kind) {
            case "textConstraint" -> textConstraint(value, constraint);
            case "quantityConstraint" -> quantity(value, constraint);
            default -> throw new EngineException("ENGINE_OET_CONSTRAINT_UNSUPPORTED");
        }
    }

    private static void textConstraint(Element value, Element constraint) {
        closed(constraint, OET, Set.of("includedValues", "excludedValues"), Set.of("limitToList"));
        if (constraint.hasAttribute("limitToList") && !Set.of("true", "1").contains(constraint.getAttribute("limitToList")))
            throw new EngineException("ENGINE_OET_OPEN_VALUE_LIST_UNSUPPORTED");
        var included = values(constraint, "includedValues");
        var excluded = values(constraint, "excludedValues");
        if ("DV_CODED_TEXT".equals(text(value, "rm_type_name"))) {
            Element codesAttribute = attribute(value, "defining_code");
            if (codesAttribute == null || children(codesAttribute, "children").size() != 1) throw new EngineException("ENGINE_OET_VALUE_TYPE_AMBIGUOUS");
            Element codes = children(codesAttribute, "children").getFirst();
            if (!"C_CODE_PHRASE".equals(type(codes))) throw new EngineException("ENGINE_OET_CONSTRAINT_UNSUPPORTED");
            var old = children(codes, "code_list");
            if (old.isEmpty()) throw new EngineException("ENGINE_UNVERIFIED_CODES_PROHIBITED");
            filter(codes, "code_list", included, excluded);
            Element assumed = one(codes, "assumed_value", false);
            if (assumed != null && !values(codes, "code_list").contains(text(assumed, "code_string"))) throw new EngineException("ENGINE_ASSUMED_VALUE_EXCLUDED");
        } else if ("DV_TEXT".equals(text(value, "rm_type_name"))) {
            Element textAttribute = attribute(value, "value");
            if (textAttribute == null || children(textAttribute, "children").isEmpty()) {
                if (included.isEmpty() || !excluded.isEmpty()) throw new EngineException("ENGINE_OET_UNCONSTRAINED_VALUE_UNSUPPORTED");
                if (textAttribute == null) {
                    textAttribute = add(value, "attributes"); type(textAttribute, "C_SINGLE_ATTRIBUTE");
                    value(textAttribute, "rm_attribute_name", "value");
                    LegacyOptWriter.interval(add(textAttribute, "existence"), new com.nedap.archie.base.MultiplicityInterval(1, 1));
                }
                Element primitive = add(textAttribute, "children"); type(primitive, "C_PRIMITIVE_OBJECT");
                value(primitive, "rm_type_name", "String");
                LegacyOptWriter.interval(add(primitive, "occurrences"), new com.nedap.archie.base.MultiplicityInterval(1, 1));
                value(primitive, "node_id", "");
                Element item = add(primitive, "item"); type(item, "C_STRING");
                for (String literal : included) value(item, "list", literal);
                return;
            }
            if (children(textAttribute, "children").size() != 1) throw new EngineException("ENGINE_OET_VALUE_TYPE_AMBIGUOUS");
            Element primitive = children(textAttribute, "children").getFirst();
            Element item = one(primitive, "item", true);
            if (!"C_STRING".equals(type(item)) || one(item, "pattern", false) != null || one(item, "list_open", false) != null)
                throw new EngineException("ENGINE_OET_CONSTRAINT_UNSUPPORTED");
            filter(item, "list", included, excluded);
            Element assumed = one(item, "assumed_value", false);
            if (assumed != null && !values(item, "list").contains(assumed.getTextContent())) throw new EngineException("ENGINE_ASSUMED_VALUE_EXCLUDED");
        } else throw new EngineException("ENGINE_OET_CONSTRAINT_TYPE_MISMATCH");
    }

    private static void filter(Element parent, String name, List<String> included, List<String> excluded) {
        List<String> old = values(parent, name);
        if (old.isEmpty()) throw new EngineException("ENGINE_OET_UNCONSTRAINED_VALUE_UNSUPPORTED");
        if (!old.containsAll(included) || !old.containsAll(excluded)) throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
        List<String> selected = old.stream().filter(v -> (included.isEmpty() || included.contains(v)) && !excluded.contains(v)).toList();
        if (selected.isEmpty()) throw new EngineException("ENGINE_OET_EMPTY_VALUE_DOMAIN");
        for (Element child : children(parent, name)) if (!selected.contains(child.getTextContent())) parent.removeChild(child);
    }

    private static void quantity(Element value, Element constraint) {
        closed(constraint, OET, Set.of("includedUnits", "excludedUnits", "unitMagnitude"), Set.of());
        if (!"C_DV_QUANTITY".equals(type(value))) throw new EngineException("ENGINE_OET_CONSTRAINT_TYPE_MISMATCH");
        var units = children(value, "list");
        if (units.isEmpty()) throw new EngineException("ENGINE_OET_UNCONSTRAINED_VALUE_UNSUPPORTED");
        var included = values(constraint, "includedUnits");
        var excluded = values(constraint, "excludedUnits");
        var allowed = units.stream().map(v -> text(v, "units")).toList();
        if (!allowed.containsAll(included) || !allowed.containsAll(excluded)) throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
        for (Element unit : units) if ((!included.isEmpty() && !included.contains(text(unit, "units"))) || excluded.contains(text(unit, "units"))) value.removeChild(unit);
        if (children(value, "list").isEmpty()) throw new EngineException("ENGINE_OET_EMPTY_VALUE_DOMAIN");
        Set<String> refined = new HashSet<>();
        for (Element bounds : children(constraint, "unitMagnitude")) {
            closed(bounds, OET, Set.of("unit", "minMagnitude", "maxMagnitude"), Set.of());
            String unit = scalar(one(bounds, "unit", true));
            if (!refined.add(unit)) throw new EngineException("ENGINE_OET_DUPLICATE_REFINEMENT");
            var matches = children(value, "list").stream().filter(v -> text(v, "units").equals(unit)).toList();
            if (matches.size() != 1) throw new EngineException("ENGINE_OET_UNIT_AMBIGUOUS");
            Element magnitude = one(matches.getFirst(), "magnitude", false);
            if (magnitude == null) {
                magnitude = add(matches.getFirst(), "magnitude"); matches.getFirst().insertBefore(magnitude, matches.getFirst().getFirstChild());
                LegacyOptWriter.interval(magnitude, com.nedap.archie.base.Interval.unbounded());
            }
            narrow(magnitude, "lower", one(bounds, "minMagnitude", false));
            narrow(magnitude, "upper", one(bounds, "maxMagnitude", false));
            if (one(magnitude, "lower", false) != null && one(magnitude, "upper", false) != null
                    && new BigDecimal(text(magnitude, "lower")).compareTo(new BigDecimal(text(magnitude, "upper"))) > 0) throw new EngineException("ENGINE_INTERVAL_INVALID");
        }
        if (one(value, "assumed_value", false) != null) throw new EngineException("ENGINE_QUANTITY_ASSUMED_REFINEMENT_UNSUPPORTED");
    }

    private static void narrow(Element range, String bound, Element proposed) {
        if (proposed == null) return;
        String text = scalar(proposed);
        if (!text.matches("-?(0|[1-9][0-9]{0,15})(\\.[0-9]{1,15})?")) throw new EngineException("ENGINE_QUANTITY_CONSTRAINT_INVALID");
        BigDecimal value = new BigDecimal(text);
        Element previous = one(range, bound, false);
        if (previous != null) {
            int comparison = value.compareTo(new BigDecimal(previous.getTextContent()));
            if ((bound.equals("lower") && comparison < 0) || (bound.equals("upper") && comparison > 0)
                    || (comparison == 0 && !"true".equals(text(range, bound + "_included")))) throw new EngineException("ENGINE_CONSTRAINT_WIDENING");
        } else {
            previous = add(range, bound);
            if (bound.equals("lower") && one(range, "upper", false) != null) range.insertBefore(previous, one(range, "upper", true));
        }
        previous.setTextContent(text); one(range, bound + "_unbounded", true).setTextContent("false"); one(range, bound + "_included", true).setTextContent("true");
    }
    private static List<String> values(Element parent, String name) {
        var values = children(parent, name).stream().map(LegacyOetConstraints::scalar).toList();
        if (new HashSet<>(values).size() != values.size()) throw new EngineException("ENGINE_OET_DUPLICATE_VALUE");
        return values;
    }
    private static String scalar(Element element) {
        if (OET.equals(element.getNamespaceURI())) closed(element, OET, Set.of(), Set.of());
        if (!children(element).isEmpty()) throw new EngineException("ENGINE_XML_ELEMENT_INVALID");
        return element.getTextContent();
    }
}
