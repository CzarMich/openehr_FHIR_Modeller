package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.openehr.modelling.engine.NativeEngineTest.*;

class AqlTemplatePathsTest {
    static String legacy() throws Exception {
        return new LegacyTemplateCompiler().compile(fixture("legacy/nested.oet"), LegacyTemplateCompilerTest.dependencies()).content();
    }
    static Map<String, Object> check(String query, String opt) {
        return run("validate/aql", query, List.of(dependency(opt, "selected-template")));
    }
    @Test void pathLabelsComeFromTheExactArchetypeScopeAndExtendToItsValue() throws Exception {
        var paths = LegacyOptProfile.inspect(legacy()).paths();
        var element = paths.stream().filter(path -> "ELEMENT".equals(path.get("rm_type"))).findFirst().orElseThrow();
        assertEquals("Text element", element.get("label"));
        assertEquals("Synthetic value", element.get("description"));
        var value = paths.stream().filter(path -> (element.get("path") + "/value").equals(path.get("path"))).findFirst().orElseThrow();
        assertEquals("Text element", value.get("label"));
        var data = paths.stream().filter(path -> "ITEM_TREE".equals(path.get("rm_type"))).findFirst().orElseThrow();
        assertEquals("Data", data.get("label")); // Same at0001 code, different archetype scope.
    }
    @Test void checksContainmentAndPathsInSelectWhereAndOrderBy() throws Exception {
        String query = "SELECT e/ehr_id/value, x/items[at0001]/value/value FROM EHR e CONTAINS COMPOSITION c CONTAINS CLUSTER x[openEHR-EHR-CLUSTER.engine_fixture.v1] WHERE c/name/value = 'example' ORDER BY c/context/start_time/value";
        var report = check(query, legacy());
        assertEquals("PASS", report.get("status"), report.toString());
        assertEquals("AQL_TEMPLATE_PATHS", report.get("profile"));
        assertEquals("NOT_EXECUTED", ((Map<?, ?>) report.get("checks")).get("query_execution"));
        for (String invalid : List.of(query.replace("at0001", "at9999"), query.replace("c/name/value", "c/misspelled/value"), query.replace("start_time/value", "start_time/misspelled"), query.replace("CLUSTER.engine_fixture", "CLUSTER.missing")))
            assertEquals("FAIL", check(invalid, legacy()).get("status"), invalid);
    }
    @Test void checksFullCompositionPathsAndPredicateFields() throws Exception {
        String path = "c/content[openEHR-EHR-SECTION.engine_fixture.v1]/items[openEHR-EHR-EVALUATION.engine_fixture.v1]/data[at0001]/items[openEHR-EHR-CLUSTER.engine_fixture.v1]/items[at0001]/value/value";
        var report = check("SELECT " + path + " FROM COMPOSITION c", legacy());
        assertEquals("PASS", report.get("status"), report.toString());
        assertEquals("FAIL", check("SELECT " + path.replace("items[at0001]", "items[at0001 and nonexistent='x']") + " FROM COMPOSITION c", legacy()).get("status"));
    }
    @Test void provesNativeOpt2ReferenceModelPathsWithoutInventingNodeIds() throws Exception {
        var compiled = run("compile/template", fixture("template.adlt"), List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0")));
        String opt = (String) ((Map<?, ?>) compiled.get("output")).get("content");
        var report = check("SELECT c/name/value, c/context/start_time/value FROM COMPOSITION c", opt);
        assertEquals("PASS", report.get("status"), report.toString());
        assertEquals("INCOMPLETE", check("SELECT c/content[at9999]/name/value FROM COMPOSITION c", opt).get("status"));
    }
    @Test void unsupportedContainmentAndDynamicNodeIdsNeverClaimCompleteSuccess() throws Exception {
        for (String query : List.of("SELECT c/name/value FROM COMPOSITION c CONTAINS (CLUSTER a OR CLUSTER b)",
                "SELECT c/content[archetype_node_id=$node]/name/value FROM COMPOSITION c")) {
            var report = check(query, legacy());
            assertNotEquals("PASS", report.get("status"), report.toString());
            assertEquals(false, report.get("valid"));
        }
    }
    @Test void syntaxOnlyRemainsAvailableAndInvalidQueriesDoNotClaimTemplateChecks() throws Exception {
        assertEquals("AQL_SYNTAX", run("validate/aql", "SELECT c FROM COMPOSITION c", List.of()).get("profile"));
        var result = check("SELECT FROM", legacy());
        assertEquals(false, result.get("valid"));
        assertFalse(result.containsKey("templates"));
    }
    @Test void selectedRootPredicatesAndExcludedChildrenCannotPass() throws Exception {
        assertEquals("FAIL", check("SELECT c[openEHR-EHR-COMPOSITION.missing.v1]/name/value FROM COMPOSITION c", legacy()).get("status"));
        String oet = fixture("legacy/nested.oet").replace("<Rule path=\"/items[at0001]\"", "<Rule min=\"0\" max=\"0\" path=\"/items[at0001]\"");
        var dependencies = LegacyTemplateCompilerTest.replace(LegacyTemplateCompilerTest.dependencies(), 3, "occurrences matches {1..1}", "occurrences matches {0..1}");
        dependencies = LegacyTemplateCompilerTest.replace(dependencies, 3, "cardinality matches {1..*", "cardinality matches {0..*");
        String opt = new LegacyTemplateCompiler().compile(oet, dependencies).content();
        assertEquals("FAIL", check("SELECT x/items[at0001]/value/value FROM CLUSTER x[openEHR-EHR-CLUSTER.engine_fixture.v1]", opt).get("status"));
    }
}
