package org.openehr.modelling.engine;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

record Request(String operation, String content, List<Dependency> dependencies) {
    static final Set<String> OPERATIONS = Set.of("validate/archetype", "validate/template", "validate/opt",
            "compile/template", "inspect/archetype", "inspect/opt", "validate/aql");
    record Dependency(String identifier, String content, String sha256) {}

    static Request parse(JsonNode node) {
        object(node, Set.of("operation", "content", "dependencies"));
        String operation = text(node, "operation", 64);
        if (!OPERATIONS.contains(operation)) throw new EngineException("ENGINE_OPERATION_UNSUPPORTED");
        String content = text(node, "content", 2 * 1024 * 1024);
        List<Dependency> dependencies = new ArrayList<>();
        if (node.has("dependencies")) {
            JsonNode items = node.get("dependencies");
            if (!items.isArray() || items.size() > 64) throw new EngineException("ENGINE_DEPENDENCY_LIMIT");
            for (JsonNode item : items) {
                object(item, Set.of("identifier", "content", "sha256"));
                String id = text(item, "identifier", 300);
                String source = text(item, "content", 2 * 1024 * 1024);
                String sha = text(item, "sha256", 64);
                if (!sha.matches("[a-f0-9]{64}") || !sha.equals(NativeEngine.sha256(source))) {
                    throw new EngineException("ENGINE_DEPENDENCY_HASH_MISMATCH");
                }
                dependencies.add(new Dependency(id, source, sha));
            }
        }
        if (operation.equals("validate/aql") && dependencies.size() > 8) throw new EngineException("ENGINE_DEPENDENCY_LIMIT");
        return new Request(operation, content, List.copyOf(dependencies));
    }

    private static void object(JsonNode node, Set<String> keys) {
        if (node == null || !node.isObject()) throw new EngineException("ENGINE_INVALID_REQUEST");
        node.fieldNames().forEachRemaining(key -> { if (!keys.contains(key)) throw new EngineException("ENGINE_INVALID_REQUEST"); });
    }

    private static String text(JsonNode node, String key, int limit) {
        JsonNode value = node.get(key);
        if (value == null || !value.isTextual() || value.textValue().isBlank()
                || value.textValue().getBytes(StandardCharsets.UTF_8).length > limit
                || value.textValue().indexOf('\0') >= 0) throw new EngineException("ENGINE_INVALID_REQUEST");
        return value.textValue();
    }
}
