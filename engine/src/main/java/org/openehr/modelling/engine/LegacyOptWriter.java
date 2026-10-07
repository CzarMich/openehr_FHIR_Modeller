package org.openehr.modelling.engine;

import com.nedap.archie.adl14.aom14.*;
import com.nedap.archie.adlparser.antlr.Adl14Parser.*;
import com.nedap.archie.aom.*;
import com.nedap.archie.aom.primitives.*;
import com.nedap.archie.base.*;
import com.nedap.archie.base.terminology.TerminologyCode;
import com.nedap.archie.rminfo.MetaModel;
import java.util.*;
import org.w3c.dom.*;
import static org.openehr.modelling.engine.SafeXml.*;

/** OPT 1.4 serialization using the original ADL 1.4 syntax for lossy AOM conversions. */
final class LegacyOptWriter {
    final Map<Element, ArchetypeSlot> slots = new IdentityHashMap<>();
    final Map<Element, LegacyArchetype> roots = new IdentityHashMap<>();
    final Map<String, LegacyArchetype> components = new TreeMap<>();
    final Document document = create();
    final Element template = document.createElementNS(OPT, "template");
    final MetaModel rm;
    final String language;
    private int nodes;
    private LegacyArchetype currentSource;
    private LegacyReferences references;
    private final Set<CObject> writing = Collections.newSetFromMap(new IdentityHashMap<>());
    final List<Map<String, String>> referenceActions = new ArrayList<>();

    LegacyOptWriter(String language, MetaModel rm) {
        this.language = language; this.rm = rm;
        template.setAttributeNS(javax.xml.XMLConstants.XMLNS_ATTRIBUTE_NS_URI, "xmlns", OPT);
        template.setAttributeNS(javax.xml.XMLConstants.XMLNS_ATTRIBUTE_NS_URI, "xmlns:xsi", XSI);
        document.appendChild(template);
    }

    Element root(LegacyArchetype source, String elementName) {
        currentSource = source;
        references = new LegacyReferences(source);
        if (source.syntax().specialization_section() != null) throw new EngineException("ENGINE_ADL14_SPECIALIZATION_UNSUPPORTED");
        if (source.syntax().rules_section() != null) throw new EngineException("ENGINE_ADL14_RULES_UNSUPPORTED");
        if (!"openehr".equalsIgnoreCase(source.model().getArchetypeId().getRmPublisher())
                || !source.model().getArchetypeId().getRmClass().equals(source.model().getDefinition().getRmTypeName()))
            throw new EngineException("ENGINE_RM_PROFILE_UNSUPPORTED");
        Element root = document.createElementNS(OPT, elementName);
        complex(root, source.model().getDefinition(), source.syntax().definition_section().c_complex_object());
        type(root, "C_ARCHETYPE_ROOT");
        value(add(root, "archetype_id"), "value", source.identifier());
        var terms = source.ontology().getTermDefinitions().get(language);
        if (terms == null || terms.getItems() == null) throw new EngineException("ENGINE_TEMPLATE_LANGUAGE_MISSING");
        new TreeMap<>(terms.getItems()).forEach((code, term) -> term(add(root, "term_definitions"), code, term));
        bindings(root, source.ontology().getTermBindings());
        roots.put(root, source);
        components.put(source.identifier(), source);
        return root;
    }

    private void complex(Element element, CObject object, C_complex_objectContext syntax) {
        if (!writing.add(object)) throw new EngineException("ENGINE_INTERNAL_REFERENCE_CYCLE");
        if (writing.size() > 64) throw new EngineException("ENGINE_NODE_DEPTH_LIMIT");
        try { complexBody(element, object, syntax); }
        finally { writing.remove(object); }
    }

