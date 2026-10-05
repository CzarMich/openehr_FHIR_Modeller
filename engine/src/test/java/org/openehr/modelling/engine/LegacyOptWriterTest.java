package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import org.openehr.referencemodels.BuiltinReferenceModels;
import org.openehr.schemas.v1.TemplateDocument;
import org.apache.xmlbeans.XmlOptions;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.openehr.modelling.engine.SafeXml.*;

class LegacyOptWriterTest {
    static String write(String content) {
        var source = LegacyArchetype.parse(content);
        source.model().setRmRelease("1.0.2");
        var writer = new LegacyOptWriter("en", BuiltinReferenceModels.getMetaModelProvider().getMetaModel(source.model()));
        LegacyOptWriter.phrase(add(writer.template, "language"), source.model().getOriginalLanguage());
        value(add(writer.template, "template_id"), "value", "Synthetic legacy test");
        value(writer.template, "concept", "Synthetic legacy test");
        writer.template.appendChild(writer.root(source, "definition"));
        writer.ontology(writer.template, "ontology", source);
        return serialize(writer.document);
    }
    static void schema(String xml) throws Exception {
        // The SDK's generated type loader preserves xsi:type across XMLBeans versions.
        var parsed = (TemplateDocument) TemplateDocument.type.getTypeSystem().parse(SafeXml.parse(xml), TemplateDocument.type, new XmlOptions());
        List<org.apache.xmlbeans.XmlError> errors = new ArrayList<>();
        assertTrue(parsed.validate(new XmlOptions().setErrorListener(errors)), () -> errors.toString());
        assertNotNull(parsed.getTemplate().getDefinition());
        LegacyOptProfile.inspect(xml);
    }
    @Test void serializesOriginalTermsAndBindingsToIndependentOpt14Schema() throws Exception {
        String output = write(NativeEngineTest.fixture("legacy/cluster.adl"));
        schema(output);
        assertTrue(output.contains("Textelement"));
        assertTrue(output.contains("Synthetic value"));
        assertTrue(output.contains("EXAMPLE"));
        assertFalse(output.contains("fixture.org"));
        assertEquals(output, write(NativeEngineTest.fixture("legacy/cluster.adl")));
    }
    @Test void preservesQuantityDomainsWithoutAddingMissingMagnitudeOrPrecisionBounds() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl").replace("DV_TEXT matches {*}" , """
                C_DV_QUANTITY <
                    property = <[openehr::122]>
                    list = <
                        [\"1\"] = <units = <\"mm[Hg]\"> magnitude = <|0.0..300.0|> precision = <|0..2|>>
                        [\"2\"] = <units = <\"kPa\">>
                    >
                    assumed_value = <units = <\"mm[Hg]\"> magnitude = <120.0> precision = <1>>
                >
                """);
        String output = write(source); schema(output);
        assertTrue(output.contains("C_DV_QUANTITY"));
        var doc = SafeXml.parse(output);
        var lists = doc.getElementsByTagNameNS(OPT, "list");
        var last = (org.w3c.dom.Element) lists.item(lists.getLength() - 1);
        assertEquals("kPa", text(last, "units"));
        assertNull(one(last, "magnitude", false)); assertNull(one(last, "precision", false));
        assertTrue(output.contains("<assumed_value><magnitude>120.0</magnitude><units>mm[Hg]</units><precision>1</precision></assumed_value>"));
    }
    @Test void preservesCodeSystemVersionAndLiteralStringsThatLookLikePatterns() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl");
        String code = write(source.replace("DV_TEXT matches {*}" , "DV_CODED_TEXT matches { defining_code matches {[fixture(2026)::EXAMPLE]} }"));
        schema(code); assertTrue(code.contains("fixture(2026)")); assertTrue(code.contains("<code_list>EXAMPLE</code_list>"));
        String literal = write(source.replace("DV_TEXT matches {*}" , "DV_TEXT matches { value matches {\"/literal/\", \"other\"} }"));
        schema(literal); assertTrue(literal.contains("<list>/literal/</list>")); assertFalse(literal.contains("<pattern>literal</pattern>"));
    }
    @Test void preservesOrdinalValuesTermsAndAssumptions() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl").replace("DV_TEXT matches {*}" , "0|[local::at0000], 1|[local::at0001]; 1");
        String output = write(source); schema(output);
        assertTrue(output.contains("C_DV_ORDINAL"));
        assertTrue(output.contains("<assumed_value><value>1</value><symbol><value>Text element</value>"));
    }
    @Test void preservesRepresentableBooleanNumericAndTemporalConstraints() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl");
        for (String constraint : List.of(
                "DV_BOOLEAN matches { value matches {True; True} }",
                "DV_COUNT matches { magnitude matches {|0..10|; 5} }",
                "DV_QUANTITY matches { magnitude matches {|0.0..100.0|; 50.0} units matches {\"g\"} }",
                "DV_DATE matches { value matches {|2020-01-01..2030-12-31|} }",
                "DV_TIME matches { value matches {|09:00:00..17:00:00|} }",
                "DV_DATE_TIME matches { value matches {|2020-01-01T00:00:00..2030-12-31T23:59:59|} }",
                "DV_DURATION matches { value matches {|PT1H..PT2H|} }")) {
            String output = write(source.replace("DV_TEXT matches {*}", constraint));
            schema(output);
        }
    }
    @Test void rejectsInvalidAssumptionsEvenWhenTheXmlSchemaAcceptsThem() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl");
        for (String constraint : List.of(
                "DV_COUNT matches { magnitude matches {|0..10|; 50} }",
                "DV_TEXT matches { value matches {\"allowed\"; \"wrong\"} }",
                "C_DV_QUANTITY <list = <[\"1\"] = <units = <\"g\"> magnitude = <|0.0..100.0|>>> assumed_value = <units = <\"g\"> magnitude = <500.0>> >")) {
            String output = write(source.replace("DV_TEXT matches {*}", constraint));
            assertThrows(EngineException.class, () -> LegacyOptProfile.inspect(output));
        }
    }
    @Test void temporalSingletonDoesNotInventAnAssumptionOrEraseAnInvalidExplicitOne() throws Exception {
        String source = NativeEngineTest.fixture("legacy/cluster.adl");
        String plain = write(source.replace("DV_TEXT matches {*}", "DV_DATE matches { value matches {2025-01-01} }"));
        schema(plain); assertFalse(plain.contains("assumed_value"));
        String bad = write(source.replace("DV_TEXT matches {*}", "DV_DATE matches { value matches {2025-01-01; 2025-02-01} }"));
        assertTrue(bad.contains("<assumed_value>2025-02-01</assumed_value>"));
        assertThrows(EngineException.class, () -> LegacyOptProfile.inspect(bad));
        assertThrows(EngineException.class, () -> write(source.replace("DV_TEXT matches {*}", "DV_DATE matches { value matches {|2030-01-01..2020-01-01|} }")));
    }
}
