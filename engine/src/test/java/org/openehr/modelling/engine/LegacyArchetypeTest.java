package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LegacyArchetypeTest {
    @Test void keepsOriginalCodesLanguagesAndBindingIdentityWithoutInventingUrls() throws Exception {
        String content = NativeEngineTest.fixture("legacy/cluster.adl");
        var source = LegacyArchetype.parse(content);
        assertEquals("openEHR-EHR-CLUSTER.engine_fixture.v1", source.identifier());
        assertEquals("at0000", source.model().getDefinition().getNodeId());
        assertEquals("at0001", source.model().getDefinition().getAttribute("items").getChildren().getFirst().getNodeId());
        assertEquals("Textelement", source.ontology().getTermDefinitions().get("de").getItems().get("at0001").getText());
        var binding = source.ontology().getTermBindings().get("fixture").getItems().get("at0001");
        assertEquals("fixture", binding.getTerminologyId());
        assertEquals("EXAMPLE", binding.getCodeString());
        assertNull(binding.getUri());
        assertTrue(source.model().getTerminology().getTermBindings().isEmpty());
        assertEquals(NativeEngine.sha256(content), source.sourceSha256());
        var withBom = LegacyArchetype.parse("\ufeff" + content);
        assertEquals(source.identifier(), withBom.identifier());
        assertEquals(NativeEngine.sha256("\ufeff" + content), withBom.sourceSha256());
    }
    @Test void routesLegacyVersionDeclarationsToTheirExplicitCompatibilityProfile() throws Exception {
        for (String version : new String[] { "1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.91.37", "9.8.7" }) {
            String source = NativeEngineTest.fixture("legacy/cluster.adl").replace("adl_version=1.4", "adl_version=" + version);
            for (String operation : new String[] { "validate/archetype", "inspect/archetype" }) {
                var report = NativeEngineTest.run(operation, source, java.util.List.of());
                assertEquals(true, report.get("valid"), report.toString());
                assertEquals(version, report.get("adl_version"));
                assertEquals("ADL14_PARSE_RM_STRUCTURE", report.get("profile"));
                assertEquals("NOT_EXECUTED", ((java.util.Map<?, ?>) report.get("checks")).get("full_aom_semantics"));
            }
        }
    }
    @Test void rejectsParseRecoveryDuplicateCodesAndDifferentLanguageVersions() throws Exception {
        String content = NativeEngineTest.fixture("legacy/cluster.adl");
        for (String invalid : new String[] { content + " garbage", content.replace("adl_version=1.4", "adl_version=not_a_version"),
                content.replace("[\"at0001\"] = <text = <\"Text element\">", "[\"at0000\"] = <text = <\"Text element\">") }) {
            assertThrows(EngineException.class, () -> LegacyArchetype.parse(invalid));
        }
    }
}