    private void complexBody(Element element, CObject object, C_complex_objectContext syntax) {
        type(element, "C_COMPLEX_OBJECT");
        common(element, object.getRmTypeName(), object.getNodeId(), object.getOccurrences());
        if (!rm.typeNameExists(object.getRmTypeName())) throw new EngineException("ENGINE_RM_TYPE_INVALID");
        if (syntax.c_attribute_def().size() != object.getAttributes().size()) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
        Set<String> names = new HashSet<>();
        for (int i = 0; i < syntax.c_attribute_def().size(); i++) {
            C_attributeContext rule = syntax.c_attribute_def(i).c_attribute();
            if (rule == null || rule.attribute_id() == null) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
            CAttribute attribute = object.getAttributes().get(i);
            String name = attribute.getRmAttributeName();
            if (!names.add(name) || !rm.attributeExists(object.getRmTypeName(), name)) throw new EngineException("ENGINE_RM_ATTRIBUTE_INVALID");
            Element target = add(element, "attributes");
            boolean multiple = rm.isMultiple(object.getRmTypeName(), name);
            type(target, multiple ? "C_MULTIPLE_ATTRIBUTE" : "C_SINGLE_ATTRIBUTE");
            if (!multiple && attribute.getCardinality() != null) throw new EngineException("ENGINE_CARDINALITY_INVALID");
            value(target, "rm_attribute_name", name);
            var existence = attribute.getExistence() == null ? new MultiplicityInterval(1, 1) : attribute.getExistence();
            multiplicity(existence, 1);
            if (!rm.isNullable(object.getRmTypeName(), name) && existence.getLower() == 0) throw new EngineException("ENGINE_RM_EXISTENCE_INVALID");
            interval(add(target, "existence"), existence);
            if (rule.c_objects() != null && rule.c_objects().c_primitive_object() != null) {
                if (attribute.getChildren().size() != 1) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
                CObject child = attribute.getChildren().getFirst();
                checkChild(object, attribute, child);
                primitive(add(target, "children"), (CPrimitiveObject<?, ?>) child, rule.c_objects().c_primitive_object());
            } else if (rule.CONTAINED_REGEXP() != null) {
                CObject child = attribute.getChildren().getFirst();
                checkChild(object, attribute, child);
                primitive(add(target, "children"), (CPrimitiveObject<?, ?>) child, null);
            } else if (rule.c_objects() != null) {
                var children = rule.c_objects().c_non_primitive_object_ordered();
                if (children.size() != attribute.getChildren().size()) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
                Set<String> codes = new HashSet<>();
                for (int j = 0; j < children.size(); j++) {
                    CObject child = attribute.getChildren().get(j);
                    if (child.getNodeId() != null && !codes.add(child.getNodeId())) throw new EngineException("ENGINE_DUPLICATE_NODE_ID");
                    if (children.get(j).sibling_order() != null) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
                    checkChild(object, attribute, child);
                    nonPrimitive(add(target, "children"), child, children.get(j).c_non_primitive_object());
                }
            }
            if (multiple) {
                var cardinality = attribute.getCardinality();
                Element targetCardinality = add(target, "cardinality");
                value(targetCardinality, "is_ordered", cardinality != null && cardinality.isOrdered());
                value(targetCardinality, "is_unique", cardinality != null && cardinality.isUnique());
                var interval = cardinality == null ? MultiplicityInterval.createUpperUnbounded(0) : cardinality.getInterval();
                multiplicity(interval, null);
                interval(add(targetCardinality, "interval"), interval);
            }
        }
    }

    private void checkChild(CObject parent, CAttribute attribute, CObject child) {
        boolean valid = child instanceof CPrimitiveObject<?, ?> primitive
                ? rm.validatePrimitiveType(parent.getRmTypeName(), attribute.getRmAttributeName(), primitive)
                : rm.typeConformant(parent.getRmTypeName(), attribute.getRmAttributeName(), child.getRmTypeName());
        if (!valid) throw new EngineException("ENGINE_RM_CHILD_TYPE_INVALID");
    }

