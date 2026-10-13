package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class LegacyInheritanceTest {
    static final String PARENT = "openEHR-EHR-COMPOSITION.engine_fixture.v1";
    static final String CHILD = "openEHR-EHR-COMPOSITION.engine_fixture-result.v1";
    private static String specialised(String parent) {
        return parent.replace(PARENT, CHILD + "\nspecialise\n    " + PARENT)
                .replace("[at0000]", "[at0000.1]")
                .replace("[\"at0000\"]", "[\"at0000.1\"]");
    }
    private static String oet() throws Exception {
        return NativeEngineTest.fixture("legacy/nested.oet").replace(PARENT, CHILD);
    }
    private static List<Request.Dependency> dependencies(String child) throws Exception {
        var result = new ArrayList<>(LegacyTemplateCompilerTest.dependencies());
        result.add(NativeEngineTest.dependency(child, CHILD));
        return result;
    }
    @Test void compilesSpecialisedFlatAndDifferentialSourcesPreservingOriginalIdentities() throws Exception {
        String parent = NativeEngineTest.fixture("legacy/composition.adl");
        String child = specialised(parent);
        var deps = dependencies(child);
        var flat = new LegacyTemplateCompiler().compile(oet(), deps);
        assertTrue(flat.content().contains(CHILD));
        assertTrue(flat.content().contains("at0000.1"));
        assertTrue(flat.actions().stream().anyMatch(a -> a.get("code").equals("ADL14_SPECIALIZATION_FLATTENED")));
        assertEquals(flat.content(), new LegacyTemplateCompiler().compile(oet(), deps.reversed()).content());
        LegacyOptProfile.inspect(flat.content());
        String differential = child.replace(child.substring(child.indexOf("    COMPOSITION["), child.indexOf("\nontology")),
                "    COMPOSITION[at0000.1] matches {*}");
        var inherited = new LegacyTemplateCompiler().compile(oet(), dependencies(differential));
        assertEquals(flat.content(), inherited.content());
        assertEquals(parent, deps.getFirst().content());
    }
    @Test void rejectsMissingParentsCyclesAndWideningRatherThanDroppingSpecialisation() throws Exception {
        String parent = NativeEngineTest.fixture("legacy/composition.adl");
        var deps = dependencies(specialised(parent));
        LegacyTemplateCompilerTest.rejected("ENGINE_DEPENDENCY_MISSING", oet(), deps.subList(1, deps.size()));
        String cyclic = parent.replace("concept\n", "specialise\n    " + CHILD + "\nconcept\n");
        deps.set(0, NativeEngineTest.dependency(cyclic, PARENT));
        LegacyTemplateCompilerTest.rejected("ENGINE_SPECIALIZATION_CYCLE", oet(), deps);
        String narrowed = parent.replace("occurrences matches {0..*}", "occurrences matches {0..1}");
        deps = dependencies(specialised(parent));
        deps.set(0, NativeEngineTest.dependency(narrowed, PARENT));
        // Slot constraint changes need exact qualified semantics; they cannot bypass inheritance.
        LegacyTemplateCompilerTest.rejected("ENGINE_SPECIALIZATION_CONSTRAINT_UNSUPPORTED", oet(), deps);
    }
    @Test void rejectsWidenedOccurrencesAndDefaultExistenceOnInheritedNodes() throws Exception {
        String parent = NativeEngineTest.fixture("legacy/cluster.adl");
        String parentId = "openEHR-EHR-CLUSTER.engine_fixture.v1";
        String childId = "openEHR-EHR-CLUSTER.engine_fixture-special.v1";
        String child = parent.replace(parentId, childId + "\nspecialise\n" + parentId)
                .replace("[at0000]", "[at0000.1]").replace("[\"at0000\"]", "[\"at0000.1\"]");
        String template = NativeEngineTest.fixture("legacy/nested.oet").replace(parentId, childId);
        for (String widened : List.of(child.replace("occurrences matches {1..1}", "occurrences matches {0..2}"),
                child.replace("value matches", "value existence matches {0..1} matches"))) {
            var deps = new ArrayList<>(LegacyTemplateCompilerTest.dependencies());
            deps.add(NativeEngineTest.dependency(widened, childId));
            LegacyTemplateCompilerTest.rejected("ENGINE_CONSTRAINT_WIDENING", template, deps);
        }
    }

    @Test void inheritsTypedBindingsAndTermsWithoutInventingExternalUrls() throws Exception {
        String parent = NativeEngineTest.fixture("legacy/composition.adl");
        String child = specialised(parent).replace("    term_bindings = <\n        [\"fixture\"] = <items = <[\"at0001\"] = <[fixture::EXAMPLE]>>>\n    >", "");
        var result = new LegacyTemplateCompiler().compile(oet(), dependencies(child));
        assertTrue(result.content().contains("EXAMPLE"));
        assertFalse(result.content().contains("http://fixture"));
    }
}
