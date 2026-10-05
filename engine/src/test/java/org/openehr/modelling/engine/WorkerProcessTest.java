package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class WorkerProcessTest {
    @Test void isolatedWorkerReturnsStructuredResultOnly() throws Exception {
        byte[] result = new WorkerProcess().execute(Json.MAPPER.writeValueAsBytes(Map.of(
                "operation", "validate/archetype", "content", NativeEngineTest.fixture("cluster.adls"))), Duration.ofSeconds(20));
        var json = Json.MAPPER.readTree(result);
        assertTrue(json.path("ok").asBoolean());
        assertTrue(json.path("data").path("valid").asBoolean(), json.toString());
        assertFalse(json.path("data").path("clinical_approval").asBoolean());
    }

    @Test void workerRejectsDuplicateTrailingAndUnknownInput() throws Exception {
        for (String bad : new String[] {"{}{}", "{\"content\":\"x\",\"content\":\"y\"}", "{\"operation\":\"execute\",\"content\":\"x\"}"}) {
            var result = Json.MAPPER.readTree(new WorkerProcess().execute(bad.getBytes(java.nio.charset.StandardCharsets.UTF_8), Duration.ofSeconds(10)));
            assertFalse(result.path("ok").asBoolean());
            assertFalse(result.has("data"));
        }
    }

    @Test void timedOutWorkerIsTerminated() {
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> {
            byte[] request = Json.MAPPER.writeValueAsBytes(Map.of("operation", "validate/archetype", "content", NativeEngineTest.fixture("cluster.adls")));
            EngineException error = assertThrows(EngineException.class, () -> new WorkerProcess().execute(request, Duration.ofMillis(1)));
            assertEquals("ENGINE_TIMEOUT", error.code);
        });
    }
}