    private void nonPrimitive(Element target, CObject model, C_non_primitive_objectContext syntax) {
        if (syntax.c_complex_object() != null) { complex(target, model, syntax.c_complex_object()); return; }
        if (syntax.c_complex_object_proxy() != null && model instanceof CComplexObjectProxy proxy) {
            var resolved = references.resolve(proxy);
            if (!rm.rmTypesConformant(resolved.model().getRmTypeName(), proxy.getRmTypeName()))
                throw new EngineException("ENGINE_INTERNAL_REFERENCE_TYPE_INVALID");
            complex(target, resolved.model(), resolved.syntax());
            var original = syntax.c_complex_object_proxy();
            if (original.AT_CODE() != null) one(target, "node_id", true).setTextContent(original.AT_CODE().getText());
            // ADL 1.4 inherits occurrences unless the referring syntax explicitly overrides it.
            if (original.c_occurrences() != null) {
                multiplicity(proxy.getOccurrences(), null);
                Element range = one(target, "occurrences", true);
                while (range.hasChildNodes()) range.removeChild(range.getFirstChild());
                interval(range, proxy.getOccurrences());
            }
            referenceActions.add(Map.of("code", "ADL14_INTERNAL_REFERENCE_EXPANDED", "location", proxy.getPath(),
                    "value", proxy.getTargetPath(), "archetype", currentSource.identifier()));
            return;
        }
        if (syntax.archetype_slot() != null && model instanceof ArchetypeSlot slot) {
            type(target, "ARCHETYPE_SLOT");
            common(target, model.getRmTypeName(), model.getNodeId(), model.getOccurrences());
            slots.put(target, slot);
            return;
        }
        if (syntax.domainSpecificExtension() != null) {
            String type = syntax.domainSpecificExtension().type_id().getText();
            String odin = syntax.domainSpecificExtension().odin_text() == null ? "" : syntax.domainSpecificExtension().odin_text().getText();
            if ("C_DV_QUANTITY".equals(type)) {
                quantity(target, LegacyOdin.parse(odin, CDVQuantity.class)); return;
            }
            // The legacy ordinal domain parser does not retain assumed values; fail closed.
            throw new EngineException("ENGINE_ADL14_DOMAIN_CONSTRAINT_UNSUPPORTED");
        }
        if (syntax.c_ordinal() != null) { ordinal(target, syntax.c_ordinal()); return; }
        throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
    }

    private void primitive(Element target, CPrimitiveObject<?, ?> model, C_primitive_objectContext syntax) {
        if (model instanceof CTerminologyCode code) {
            terminology(target, syntax.c_terminology_code()); return;
        }
        type(target, "C_PRIMITIVE_OBJECT");
        common(target, model.getRmTypeName(), null, new MultiplicityInterval(1, 1));
        Element item = add(target, "item");
        if (model instanceof CString strings) {
            type(item, "C_STRING");
            if (syntax == null) {
                if (strings.getConstraint().size() != 1) throw new EngineException("ENGINE_STRING_CONSTRAINT_INVALID");
                String regex = strings.getConstraint().getFirst();
                value(item, "pattern", regex.substring(1, regex.length() - 1));
            } else {
                for (String value : strings.getConstraint()) value(item, "list", value);
                var list = syntax.c_string().string_list_value();
                if (list != null && list.SYM_LIST_CONTINUE() != null) value(item, "list_open", true);
            }
        } else if (model instanceof CBoolean bool) {
            type(item, "C_BOOLEAN");
            value(item, "true_valid", bool.getConstraint().isEmpty() || bool.getConstraint().contains(true));
            value(item, "false_valid", bool.getConstraint().isEmpty() || bool.getConstraint().contains(false));
        } else if (model instanceof CInteger || model instanceof CReal) {
            type(item, model instanceof CInteger ? "C_INTEGER" : "C_REAL");
            boolean allSingle = model.getConstraint().stream().allMatch(v -> v instanceof Interval<?> range && singleton(range));
            if (allSingle) for (Object value : model.getConstraint()) value(item, "list", ((Interval<?>) value).getLower());
            else if (model.getConstraint().size() == 1) interval(add(item, "range"), (Interval<?>) model.getConstraint().getFirst());
            else throw new EngineException("ENGINE_OPT14_INTERVAL_UNION_UNSUPPORTED");
            // Numeric continuation lists have no representation in the OPT 1.4 schema.
            if (syntax != null && hasToken(syntax, com.nedap.archie.adlparser.antlr.Adl14Lexer.SYM_LIST_CONTINUE))
                throw new EngineException("ENGINE_OPT14_OPEN_NUMERIC_LIST_UNSUPPORTED");
        } else if (model instanceof CTemporal<?> temporal) {
            String type = switch (model) { case CDate v -> "C_DATE"; case CTime v -> "C_TIME";
                case CDateTime v -> "C_DATE_TIME"; case CDuration v -> "C_DURATION"; default -> throw new EngineException("ENGINE_PRIMITIVE_UNSUPPORTED"); };
            type(item, type);
            if (temporal.getPatternConstraint() != null) value(item, "pattern", temporal.getPatternConstraint());
            if (temporal.getConstraint().size() > 1) throw new EngineException("ENGINE_OPT14_TEMPORAL_UNION_UNSUPPORTED");
            if (!temporal.getConstraint().isEmpty()) interval(add(item, "range"), (Interval<?>) temporal.getConstraint().getFirst());
        } else throw new EngineException("ENGINE_PRIMITIVE_UNSUPPORTED");
        // The generic temporal parser derives assumptions for singleton ranges and can
        // overwrite explicit assumptions. Serialize the source assumption, never that derivation.
        Object assumed = model instanceof CTemporal<?> ? temporalAssumed(syntax) : model.getAssumedValue();
        if (assumed != null) value(item, "assumed_value", assumed);
    }

