package org.openehr.modelling.engine;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.*;

final class WorkerProcess {
    private final String admissionLock;
    WorkerProcess() { this(System.getenv("ENGINE_WORKER_LOCK_FILE")); }
    WorkerProcess(String admissionLock) { this.admissionLock = admissionLock; }
    byte[] execute(byte[] input, Duration timeout) throws Exception {
        if (input.length > Json.INPUT_LIMIT) throw new EngineException("ENGINE_INPUT_LIMIT");
        var builder = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-Xmx512m", "-Xss1m",
                "-XX:+ExitOnOutOfMemoryError", "-Dfile.encoding=UTF-8", "-Duser.language=en", "-Duser.country=GB",
                "-cp", System.getProperty("java.class.path"), Worker.class.getName());
        if (admissionLock != null && !admissionLock.isBlank()) {
            var path = java.nio.file.Path.of(admissionLock);
            if (!path.isAbsolute() || !java.nio.file.Files.isRegularFile(path)
                    || !java.nio.file.Files.isReadable(path) || !java.nio.file.Files.isWritable(path))
                throw new EngineException("ENGINE_WORKER_LOCK_UNAVAILABLE");
            var command = new java.util.ArrayList<>(java.util.List.of("/usr/bin/flock", "--exclusive", "--nonblock", "--conflict-exit-code", "75", "--no-fork", admissionLock));
            command.addAll(builder.command()); builder.command(command);
        }
        builder.environment().clear();
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process process = builder.start();
        try (var io = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<byte[]> wire = io.submit(() -> {
                try (var stdin = process.getOutputStream()) { stdin.write(input); }
                catch (IOException error) {
                    // Nonblocking admission can exit before the parent writes any input.
                    if (admissionLock != null && process.waitFor() == 75) throw new EngineException("ENGINE_BUSY");
                    throw error;
                }
                byte[] output = process.getInputStream().readNBytes(Json.OUTPUT_LIMIT + 1);
                if (output.length > Json.OUTPUT_LIMIT) throw new EngineException("ENGINE_OUTPUT_LIMIT");
                int status = process.waitFor();
                if (admissionLock != null && status == 75) throw new EngineException("ENGINE_BUSY");
                if (status != 0 || output.length == 0) throw new EngineException("ENGINE_WORKER_FAILED");
                return output;
            });
            try { return wire.get(timeout.toMillis(), TimeUnit.MILLISECONDS); }
            catch (ExecutionException e) {
                if (e.getCause() instanceof EngineException engineError) throw engineError;
                throw e;
            }
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
