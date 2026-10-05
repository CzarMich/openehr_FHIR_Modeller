package org.openehr.modelling.engine;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LegacyTemplateCompilerTest {
    @Test void compiledTemplateCanGenerateWebTemplateForForms() throws Exception {
        var result = new LegacyTemplateCompiler().compile(NativeEngineTest.fixture("legacy/nested.oet"), dependencies());
        var document = (org.openehr.schemas.v1.TemplateDocument) org.openehr.schemas.v1.TemplateDocument.type.getTypeSystem().parse(
                SafeXml.parse(result.content()), org.openehr.schemas.v1.TemplateDocument.type, new org.apache.xmlbeans.XmlOptions());
        var opt = document.getTemplate();
        var form = org.ehrbase.openehr.sdk.webtemplate.parser.OPTParser.parse(opt);
        assertEquals(opt.getTemplateId().getValue(), form.getTemplateId());
        assertTrue(form.getLanguages().contains(form.getDefaultLanguage()));
        assertFalse(form.getTree().getChildren().isEmpty());
    }
    static List<Request.Dependency> dependencies() throws Exception {
        List<Request.Dependency> dependencies = new ArrayList<>();
        for (String fixture : List.of("composition", "section", "evaluation", "cluster")) {
            String content = NativeEngineTest.fixture("legacy/" + fixture + ".adl");
            dependencies.add(new Request.Dependency(LegacyArchetype.parse(content).identifier(), content, NativeEngine.sha256(content)));
        }
        return dependencies;
    }
    static List<Request.Dependency> replace(List<Request.Dependency> dependencies, int index, String before, String after) {
        var result = new ArrayList<>(dependencies);
        var old = result.get(index);
        String content = old.content().replace(before, after);
        assertNotEquals(old.content(), content);
        result.set(index, new Request.Dependency(old.identifier(), content, NativeEngine.sha256(content)));
        return result;
    }
    static void rejected(String code, String oet, List<Request.Dependency> dependencies) {
        var error = assertThrows(EngineException.class, () -> new LegacyTemplateCompiler().compile(oet, dependencies));
        assertEquals(code, error.getMessage());
    }
    @Test void compilesNestedOetWithOriginalTermsBindingsAndAnnotations() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet");
        var deps = dependencies();
        var result = new LegacyTemplateCompiler().compile(oet, deps);
        LegacyOptWriterTest.schema(result.content());
        assertTrue(result.content().contains("Synthetic section"));
        assertTrue(result.content().contains("Synthetic annotation; not clinical advice."));
        assertTrue(result.content().contains("Textelement"));
        assertFalse(result.content().contains("fixture.org"));
        assertFalse(result.content().contains("ARCHETYPE_SLOT"));
        assertEquals(result.content(), new LegacyTemplateCompiler().compile(oet, deps.reversed()).content());
        assertEquals(result.content(), new LegacyTemplateCompiler().compile("\ufeff" + oet, deps).content());
        assertEquals(NativeEngineTest.fixture("legacy/cluster.adl"), deps.getLast().content());
    }
    @Test void rejectsSourceAndDependencyAmbiguityAndXmlAttacks() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet");
        var deps = dependencies();
        rejected("ENGINE_DEPENDENCY_MISSING", oet, deps.subList(0, 3));
        var duplicate = new ArrayList<>(deps); duplicate.add(deps.getFirst());
        rejected("ENGINE_DEPENDENCY_ID_DUPLICATE", oet, duplicate);
        rejected("ENGINE_XML_PARSE_ERROR", oet.replace("<template ", "<!DOCTYPE template [<!ENTITY ext SYSTEM 'file:///etc/passwd'>]><template "), deps);
        rejected("ENGINE_OET_CONSTRUCT_UNSUPPORTED", oet.replace("<name>", "<script>").replace("</name>", "</script>"), deps);
        rejected("ENGINE_OET_PATH_UNSUPPORTED", oet.replace("/content[at0001]", "//content"), deps);
        rejected("ENGINE_XML_NAMESPACE", oet.replace("openEHR/v1/Template", "urn:wrong"), deps);
        rejected("ENGINE_OET_MIXED_CONTENT", oet.replace("<id>", "<![CDATA[unsupported text]]><id>"), deps);
        rejected("ENGINE_OET_PLACEMENT_KIND_INVALID", oet.replace("<Content ", "<Item ").replace("</Content>", "</Item>"), deps);
        rejected("ENGINE_OET_CONSTRUCT_UNSUPPORTED", oet.replace("<id>", "<id xsi:type=\"UnknownMeaning\">"), deps);
    }
    @Test void rejectsWideningSlotsIncompatibleTypesAndUnknownNativeConstructs() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet");
        var deps = dependencies();
        rejected("ENGINE_SLOT_NO_MATCH", oet, replace(deps, 1, "openEHR-EHR-EVALUATION", "openEHR-EHR-OBSERVATION"));
        rejected("ENGINE_SLOT_OCCURRENCES_INVALID", oet.replace("max=\"1\"", "max=\"2\""), replace(deps, 0, "occurrences matches {0..*}", "occurrences matches {0..1}"));
        rejected("ENGINE_CONSTRAINT_WIDENING", oet.replace("annotation=", "min=\"0\" annotation="), deps);
        rejected("ENGINE_RM_ATTRIBUTE_INVALID", oet, replace(deps, 3, "items cardinality", "unknown_attribute cardinality"));
        rejected("ENGINE_CARDINALITY_INVALID", oet, replace(deps, 3, "value matches", "value cardinality matches {0..*} matches"));
    }
    @Test void exposesCompilationValidationAndInspectionThroughTheNativeOperationBoundary() throws Exception {
        var engine = new NativeEngine();
        var report = engine.execute(new Request("compile/template", NativeEngineTest.fixture("legacy/nested.oet"), dependencies()));
        assertEquals(true, report.get("valid"));
        assertEquals("OET14_COMPILATION_RM_STRUCTURE", report.get("profile"));
        var output = (Map<?, ?>) report.get("output");
        assertEquals("opt14_xml", output.get("format"));
        String xml = (String) output.get("content");
        assertEquals(NativeEngine.sha256(xml), output.get("sha256"));
        for (String operation : List.of("validate/opt", "inspect/opt")) {
            var validation = engine.execute(new Request(operation, xml, List.of()));
            assertEquals(true, validation.get("valid")); assertEquals("OPT14_XML_RM_STRUCTURE", validation.get("profile"));
            assertEquals("NOT_EXECUTED", ((Map<?, ?>) validation.get("checks")).get("full_aom_semantics"));
        }
        assertThrows(EngineException.class, () -> engine.execute(new Request("validate/opt", xml.replace("<rm_type_name>ELEMENT</rm_type_name>", "<rm_type_name>INVALID</rm_type_name>"), List.of())));
    }
    @Test void appliesExplicitTextCodeAndQuantityNarrowingWithoutChangingDependencies() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet");
        String marker = "<Rule path=\"/items[at0001]\" annotation=\"Synthetic annotation; not clinical advice.\"/>";
        String textRule = "<Rule path=\"/items[at0001]\"><constraint xsi:type=\"textConstraint\"><includedValues>Explicit synthetic text</includedValues></constraint></Rule>";
        var text = new LegacyTemplateCompiler().compile(oet.replace(marker, textRule), dependencies());
        LegacyOptWriterTest.schema(text.content());
        assertTrue(text.content().contains("<list>Explicit synthetic text</list>"));
        var coded = replace(dependencies(), 3, "DV_TEXT matches {*}", "DV_CODED_TEXT matches { defining_code matches {[local::at0000, at0001]} }");
        String codeRule = textRule.replace("Explicit synthetic text", "at0001");
        var code = new LegacyTemplateCompiler().compile(oet.replace(marker, codeRule), coded);
        LegacyOptWriterTest.schema(code.content());
        assertTrue(code.content().contains("<code_list>at0001</code_list>"));
        assertFalse(code.content().contains("<code_list>at0000</code_list>"));
        rejected("ENGINE_CONSTRAINT_WIDENING", oet.replace(marker, codeRule.replace("at0001</includedValues>", "at9999</includedValues>")), coded);
        var quantity = replace(dependencies(), 3, "DV_TEXT matches {*}", "C_DV_QUANTITY <list = <[\"1\"] = <units = <\"g\"> magnitude = <|0.0..100.0|>>>>");
        String quantityRule = "<Rule path=\"/items[at0001]\"><constraint xsi:type=\"quantityConstraint\"><unitMagnitude><unit>g</unit><minMagnitude>5</minMagnitude><maxMagnitude>20</maxMagnitude></unitMagnitude></constraint></Rule>";
        var measured = new LegacyTemplateCompiler().compile(oet.replace(marker, quantityRule), quantity);
        LegacyOptWriterTest.schema(measured.content());
        assertTrue(measured.content().contains("<lower>5</lower><upper>20</upper>"));
        rejected("ENGINE_CONSTRAINT_WIDENING", oet.replace(marker, quantityRule.replace("<maxMagnitude>20", "<maxMagnitude>101")), quantity);
    }
    @Test void explicitExclusionRemainsAnExclusionAndRequiredSlotsCannotDisappear() throws Exception {
        String oet = "<template xmlns=\"openEHR/v1/Template\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><id>synthetic</id><name>Empty fixture</name><definition xsi:type=\"COMPOSITION\" archetype_id=\"openEHR-EHR-COMPOSITION.engine_fixture.v1\"/></template>";
        var deps = dependencies().subList(0, 1);
        var result = new LegacyTemplateCompiler().compile(oet, deps);
        LegacyOptWriterTest.schema(result.content());
        assertTrue(result.actions().stream().anyMatch(a -> a.get("code").equals("OPTIONAL_SLOT_EXCLUDED")));
        assertTrue(result.content().contains("<upper>0</upper>"));
        rejected("ENGINE_REQUIRED_SLOT_UNFILLED", oet, replace(deps, 0, "occurrences matches {0..*}", "occurrences matches {1..*}"));
    }

    @Test void constrainsExistingAndOmittedOpenRmAttributesWithoutBypassingSlots() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet").replace("/content[at0001]", "/content");
        var deps = dependencies();
        String constrained = deps.getFirst().content();
        int start = constrained.indexOf("    COMPOSITION[at0000]");
        int end = constrained.indexOf("\nontology", start);
        assertTrue(start > 0 && end > start);
        String source = constrained.substring(0, start) + "    COMPOSITION[at0000] matches {*}" + constrained.substring(end);
        var open = new ArrayList<>(deps);
        open.set(0, new Request.Dependency(deps.getFirst().identifier(), source, NativeEngine.sha256(source)));
        var result = new LegacyTemplateCompiler().compile(oet, open);
        LegacyOptProfile.inspect(result.content());
        assertTrue(result.actions().stream().anyMatch(a -> a.get("code").equals("RM_UNCONSTRAINED_ATTRIBUTE_NARROWED")));
        var root = SafeXml.one(SafeXml.parse(result.content()).getDocumentElement(), "definition", true);
        var content = LegacyTemplateCompiler.resolve(root, "/content");
        assertEquals(0, LegacyTemplateCompiler.lower(SafeXml.one(content, "existence", true)));
        assertEquals("true", SafeXml.text(SafeXml.one(content, "cardinality", true), "is_ordered"));
        var explicit = replace(open, 0, "COMPOSITION[at0000] matches {*}",
                "COMPOSITION[at0000] matches { content cardinality matches {0..*; unordered} matches {*} }");
        String existing = new LegacyTemplateCompiler().compile(oet, explicit).content();
        LegacyOptProfile.inspect(existing);
        var explicitContent = LegacyTemplateCompiler.resolve(SafeXml.one(SafeXml.parse(existing).getDocumentElement(), "definition", true), "/content");
        assertEquals(1, LegacyTemplateCompiler.lower(SafeXml.one(explicitContent, "existence", true)));
        assertEquals("false", SafeXml.text(SafeXml.one(explicitContent, "cardinality", true), "is_ordered"));
        rejected("ENGINE_RM_ATTRIBUTE_INVALID", oet.replace("path=\"/content\"", "path=\"/imaginary\""), open);
        rejected("ENGINE_RM_CHILD_TYPE_INVALID", oet.replace("path=\"/content\"", "path=\"/context\""), open);
        // An explicit slot remains restrictive. Its failed match cannot become an unconstrained placement.
        rejected("ENGINE_SLOT_NO_MATCH", oet, replace(deps, 0, "openEHR-EHR-.*", "openEHR-EHR-OBSERVATION.*"));
    }

    @Test void narrowsExistingFiniteNameListAndRejectsEmptyIntersection() throws Exception {
        String oet = NativeEngineTest.fixture("legacy/nested.oet");
        var deps = dependencies();
        String section = deps.get(1).content();
        String definition = "SECTION[at0000] matches { items cardinality";
        String constrained = section.replace(definition,
            "SECTION[at0000] matches { name matches { DV_TEXT matches { value matches {\"Synthetic section\", \"Other section\"; \"Other section\"} } } items cardinality");
        assertNotEquals(section, constrained);
        var narrowedDependencies = replace(deps, 1, section, constrained);
        var result = new LegacyTemplateCompiler().compile(oet, narrowedDependencies);
        LegacyOptWriterTest.schema(result.content());
        assertTrue(result.actions().stream().anyMatch(action -> "EXISTING_NAME_CONSTRAINT_NARROWED".equals(action.get("code"))));
        assertTrue(result.content().contains("<list>Synthetic section</list>"));
        assertFalse(result.content().contains("<list>Other section</list>"));

        rejected("ENGINE_NAME_CONSTRAINT_EMPTY", oet.replace("name=\"Synthetic section\"", "name=\"Unlisted section\""), narrowedDependencies);
    }
}
