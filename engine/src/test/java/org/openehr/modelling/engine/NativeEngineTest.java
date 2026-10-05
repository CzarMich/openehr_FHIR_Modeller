package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class NativeEngineTest {
    static String fixture(String name) throws Exception {
        try (var stream = NativeEngineTest.class.getResourceAsStream("/" + name)) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    static Map<String, Object> run(String operation, String content, List<Request.Dependency> dependencies) {
        return new NativeEngine().execute(new Request(operation, content, dependencies));
    }
    static Request.Dependency dependency(String content, String id) {
        return new Request.Dependency(id, content, NativeEngine.sha256(content));
    }

    @Test void nativeValidationFindsActualConstraints() throws Exception {
        var result = run("validate/archetype", fixture("cluster.adls"), List.of());
        assertEquals(true, result.get("valid"), result.toString());
        assertEquals(NativeEngine.sha256(fixture("cluster.adls")), result.get("content_sha256"));
        assertTrue(Json.MAPPER.writeValueAsString(result.get("inspection")).contains("/items[id2]/value[id3]"));
        assertEquals(false, result.get("clinical_approval"));
    }

    @Test void rejectsBrokenGrammarAndRmTypes() throws Exception {
        assertEquals(false, run("validate/archetype", "archetype invalid garbage", List.of()).get("valid"));
        var result = run("validate/archetype", fixture("cluster.adls").replace("DV_TEXT[id3]", "DV_IMAGINARY[id3]"), List.of());
        assertEquals(false, result.get("valid"), result.toString());
        assertTrue(result.get("findings").toString().contains("DV_IMAGINARY"));
    }

    @Test void parserRecoveryIsNotValidation() throws Exception {
        assertEquals(false, run("validate/archetype", fixture("cluster.adls") + "\nstray INVALID tokens !!", List.of()).get("valid"));
        assertEquals(false, run("validate/archetype", fixture("cluster.adls").replace("{1..1}", "{4..1}"), List.of()).get("valid"));
    }

    @Test void compilesWithPinnedDependenciesAndRevalidatesOpt() throws Exception {
        var dependencies = List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0"));
        var result = run("compile/template", fixture("template.adlt"), dependencies);
        assertEquals(true, result.get("valid"), result.toString());
        var output = (Map<?, ?>) result.get("output");
        assertEquals("opt2_adl", output.get("format"));
        assertEquals(NativeEngine.sha256((String) output.get("content")), output.get("sha256"));
        var repeated = run("compile/template", fixture("template.adlt"), dependencies);
        assertEquals(output, repeated.get("output"));
        var validation = run("validate/opt", (String) output.get("content"), List.of());
        assertEquals(true, validation.get("valid"), validation.toString());
    }

    @Test void missingOrWrongDependencyNeverSubstitutes() throws Exception {
        assertEquals(false, run("compile/template", fixture("template.adlt"), List.of()).get("valid"));
        var wrong = List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.other.v1.0.0"));
        assertEquals("ENGINE_DEPENDENCY_ID_MISMATCH", assertThrows(EngineException.class,
                () -> run("compile/template", fixture("template.adlt"), wrong)).code);
        var duplicate = List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0"),
                dependency(fixture("composition.adls").replace("v1.0.0", "v1.1.0"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.1.0"));
        assertEquals("ENGINE_DEPENDENCY_AMBIGUOUS", assertThrows(EngineException.class,
                () -> run("compile/template", fixture("template.adlt"), duplicate)).code);
        var newer = List.of(dependency(fixture("composition.adls").replace("v1.0.0", "v1.1.0"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.1.0"));
        assertEquals(false, run("compile/template", fixture("template.adlt").replace("engine_fixture.v1\n", "engine_fixture.v1.0.0\n"), newer).get("valid"));
    }

    @Test void nestedArchetypesAndTerminologySurviveCompilation() throws Exception {
        var dependencies = List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0"),
                dependency(fixture("evaluation.adls"), "openEHR-EHR-EVALUATION.engine_fixture.v1.0.0"),
                dependency(fixture("cluster-rich.adls"), "openEHR-EHR-CLUSTER.engine_fixture.v1.0.0"));
        String template = fixture("template.adlt")
                .replace("COMPOSITION[id1.1]", "COMPOSITION[id1.1] matches { content matches { use_archetype EVALUATION[id0.1, openEHR-EHR-EVALUATION.engine_fixture.v1] } }")
                .replace("[\"id1.1\"] = <", "[\"id0.1\"] = <text = <\"Evaluation\"> description = <\"Synthetic embedded evaluation\">>\n            [\"id1.1\"] = <");
        var result = run("compile/template", template, dependencies);
        assertEquals(true, result.get("valid"), result.toString());
        var output = (Map<?, ?>) result.get("output");
        assertTrue(output.get("content").toString().contains("Text element"));
        assertTrue(output.get("content").toString().contains("component_terminologies"));
        assertTrue(output.get("content").toString().contains("Textelement"));
        assertTrue(output.get("content").toString().contains("https://example.invalid/terminology/fixture/version/1#element"));
        assertTrue(output.get("content").toString().contains("Synthetic preservation marker"));
        var bindings = (List<?>) result.get("terminology_dependencies");
        assertEquals(1, bindings.size());
        assertEquals("https://example.invalid/terminology/fixture/version/1#element", ((Map<?, ?>) bindings.getFirst()).get("binding_uri"));
        assertEquals("id2", ((Map<?, ?>) bindings.getFirst()).get("local_code_or_path"));
        assertEquals("NOT_EXECUTED", ((Map<?, ?>) bindings.getFirst()).get("validation"));
        assertEquals(output, run("compile/template", template, dependencies).get("output"));
        String opt = output.get("content").toString();
        assertEquals(true, run("validate/opt", opt, List.of()).get("valid"));
        assertEquals(false, run("validate/opt", opt.replace("DV_TEXT[id3]", "DV_IMAGINARY[id3]"), List.of()).get("valid"));
        assertEquals(false, run("validate/opt", opt.substring(0, opt.indexOf("component_terminologies")), List.of()).get("valid"));
        assertEquals(false, run("validate/opt", opt.replace("[\"id2\"] = <", "[\"id404\"] = <"), List.of()).get("valid"));
    }

    @Test void unresolvedSlotsAndMixedRmDependenciesCannotProduceOpt() throws Exception {
        var dependencies = List.of(dependency(fixture("composition.adls"), "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0"));
        String template = fixture("template.adlt")
                .replace("COMPOSITION[id1.1]", "COMPOSITION[id1.1] matches { content matches { allow_archetype EVALUATION[id0.1] matches { include archetype_id/value matches {/openEHR-EHR-EVALUATION\\..*/} } } }")
                .replace("[\"id1.1\"] = <", "[\"id0.1\"] = <text = <\"Evaluation slot\"> description = <\"Unresolved synthetic slot\">>\n            [\"id1.1\"] = <");
        assertEquals("ENGINE_OPT_UNRESOLVED_SLOT", assertThrows(EngineException.class,
                () -> run("compile/template", template, dependencies)).code);
        var incompatible = List.of(dependency(fixture("composition.adls").replace("rm_release=1.0.4", "rm_release=1.0.3"),
                "openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0"));
        assertEquals("ENGINE_DEPENDENCY_RM_MISMATCH", assertThrows(EngineException.class,
                () -> run("compile/template", fixture("template.adlt"), incompatible)).code);
    }

    @Test void realAqlParserDoesNotRequireCdr() {
        var result = run("validate/aql", "SELECT e/ehr_id/value FROM EHR e CONTAINS COMPOSITION c WHERE c/name/value = 'test' LIMIT 10", List.of());
        assertEquals(true, result.get("valid"), result.toString());
        assertNotNull(result.get("ast"));
        assertTrue(result.get("unexecuted").toString().contains("query_execution"));
        for (String bad : List.of("SELECT !!! FROM", "SELECT c/ FROM COMPOSITION c", "SELECT e/ehr_id/value FROM EHR e GARBAGE", "DROP TABLE EHR")) {
            assertEquals(false, run("validate/aql", bad, List.of()).get("valid"), bad);
        }
    }

    @Test void requestContractRejectsAmbiguityAndExcess() throws Exception {
        assertThrows(Exception.class, () -> Json.MAPPER.readTree("{\"content\":\"one\",\"content\":\"two\"}"));
        assertThrows(EngineException.class, () -> Request.parse(Json.MAPPER.readTree("{\"operation\":\"validate/aql\",\"content\":\"SELECT 1\",\"url\":\"https://example.org\"}")));
        assertThrows(EngineException.class, () -> Request.parse(Json.MAPPER.readTree("{\"operation\":\"execute\",\"content\":\"x\"}")));
        assertThrows(EngineException.class, () -> Request.parse(Json.MAPPER.valueToTree(Map.of("operation", "validate/archetype", "content", "x", "dependencies", List.of(Map.of("identifier", "id", "content", "x", "sha256", "0".repeat(64)))))));
    }
}
