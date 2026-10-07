package org.openehr.modelling.engine;

import com.nedap.archie.aom.Archetype;
import com.nedap.archie.aom.ArchetypeHRID;
import com.nedap.archie.rminfo.MetaModel;
import java.util.*;
import org.openehr.referencemodels.BuiltinReferenceModels;
import org.w3c.dom.Element;
import static org.openehr.modelling.engine.SafeXml.*;
import static org.openehr.modelling.engine.LegacyTemplateCompiler.*;

/** Explicit OPT 1.4 XML/RM structure profile; not full AOM semantic or clinical conformance. */
final class LegacyOptProfile {
    record Result(String identifier, List<Map<String, Object>> paths, List<Map<String, String>> bindings) {}
    private final List<Map<String, Object>> paths = new ArrayList<>();
    private final List<Map<String, String>> bindings = new ArrayList<>();
    private final MetaModel rm;

    private LegacyOptProfile() {
        var view = new Archetype(); view.setArchetypeId(new ArchetypeHRID("openEHR-EHR-COMPOSITION.validation.v1.0.0"));
        view.setRmRelease(LegacyTemplateCompiler.RM_RELEASE);
        rm = BuiltinReferenceModels.getMetaModelProvider().getMetaModel(view);
    }
    static Result inspect(String content) {
        LegacyOptSchema.validate(content);
        Element template = parse(content).getDocumentElement();
        var profile = new LegacyOptProfile();
        profile.node(one(template, "definition", true), "/", null, "");
        for (Element ontology : children(template)) if (Set.of("ontology", "component_ontologies").contains(ontology.getLocalName())) {
            String scope = ontology.getAttribute("archetype_id");
            for (Element group : children(ontology, "term_bindings")) for (Element entry : children(group, "items")) {
                if (profile.bindings.size() >= 4096) throw new EngineException("ENGINE_TERMINOLOGY_LIMIT");
                Element phrase = one(entry, "value", true);
                profile.bindings.add(Map.of("archetype", scope, "terminology", group.getAttribute("terminology"),
                        "local_code_or_path", entry.getAttribute("code"), "system", text(one(phrase, "terminology_id", true), "value"),
                        "code", text(phrase, "code_string"), "validation", "NOT_EXECUTED"));
            }
        }
        return new Result(text(one(template, "template_id", true), "value"), List.copyOf(profile.paths), List.copyOf(profile.bindings));
    }

