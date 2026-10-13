package org.openehr.modelling.engine;

import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class WorkerProcessTest {
    @Test void sharedAdmissionRejectsBusyWorkAndReleasesAfterSuccess() throws Exception {
        var lock = java.nio.file.Files.createTempFile("engine-admission", ".lock");
        Process holder = null;
        byte[] request = Json.MAPPER.writeValueAsBytes(Map.of("operation", "validate/archetype", "content", NativeEngineTest.fixture("cluster.adls")));
        try {
            holder = new ProcessBuilder("/usr/bin/flock", "--exclusive", lock.toString(), "sh", "-c", "echo locked; read release").start();
            assertEquals("locked", new java.io.BufferedReader(new java.io.InputStreamReader(holder.getInputStream())).readLine());
            var worker = new WorkerProcess(lock.toString());
            assertEquals("ENGINE_BUSY", assertThrows(EngineException.class, () -> worker.execute(request, Duration.ofSeconds(10))).code);
            holder.getOutputStream().write("release\n".getBytes()); holder.getOutputStream().flush();
            assertEquals(0, holder.waitFor());
            assertTrue(Json.MAPPER.readTree(worker.execute(request, Duration.ofSeconds(20))).path("ok").asBoolean());
            assertTrue(Json.MAPPER.readTree(worker.execute(request, Duration.ofSeconds(20))).path("ok").asBoolean());
        } finally { if (holder != null) holder.destroyForcibly(); java.nio.file.Files.deleteIfExists(lock); }
    }

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
