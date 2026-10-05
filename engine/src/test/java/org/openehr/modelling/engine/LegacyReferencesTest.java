package org.openehr.modelling.engine;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.openehr.modelling.engine.SafeXml.*;
import static org.openehr.modelling.engine.LegacyTemplateCompiler.*;

class LegacyReferencesTest {
    private static String compile(String source) {
        String identifier = LegacyArchetype.parse(source).identifier();
        String oet = "<template xmlns=\"openEHR/v1/Template\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
                + "<id>reference-fixture</id><name>Synthetic reference fixture</name><definition xsi:type=\"CLUSTER\" archetype_id=\"" + identifier + "\"/></template>";
        return new LegacyTemplateCompiler().compile(oet, List.of(new Request.Dependency(identifier, source, NativeEngine.sha256(source)))).content();
    }

    @Test void reusesOriginalConstraintsAndInheritsOnlyAbsentOverrides() throws Exception {
        String source = NativeEngineTest.fixture("legacy/references.adl");
        String xml = compile(source);
        LegacyOptProfile.inspect(xml);
        var root = one(parse(xml).getDocumentElement(), "definition", true);
        var inherited = resolve(root, "/items[at0003]/items[at0002]");
        assertEquals(0, lower(one(inherited, "occurrences", true)));
        assertEquals(1, upper(one(inherited, "occurrences", true)));
        var overridden = resolve(root, "/items[at0004]");
        assertEquals(1, upper(one(overridden, "occurrences", true)));
        assertEquals(2, upper(one(resolve(root, "/items[at0001]"), "occurrences", true)));
        assertNotNull(resolve(root, "/items[at0004]/items[at0002]"));
        assertEquals(3, xml.split("<list>Synthetic value</list>", -1).length - 1);
        assertEquals(xml, compile(source));
    }

    @Test void rejectsMissingIncompatibleAndCyclicReferences() throws Exception {
        String source = NativeEngineTest.fixture("legacy/references.adl");
        assertEquals("ENGINE_INTERNAL_REFERENCE_MISSING", assertThrows(EngineException.class,
                () -> compile(source.replace("use_node ELEMENT /items[at0001]/items[at0002]", "use_node ELEMENT /items[at9999]"))).code);
        assertEquals("ENGINE_INTERNAL_REFERENCE_TYPE_INVALID", assertThrows(EngineException.class,
                () -> compile(source.replace("use_node ELEMENT /items[at0001]/items[at0002]", "use_node CLUSTER /items[at0001]/items[at0002]"))).code);
        String cyclic = source.replace("ELEMENT[at0002] occurrences matches {0..1} matches {\n                        value matches { DV_TEXT matches { value matches {\"Synthetic value\"} } }\n                    }", "use_node CLUSTER /items[at0001]");
        assertNotEquals(source, cyclic);
        assertEquals("ENGINE_INTERNAL_REFERENCE_CYCLE", assertThrows(EngineException.class, () -> compile(cyclic)).code);
    }
}
