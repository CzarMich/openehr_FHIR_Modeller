package org.openehr.modelling.engine;

import java.math.BigDecimal;
import java.util.*;
import org.w3c.dom.Element;
import static org.openehr.modelling.engine.SafeXml.*;

/** Deterministic checks for the value domains emitted by this compatibility compiler. */
final class LegacyValueValidation {
    static com.nedap.archie.aom.CPrimitiveObject<?, ?> primitive(Element node) {
        return switch (text(node, "rm_type_name").toUpperCase(Locale.ROOT)) {
            case "STRING" -> {
                var value = new com.nedap.archie.aom.primitives.CString();
                Element item = one(node, "item", false);
                if (item != null) for (Element literal : children(item, "list")) value.addConstraint(literal.getTextContent());
                yield value;
            }
            case "INTEGER" -> new com.nedap.archie.aom.primitives.CInteger();
            case "REAL" -> new com.nedap.archie.aom.primitives.CReal();
            case "BOOLEAN" -> new com.nedap.archie.aom.primitives.CBoolean();
            case "DATE" -> new com.nedap.archie.aom.primitives.CDate();
            case "TIME" -> new com.nedap.archie.aom.primitives.CTime();
            case "DATE_TIME" -> new com.nedap.archie.aom.primitives.CDateTime();
            case "DURATION" -> new com.nedap.archie.aom.primitives.CDuration();
            default -> throw new EngineException("ENGINE_PRIMITIVE_UNSUPPORTED");
        };
    }
    static void check(Element node, String kind) {
        if (kind.equals("C_DV_QUANTITY")) {
            var units = children(node, "list");
            for (Element unit : units) {
                range(one(unit, "magnitude", false)); range(one(unit, "precision", false));
            }
            Element assumed = one(node, "assumed_value", false);
            if (assumed != null && !units.isEmpty()) {
                BigDecimal value = decimal(text(assumed, "magnitude"));
                Element precision = one(assumed, "precision", false);
                boolean found = units.stream().anyMatch(unit -> text(unit, "units").equals(text(assumed, "units"))
                        && contains(one(unit, "magnitude", false), value)
                        && (one(unit, "precision", false) == null || (precision != null && contains(one(unit, "precision", false), decimal(precision.getTextContent())))));
                if (!found) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
            }
        } else if (kind.equals("C_CODE_PHRASE")) {
            Element assumed = one(node, "assumed_value", false);
            List<String> codes = children(node, "code_list").stream().map(Element::getTextContent).toList();
            if (new HashSet<>(codes).size() != codes.size()) throw new EngineException("ENGINE_DUPLICATE_VALUE");
            if (assumed != null && ((!codes.isEmpty() && !codes.contains(text(assumed, "code_string")))
                    || one(node, "terminology_id", false) == null || !text(one(node, "terminology_id", true), "value")
                    .equals(text(one(assumed, "terminology_id", true), "value")))) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
        } else if (kind.equals("C_PRIMITIVE_OBJECT")) {
            Element item = one(node, "item", false);
            if (item == null) return;
            String type = type(item);
            String expected = switch (type) { case "C_STRING" -> "STRING"; case "C_INTEGER" -> "INTEGER"; case "C_REAL" -> "REAL";
                case "C_BOOLEAN" -> "BOOLEAN"; case "C_DATE" -> "DATE"; case "C_TIME" -> "TIME"; case "C_DATE_TIME" -> "DATE_TIME";
                case "C_DURATION" -> "DURATION"; default -> throw new EngineException("ENGINE_PRIMITIVE_UNSUPPORTED"); };
            if (!expected.equalsIgnoreCase(text(node, "rm_type_name"))) throw new EngineException("ENGINE_RM_CHILD_TYPE_INVALID");
            Element assumed = one(item, "assumed_value", false);
            var list = children(item, "list").stream().map(Element::getTextContent).toList();
            if (new HashSet<>(list).size() != list.size()) throw new EngineException("ENGINE_DUPLICATE_VALUE");
            if (type.equals("C_INTEGER") || type.equals("C_REAL")) {
                Element range = one(item, "range", false); range(range);
                if (!list.isEmpty() && range != null) throw new EngineException("ENGINE_NUMERIC_CONSTRAINT_INVALID");
                if (assumed != null) {
                    BigDecimal value = decimal(assumed.getTextContent());
                    if ((!list.isEmpty() && list.stream().noneMatch(v -> decimal(v).compareTo(value) == 0)) || !contains(range, value))
                        throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
                }
            } else if (type.equals("C_STRING") && assumed != null) {
                if (one(item, "pattern", false) != null) throw new EngineException("ENGINE_PATTERN_ASSUMPTION_UNSUPPORTED");
                boolean open = one(item, "list_open", false) != null && Set.of("true", "1").contains(text(item, "list_open"));
                if (!list.isEmpty() && !open && !list.contains(assumed.getTextContent())) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
            } else if (type.equals("C_BOOLEAN")) {
                boolean yes = Set.of("true", "1").contains(text(item, "true_valid"));
                boolean no = Set.of("true", "1").contains(text(item, "false_valid"));
                if (!yes && !no) throw new EngineException("ENGINE_OET_EMPTY_VALUE_DOMAIN");
                if (assumed != null && !(Set.of("true", "1").contains(assumed.getTextContent()) ? yes : no)) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
            } else if (Set.of("C_DATE", "C_TIME", "C_DATE_TIME", "C_DURATION").contains(type)) {
                temporal(item, type, assumed);
            }
        }
    }
    private static void temporal(Element item, String type, Element assumed) {
        Element pattern = one(item, "pattern", false), range = one(item, "range", false);
        if (pattern != null && assumed != null) throw new EngineException("ENGINE_PATTERN_ASSUMPTION_UNSUPPORTED");
        if (range == null) return;
        try {
            Element low = one(range, "lower", false), high = one(range, "upper", false);
            if ((low == null) != flag(range, "lower_unbounded") || (high == null) != flag(range, "upper_unbounded")) throw new EngineException("ENGINE_INTERVAL_INVALID");
            var interval = new com.nedap.archie.base.Interval<Object>(low == null ? null : temporalValue(type, low.getTextContent()),
                    high == null ? null : temporalValue(type, high.getTextContent()), flag(range, "lower_included"), flag(range, "upper_included"));
            LegacyOptWriter.validateInterval(interval);
            if (assumed != null && !interval.has(temporalValue(type, assumed.getTextContent()))) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
        } catch (EngineException e) { throw e; }
        catch (RuntimeException e) { throw new EngineException("ENGINE_TEMPORAL_COMPARISON_UNSUPPORTED"); }
    }
    private static Object temporalValue(String type, String text) {
        return switch (type) {
            case "C_DATE" -> com.nedap.archie.datetime.DateTimeParsers.parseDateValue(text);
            case "C_TIME" -> com.nedap.archie.datetime.DateTimeParsers.parseTimeValue(text);
            case "C_DATE_TIME" -> com.nedap.archie.datetime.DateTimeParsers.parseDateTimeValue(text);
            case "C_DURATION" -> {
                if (text.split("T", 2)[0].matches(".*[YM].*")) throw new EngineException("ENGINE_TEMPORAL_COMPARISON_UNSUPPORTED");
                yield com.nedap.archie.datetime.DateTimeParsers.parseDurationValue(text);
            }
            default -> throw new EngineException("ENGINE_PRIMITIVE_UNSUPPORTED");
        };
    }
    private static BigDecimal decimal(String text) {
        try { return new BigDecimal(text); }
        catch (NumberFormatException error) { throw new EngineException("ENGINE_NUMERIC_CONSTRAINT_INVALID"); }
    }
    private static void range(Element range) {
        if (range == null) return;
        Element low = one(range, "lower", false), high = one(range, "upper", false);
        if ((low == null) != flag(range, "lower_unbounded") || (high == null) != flag(range, "upper_unbounded")) throw new EngineException("ENGINE_INTERVAL_INVALID");
        if (low != null && high != null) {
            int order = decimal(low.getTextContent()).compareTo(decimal(high.getTextContent()));
            if (order > 0 || (order == 0 && (!flag(range, "lower_included") || !flag(range, "upper_included")))) throw new EngineException("ENGINE_INTERVAL_INVALID");
        }
    }
    private static boolean contains(Element range, BigDecimal value) {
        if (range == null) return true;
        for (String bound : List.of("lower", "upper")) {
            Element limit = one(range, bound, false);
            if (limit == null) continue;
            int comparison = value.compareTo(decimal(limit.getTextContent()));
            if ((bound.equals("lower") && comparison < 0) || (bound.equals("upper") && comparison > 0) || (comparison == 0 && !flag(range, bound + "_included"))) return false;
        }
        return true;
    }
    private static boolean flag(Element value, String name) {
        Element flag = one(value, name, false);
        return flag != null && Set.of("true", "1").contains(flag.getTextContent());
    }
}
