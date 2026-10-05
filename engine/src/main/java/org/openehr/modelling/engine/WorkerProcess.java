package org.openehr.modelling.engine;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.*;

final class WorkerProcess {
    byte[] execute(byte[] input, Duration timeout) throws Exception {
        if (input.length > Json.INPUT_LIMIT) throw new EngineException("ENGINE_INPUT_LIMIT");
        var builder = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-Xmx512m", "-Xss1m",
                "-XX:+ExitOnOutOfMemoryError", "-Dfile.encoding=UTF-8", "-Duser.language=en", "-Duser.country=GB",
                "-cp", System.getProperty("java.class.path"), Worker.class.getName());
        builder.environment().clear();
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process process = builder.start();
        try (var io = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<byte[]> wire = io.submit(() -> {
                try (var stdin = process.getOutputStream()) { stdin.write(input); }
                byte[] output = process.getInputStream().readNBytes(Json.OUTPUT_LIMIT + 1);
                if (output.length > Json.OUTPUT_LIMIT) throw new EngineException("ENGINE_OUTPUT_LIMIT");
                if (process.waitFor() != 0 || output.length == 0) throw new EngineException("ENGINE_WORKER_FAILED");
                return output;
            });
            try { return wire.get(timeout.toMillis(), TimeUnit.MILLISECONDS); }
            catch (TimeoutException e) { throw new EngineException("ENGINE_TIMEOUT"); }
            finally {
                process.destroyForcibly();
                // Close pipes before closing the executor, including timeout during a blocked write.
                try { process.getOutputStream().close(); } catch (IOException ignored) {}
                try { process.getInputStream().close(); } catch (IOException ignored) {}
                wire.cancel(true);
            }
        }
    }
}