    private static String temporalAssumed(C_primitive_objectContext syntax) {
        org.antlr.v4.runtime.ParserRuleContext value = null;
        if (syntax.c_date() != null) value = syntax.c_date().assumed_date_value();
        if (syntax.c_time() != null) value = syntax.c_time().assumed_time_value();
        if (syntax.c_date_time() != null) value = syntax.c_date_time().assumed_date_time_value();
        if (syntax.c_duration() != null) value = syntax.c_duration().assumed_duration_value();
        return value == null ? null : value.getText().substring(1);
    }

    private void terminology(Element target, C_terminology_codeContext syntax) {
        if (syntax == null || syntax.qualifiedTermCode() == null) throw new EngineException("ENGINE_TERMINOLOGY_REFERENCE_UNRESOLVED");
        type(target, "C_CODE_PHRASE"); common(target, "CODE_PHRASE", null, new MultiplicityInterval(1, 1));
        var qualified = syntax.qualifiedTermCode();
        String terminology;
        List<String> codes;
        if (qualified.TERM_CODE_REF() != null) {
            var code = TerminologyCode.createFromString(qualified.TERM_CODE_REF().getText());
            terminology = terminologyId(code);
            codes = List.of(code.getCodeString());
        } else {
            terminology = qualified.identifier(0).getText();
            codes = qualified.identifier().stream().skip(1).map(v -> v.getText()).toList();
        }
        if (qualified.assumed_value() != null) {
            String assumed = qualified.assumed_value().getText();
            if (!codes.isEmpty() && !codes.contains(assumed)) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
            phrase(add(target, "assumed_value"), terminology, assumed);
        }
        value(add(target, "terminology_id"), "value", terminology);
        for (String code : codes) value(target, "code_list", code);
    }

    private void quantity(Element target, CDVQuantity quantity) {
        type(target, "C_DV_QUANTITY"); common(target, "DV_QUANTITY", null, new MultiplicityInterval(1, 1));
        if (quantity.getAssumedValue() != null) {
            var source = quantity.getAssumedValue();
            Element assumed = add(target, "assumed_value");
            if (source.getMagnitude() == null || source.getUnits() == null) throw new EngineException("ENGINE_QUANTITY_CONSTRAINT_INVALID");
            value(assumed, "magnitude", source.getMagnitude()); value(assumed, "units", source.getUnits());
            if (source.getPrecision() != null) value(assumed, "precision", source.getPrecision());
        }
        if (quantity.getProperty() != null) phrase(add(target, "property"), quantity.getProperty());
        if (quantity.getList() != null) for (var item : new TreeMap<>(quantity.getList()).values()) {
            Element entry = add(target, "list");
            if (item.getMagnitude() != null) interval(add(entry, "magnitude"), item.getMagnitude());
            if (item.getPrecision() != null) interval(add(entry, "precision"), item.getPrecision());
            if (item.getUnits() == null) throw new EngineException("ENGINE_QUANTITY_CONSTRAINT_INVALID");
            value(entry, "units", item.getUnits());
        }
    }

