package org.openehr.modelling.engine;

final class EngineException extends RuntimeException {
    final String code;
    EngineException(String code) { super(code); this.code = code; }
}
