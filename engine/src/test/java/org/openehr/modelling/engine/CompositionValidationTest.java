package org.openehr.modelling.engine;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CompositionValidationTest {
    static final String COMPOSITION = """
        {"_type":"COMPOSITION","name":{"_type":"DV_TEXT","value":"Synthetic fixture"},
         "archetype_node_id":"openEHR-EHR-COMPOSITION.engine_fixture.v1",
         "archetype_details":{"_type":"ARCHETYPED","archetype_id":{"_type":"ARCHETYPE_ID","value":"openEHR-EHR-COMPOSITION.engine_fixture.v1"},
           "template_id":{"_type":"TEMPLATE_ID","value":"Synthetic legacy test"},"rm_version":"1.0.2"},
         "language":{"_type":"CODE_PHRASE","terminology_id":{"_type":"TERMINOLOGY_ID","value":"ISO_639-1"},"code_string":"en"},
         "territory":{"_type":"CODE_PHRASE","terminology_id":{"_type":"TERMINOLOGY_ID","value":"ISO_3166-1"},"code_string":"UG"},
         "category":{"_type":"DV_CODED_TEXT","value":"persistent","defining_code":{"_type":"CODE_PHRASE","terminology_id":{"_type":"TERMINOLOGY_ID","value":"openehr"},"code_string":"431"}},
         "composer":{"_type":"PARTY_IDENTIFIED","name":"Synthetic operator"}}
        """;
    static String template() throws Exception {
        var source = NativeEngineTest.fixture("legacy/composition.adl");
        source = source.substring(0, source.indexOf("definition")) + "definition\n COMPOSITION[at0000] matches {*}\n" + source.substring(source.indexOf("ontology"));
        source = source.substring(0, source.indexOf("    term_bindings"));
        var oet = "<template xmlns=\"openEHR/v1/Template\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><id>33826b37-78c6-4796-9b4b-6e6e926e4375</id><name>Synthetic legacy test</name><definition xsi:type=\"COMPOSITION\" archetype_id=\"openEHR-EHR-COMPOSITION.engine_fixture.v1\"/></template>";
        return new LegacyTemplateCompiler().compile(oet, List.of(new Request.Dependency("openEHR-EHR-COMPOSITION.engine_fixture.v1", source, NativeEngine.sha256(source)))).content();
    }
    static Map<String, Object> validate(String composition) throws Exception {
        var template = template();
        return NativeEngineTest.run("validate/composition", composition, List.of(new Request.Dependency("Synthetic legacy test", template, NativeEngine.sha256(template))));
    }
    @Test void independentlyChecksInstalledSdkInputs() throws Exception {
        var composition = org.ehrbase.openehr.sdk.serialisation.jsonencoding.CanonicalJson.DEFAULT_INSTANCE.unmarshal(COMPOSITION, com.nedap.archie.rm.composition.Composition.class);
        var document = (org.openehr.schemas.v1.TemplateDocument) org.openehr.schemas.v1.TemplateDocument.type.getTypeSystem().parse(SafeXml.parse(template()), org.openehr.schemas.v1.TemplateDocument.type, new org.apache.xmlbeans.XmlOptions());
        var web = org.ehrbase.openehr.sdk.webtemplate.parser.OPTParser.parse(document.getTemplate());
        var violations = new java.util.ArrayList<org.ehrbase.openehr.sdk.validation.ConstraintViolation>();
        new org.ehrbase.openehr.sdk.validation.webtemplate.ValidationWalker(null, true).walk(composition, violations, web.getTree(), web.getTemplateId());
        assertTrue(violations.isEmpty(), violations.toString());
    }
    @Test void validatesCanonicalRmAgainstExactCompiledTemplate() throws Exception {
        var report = validate(COMPOSITION);
        assertEquals(true, report.get("valid"), report.toString());
        assertEquals("LOCAL_RM_ONLY", report.get("terminology"));
        assertEquals(false, report.get("clinical_approval"));
        assertEquals(NativeEngine.sha256(template()), report.get("template_sha256"));
    }
    @Test void rejectsMissingMandatoryRmAndWrongTemplateRatherThanApprovingJsonShape() throws Exception {
        assertEquals(false, validate(COMPOSITION.replace("\"composer\":{\"_type\":\"PARTY_IDENTIFIED\",\"name\":\"Synthetic operator\"}", "\"composer\":null")).get("valid"));
        assertEquals(false, validate(COMPOSITION.replace("Synthetic legacy test", "Different template")).get("valid"));
        var error = assertThrows(EngineException.class, () -> validate("{\"_type\":\"COMPOSITION\",\"_type\":\"COMPOSITION\"}"));
        assertEquals("ENGINE_COMPOSITION_VALIDATION_FAILED", error.code);
    }
    @Test void requiresOneHashPinnedOptDependency() throws Exception {
        assertThrows(EngineException.class, () -> NativeEngineTest.run("validate/composition", COMPOSITION, List.of()));
        assertThrows(EngineException.class, () -> NativeEngineTest.run("validate/composition", COMPOSITION,
            List.of(new Request.Dependency("Synthetic legacy test", template(), "0".repeat(64)))));
    }
}