    private void ordinal(Element target, C_ordinalContext syntax) {
        type(target, "C_DV_ORDINAL"); common(target, "DV_ORDINAL", null, new MultiplicityInterval(1, 1));
        String assumed = syntax.assumed_ordinal_value() == null ? null : syntax.assumed_ordinal_value().getText();
        Set<Long> values = new HashSet<>();
        List<Element> entries = new ArrayList<>();
        boolean matched = assumed == null;
        for (var term : syntax.ordinal_term()) {
            if (term.integer_value() == null || term.c_terminology_code().qualifiedTermCode() == null
                    || term.c_terminology_code().qualifiedTermCode().TERM_CODE_REF() == null) throw new EngineException("ENGINE_ORDINAL_CONSTRAINT_UNSUPPORTED");
            long value = Long.parseLong(term.integer_value().getText());
            if (!values.add(value)) throw new EngineException("ENGINE_ORDINAL_CONSTRAINT_INVALID");
            var code = TerminologyCode.createFromString(term.c_terminology_code().getText());
            Element entry = document.createElementNS(OPT, "list");
            value(entry, "value", value);
            Element symbol = add(entry, "symbol");
            if (!"local".equals(code.getTerminologyId())) throw new EngineException("ENGINE_ORDINAL_DISPLAY_UNAVAILABLE");
            var terms = currentSource.ontology().getTermDefinitions().get(language);
            var display = terms == null ? null : terms.getItems().get(code.getCodeString());
            if (display == null || display.getText() == null) throw new EngineException("ENGINE_ORDINAL_DISPLAY_UNAVAILABLE");
            value(symbol, "value", display.getText());
            phrase(add(symbol, "defining_code"), code);
            entries.add(entry);
            if (assumed != null && value == Long.parseLong(assumed)) {
                Element assumedEntry = (Element) entry.cloneNode(true);
                document.renameNode(assumedEntry, OPT, "assumed_value"); target.appendChild(assumedEntry); matched = true;
            }
        }
        if (!matched) throw new EngineException("ENGINE_ASSUMED_VALUE_INVALID");
        entries.forEach(target::appendChild);
    }

