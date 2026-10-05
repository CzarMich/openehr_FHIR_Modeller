package org.openehr.modelling.engine;

import java.io.OutputStream;
import java.io.PrintStream;
import java.util.Map;

/** One bounded, disposable JVM per operation. Compiler failures cannot corrupt another request's state. */
public final class Worker {
    public static void main(String[] args) throws Exception {
        PrintStream wire = System.out;
        System.setOut(new PrintStream(OutputStream.nullOutputStream()));
        System.setErr(new PrintStream(OutputStream.nullOutputStream()));
        Object result;
        try {
            byte[] input = System.in.readNBytes(Json.INPUT_LIMIT + 1);
            if (input.length > Json.INPUT_LIMIT) throw new EngineException("ENGINE_INPUT_LIMIT");
            var parser = Json.MAPPER.createParser(input);
            com.fasterxml.jackson.databind.JsonNode json = Json.MAPPER.readTree(parser);
            if (parser.nextToken() != null) throw new EngineException("ENGINE_INVALID_REQUEST");
            result = Map.of("ok", true, "data", new NativeEngine().execute(Request.parse(json)));
        } catch (EngineException e) {
            result = Map.of("ok", false, "error", Map.of("code", e.code));
        } catch (com.fasterxml.jackson.core.JacksonException e) {
            result = Map.of("ok", false, "error", Map.of("code", "ENGINE_INVALID_JSON"));
        } catch (Throwable e) {
            // No model text, compiler internals or credentials in process logs.
            result = Map.of("ok", false, "error", Map.of("code", "ENGINE_PROCESSING_FAILED"));
        }
        byte[] output = Json.MAPPER.writeValueAsBytes(result);
        if (output.length > Json.OUTPUT_LIMIT) {
            output = Json.MAPPER.writeValueAsBytes(Map.of("ok", false, "error", Map.of("code", "ENGINE_OUTPUT_LIMIT")));
        }
        wire.write(output);
        wire.flush();
    }
    private Worker() {}
}
