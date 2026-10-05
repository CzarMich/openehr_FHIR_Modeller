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
    @Test void rejectsParseRecoveryDuplicateCodesAndDifferentLanguageVersions() throws Exception {
        String content = NativeEngineTest.fixture("legacy/cluster.adl");
        for (String invalid : new String[] { content + " garbage", content.replace("adl_version=1.4", "adl_version=2.0.6"),
                content.replace("[\"at0001\"] = <text = <\"Text element\">", "[\"at0000\"] = <text = <\"Text element\">") }) {
            assertThrows(EngineException.class, () -> LegacyArchetype.parse(invalid));
        }
    }
}