    void ontology(Element parent, String element, LegacyArchetype source) {
        Element ontology = add(parent, element); ontology.setAttribute("archetype_id", source.identifier());
        definitions(ontology, "term_definitions", source.ontology().getTermDefinitions());
        definitions(ontology, "constraint_definitions", source.ontology().getConstraintDefinitions());
        bindings(ontology, source.ontology().getTermBindings());
        var constraints = source.ontology().getConstraintBindings();
        if (constraints != null) new TreeMap<>(constraints).forEach((system, binding) -> {
            Element group = add(ontology, "constraint_bindings"); group.setAttribute("terminology", system);
            new TreeMap<>(binding.getItems()).forEach((code, uri) -> {
                Element item = add(group, "items"); item.setAttribute("code", code); value(item, "value", uri);
            });
        });
    }
    private static void definitions(Element parent, String element, Map<String, TermCodeList> terms) {
        if (terms == null) return;
        new TreeMap<>(terms).forEach((language, codes) -> {
            Element group = add(parent, element); group.setAttribute("language", language);
            new TreeMap<>(codes.getItems()).forEach((code, value) -> term(add(group, "items"), code, value));
        });
    }
    private static void term(Element element, String code, com.nedap.archie.aom.terminology.ArchetypeTerm term) {
        element.setAttribute("code", code);
        new TreeMap<>(term).forEach((key, text) -> { Element value = value(element, "items", text); value.setAttribute("id", key); });
    }
    private static void bindings(Element parent, Map<String, TermBindingsList> bindings) {
        if (bindings == null) return;
        new TreeMap<>(bindings).forEach((system, values) -> {
            Element group = add(parent, "term_bindings"); group.setAttribute("terminology", system);
            new TreeMap<>(values.getItems()).forEach((code, binding) -> {
                Element entry = add(group, "items"); entry.setAttribute("code", code); phrase(add(entry, "value"), binding);
            });
        });
    }
    private void common(Element element, String rmType, String nodeId, MultiplicityInterval occurrences) {
        if (++nodes > 20000) throw new EngineException("ENGINE_NODE_LIMIT");
        value(element, "rm_type_name", rmType);
        var interval = occurrences == null ? new MultiplicityInterval(1, 1) : occurrences;
        multiplicity(interval, null); interval(add(element, "occurrences"), interval);
        value(element, "node_id", nodeId == null ? "" : nodeId);
    }
    static void phrase(Element target, TerminologyCode code) { phrase(target, terminologyId(code), code.getCodeString()); }
    static void phrase(Element target, String system, String code) {
        if (system == null || system.isBlank() || code == null || code.isBlank()) throw new EngineException("ENGINE_TERMINOLOGY_CODE_INVALID");
        value(add(target, "terminology_id"), "value", system); value(target, "code_string", code);
    }
    static String terminologyId(TerminologyCode code) {
        if (code.getUri() != null) throw new EngineException("ENGINE_TERMINOLOGY_REPRESENTATION_UNSUPPORTED");
        if (code.getTerminologyId() == null || code.getTerminologyId().isBlank()) throw new EngineException("ENGINE_TERMINOLOGY_CODE_INVALID");
        return code.getTerminologyId() + (code.getTerminologyVersion() == null ? "" : "(" + code.getTerminologyVersion() + ")");
    }
    static void interval(Element target, Interval<?> range) {
        validateInterval(range);
        value(target, "lower_included", range.isLowerIncluded()); value(target, "upper_included", range.isUpperIncluded());
        value(target, "lower_unbounded", range.isLowerUnbounded()); value(target, "upper_unbounded", range.isUpperUnbounded());
        if (!range.isLowerUnbounded()) value(target, "lower", range.getLower());
        if (!range.isUpperUnbounded()) value(target, "upper", range.getUpper());
    }
    @SuppressWarnings("unchecked")
    static void validateInterval(Interval<?> range) {
        if (!range.isLowerUnbounded() && !range.isUpperUnbounded()) {
            try {
                int compared = range.getComparableLower().compareTo(range.getComparableUpper());
                if (compared > 0 || (compared == 0 && (!range.isLowerIncluded() || !range.isUpperIncluded()))) throw new EngineException("ENGINE_INTERVAL_INVALID");
            } catch (EngineException e) { throw e; }
            catch (RuntimeException e) { throw new EngineException("ENGINE_INTERVAL_COMPARISON_UNSUPPORTED"); }
        }
    }
    static void multiplicity(Interval<Integer> value, Integer max) {
        if (value.isLowerUnbounded() || value.getLower() == null || value.getLower() < 0
                || (!value.isUpperUnbounded() && (value.getUpper() == null || value.getUpper() < value.getLower()))
                || (max != null && (value.isUpperUnbounded() || value.getUpper() > max))) throw new EngineException("ENGINE_MULTIPLICITY_INVALID");
    }
    private static boolean singleton(Interval<?> range) {
        return !range.isLowerUnbounded() && !range.isUpperUnbounded() && range.isLowerIncluded() && range.isUpperIncluded()
                && Objects.equals(range.getLower(), range.getUpper());
    }
    private static boolean hasToken(org.antlr.v4.runtime.tree.ParseTree tree, int token) {
        if (tree instanceof org.antlr.v4.runtime.tree.TerminalNode node && node.getSymbol().getType() == token) return true;
        for (int i = 0; i < tree.getChildCount(); i++) if (hasToken(tree.getChild(i), token)) return true;
        return false;
    }
}