    private void node(Element node, String path, Element scope, String parentLabel) {
        if (paths.size() >= 20000) throw new EngineException("ENGINE_NODE_LIMIT");
        String kind = type(node);
        String rmType = text(node, "rm_type_name");
        // Primitive AOM names (e.g. date_time) are mapped to RM types by the native AOM profile.
        if (!kind.equals("C_PRIMITIVE_OBJECT") && !rm.typeNameExists(rmType)) throw new EngineException("ENGINE_RM_TYPE_INVALID");
        if (!Set.of("C_ARCHETYPE_ROOT", "C_COMPLEX_OBJECT", "C_PRIMITIVE_OBJECT", "C_CODE_PHRASE", "C_DV_QUANTITY", "C_DV_ORDINAL").contains(kind))
            throw new EngineException("ENGINE_OPT14_CONSTRAINT_UNSUPPORTED");
        if ((kind.equals("C_CODE_PHRASE") && !rmType.equals("CODE_PHRASE"))
                || (kind.equals("C_DV_QUANTITY") && !rmType.equals("DV_QUANTITY"))
                || (kind.equals("C_DV_ORDINAL") && !rmType.equals("DV_ORDINAL"))) throw new EngineException("ENGINE_RM_CHILD_TYPE_INVALID");
        LegacyValueValidation.check(node, kind);
        if (kind.equals("C_ARCHETYPE_ROOT")) scope = node;
        if (scope == null) throw new EngineException("ENGINE_OPT14_SCOPE_MISSING");
        var occurrences = intervalOf(node, "occurrences"); LegacyOptWriter.multiplicity(occurrences, null);
        String nodeId = text(node, "node_id");
        if (!nodeId.isEmpty()) {
            boolean found = children(scope, "term_definitions").stream().anyMatch(term -> nodeId.equals(term.getAttribute("code")));
            if (!found) throw new EngineException("ENGINE_LOCAL_TERM_MISSING");
        }
        Map<String, Object> inspected = new LinkedHashMap<>();
        inspected.put("path", path); inspected.put("node_id", nodeId); inspected.put("rm_type", rmType);
        inspected.put("constraint_kind", kind); inspected.put("occurrences", occurrences.toString());
        inspected.put("archetype", text(one(scope, "archetype_id", true), "value"));
        String label = nodeId.isEmpty() ? parentLabel : "";
        for (Element term : children(scope, "term_definitions")) if (nodeId.equals(term.getAttribute("code"))) {
            for (Element item : children(term, "items")) {
                if ("text".equals(item.getAttribute("id"))) label = item.getTextContent();
                if ("description".equals(item.getAttribute("id"))) inspected.put("description", item.getTextContent());
            }
        }
        if (!label.isEmpty()) inspected.put("label", label);
        List<Map<String, String>> attributes = new ArrayList<>(); inspected.put("attributes", attributes);
        paths.add(inspected);
        Set<String> names = new HashSet<>();
        for (Element attribute : children(node, "attributes")) {
            String name = text(attribute, "rm_attribute_name");
            if (!names.add(name) || !rm.attributeExists(rmType, name)) throw new EngineException("ENGINE_RM_ATTRIBUTE_INVALID");
            boolean multiple = rm.isMultiple(rmType, name);
            if (multiple != "C_MULTIPLE_ATTRIBUTE".equals(type(attribute))) throw new EngineException("ENGINE_CARDINALITY_INVALID");
            var existence = intervalOf(attribute, "existence"); LegacyOptWriter.multiplicity(existence, 1);
            if (!rm.isNullable(rmType, name) && existence.getLower() == 0) throw new EngineException("ENGINE_RM_EXISTENCE_INVALID");
            String attributePath = path.equals("/") ? "/" + name : path + "/" + name;
            var attr = new LinkedHashMap<String, String>(); attr.put("path", attributePath); attr.put("name", name); attr.put("existence", existence.toString());
            if (multiple) {
                var cardinality = intervalOf(one(attribute, "cardinality", true), "interval"); LegacyOptWriter.multiplicity(cardinality, null);
                attr.put("cardinality", cardinality.toString());
            }
            attributes.add(attr);
            Set<String> identities = new HashSet<>();
            for (Element child : children(attribute, "children")) {
                String childType = text(child, "rm_type_name");
                boolean conformant = type(child).equals("C_PRIMITIVE_OBJECT")
                        ? rm.validatePrimitiveType(rmType, name, LegacyValueValidation.primitive(child))
                        : rm.typeConformant(rmType, name, childType);
                if (!conformant) throw new EngineException("ENGINE_RM_CHILD_TYPE_INVALID");
                String childId = text(child, "node_id");
                if (one(child, "archetype_id", false) != null) childId = text(one(child, "archetype_id", true), "value");
                if (!childId.isEmpty() && !identities.add(childId)) throw new EngineException("ENGINE_OPT14_PATH_AMBIGUOUS");
                String childPath = attributePath + (childId.isEmpty() ? "" : "[" + childId + "]");
                if (!multiple && upper(one(child, "occurrences", true)) > 1) throw new EngineException("ENGINE_MULTIPLICITY_INVALID");
                node(child, childPath, scope, label);
            }
        }
        // Validate local code references independently of labels; do not contact terminology servers.
        if (kind.equals("C_CODE_PHRASE")) {
            Element system = one(node, "terminology_id", false);
            if (system != null && "local".equals(text(system, "value"))) {
                Set<String> codes = new HashSet<>();
                for (Element term : children(scope, "term_definitions")) codes.add(term.getAttribute("code"));
                for (Element code : children(node, "code_list")) if (!codes.contains(code.getTextContent())) throw new EngineException("ENGINE_LOCAL_TERM_MISSING");
            }
        }
    }
}
