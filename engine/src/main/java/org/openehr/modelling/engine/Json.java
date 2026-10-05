package org.openehr.modelling.engine;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;

final class Json {
    static final int INPUT_LIMIT = 8 * 1024 * 1024;
    static final int OUTPUT_LIMIT = 16 * 1024 * 1024;
    static final ObjectMapper MAPPER = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64)
                    .maxStringLength(2 * 1024 * 1024).maxNumberLength(64).build()).build())
            .build();
    private Json() {}
}
