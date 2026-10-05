package org.openehr.modelling.engine;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.*;

/** Loopback-only service. A companion application/proxy must share the network namespace. */
public final class Server {
    private final byte[] key;
    private final Semaphore capacity = new Semaphore(2);
    Server(byte[] key) { this.key = key.clone(); }

    public static void main(String[] args) throws Exception {
        String location = System.getenv().getOrDefault("ENGINE_KEY_FILE", "/run/secrets/engine-key");
        if (Files.size(Path.of(location)) > 257) throw new IllegalArgumentException("ENGINE_KEY_INVALID");
        String token = Files.readString(Path.of(location), StandardCharsets.UTF_8).strip();
        if (!token.matches("[a-f0-9]{64,128}")) throw new IllegalArgumentException("ENGINE_KEY_INVALID");
        System.setProperty("sun.net.httpserver.maxReqTime", "10");
        System.setProperty("sun.net.httpserver.maxRspTime", "60");
        System.setProperty("sun.net.httpserver.maxConnections", "24");
        System.setProperty("sun.net.httpserver.maxReqHeaders", "32");
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 8090), 16);
        server.createContext("/", new Server(token.getBytes(StandardCharsets.US_ASCII))::handle);
        server.setExecutor(new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16), new ThreadPoolExecutor.AbortPolicy()));
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(1)));
    }

    void handle(HttpExchange request) throws java.io.IOException {
        boolean acquired = false;
        try {
            String host = request.getRequestHeaders().getFirst("Host");
            if (request.getRequestHeaders().getOrDefault("Host", java.util.List.of()).size() != 1
                    || (!"127.0.0.1:8090".equals(host) && !"localhost:8090".equals(host))) {
                send(request, 403, error("ENGINE_HOST_REJECTED")); return;
            }
            if (request.getRequestHeaders().containsKey("Origin")) {
                send(request, 403, error("ENGINE_ORIGIN_REJECTED")); return;
            }
            if (request.getRequestURI().toString().equals("/health") && request.getRequestMethod().equals("GET")) {
                send(request, 200, Json.MAPPER.writeValueAsBytes(Map.of("status", "alive", "adapter", "1.0.0"))); return;
            }
            var tokens = request.getRequestHeaders().get("X-Engine-Key");
            if (tokens == null || tokens.size() != 1 || !MessageDigest.isEqual(key, tokens.getFirst().getBytes(StandardCharsets.UTF_8))) {
                send(request, 401, error("ENGINE_AUTHENTICATION_REQUIRED")); return;
            }
            String path = request.getRequestURI().toString();
            if (!path.startsWith("/v1/") || !Request.OPERATIONS.contains(path.substring(4))) {
                send(request, 404, error("ENGINE_OPERATION_UNSUPPORTED")); return;
            }
            if (!request.getRequestMethod().equals("POST")) { send(request, 405, error("ENGINE_METHOD_REJECTED")); return; }
            String contentType = request.getRequestHeaders().getFirst("Content-Type");
            if (contentType == null || !contentType.matches("(?i)application/json(?:;\\s*charset=utf-8)?")) {
                send(request, 415, error("ENGINE_JSON_REQUIRED")); return;
            }
            acquired = capacity.tryAcquire();
            if (!acquired) { request.getResponseHeaders().set("Retry-After", "2"); send(request, 503, error("ENGINE_BUSY")); return; }
            byte[] input = request.getRequestBody().readNBytes(Json.INPUT_LIMIT + 1);
            if (input.length > Json.INPUT_LIMIT) { send(request, 413, error("ENGINE_INPUT_LIMIT")); return; }
            var parser = Json.MAPPER.createParser(input);
            com.fasterxml.jackson.databind.JsonNode node = Json.MAPPER.readTree(parser);
            if (parser.nextToken() != null || !(node instanceof ObjectNode body) || node.has("operation")) {
                send(request, 400, error("ENGINE_INVALID_REQUEST")); return;
            }
            body.put("operation", path.substring(4));
            // Cheap contract validation before spending a compiler slot/JVM.
            Request.parse(body);
            byte[] output = new WorkerProcess().execute(Json.MAPPER.writeValueAsBytes(body), Duration.ofSeconds(45));
            send(request, 200, output);
        } catch (EngineException e) { send(request, e.code.equals("ENGINE_TIMEOUT") ? 504 : 422, error(e.code)); }
        catch (com.fasterxml.jackson.core.JacksonException e) { send(request, 400, error("ENGINE_INVALID_JSON")); }
        catch (Exception e) { send(request, 503, error("ENGINE_UNAVAILABLE")); }
        finally { if (acquired) capacity.release(); request.close(); }
    }

    private static byte[] error(String code) throws java.io.IOException {
        return Json.MAPPER.writeValueAsBytes(Map.of("ok", false, "error", Map.of("code", code)));
    }
    private static void send(HttpExchange exchange, int status, byte[] bytes) throws java.io.IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }
}
