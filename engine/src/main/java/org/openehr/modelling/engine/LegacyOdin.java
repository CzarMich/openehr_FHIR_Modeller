package org.openehr.modelling.engine;

import com.nedap.archie.adl14.ADL14ConversionConfiguration;
import com.nedap.archie.adl14.treewalkers.Odin14ValueParser;
import com.nedap.archie.adlparser.antlr.AdlLexer;
import com.nedap.archie.adlparser.antlr.AdlParser;
import org.antlr.v4.runtime.*;

/** Archie exposes an ODIN converter; require complete input and no recovery before converting. */
final class LegacyOdin {
    static <T> T parse(String text, Class<T> type) {
        var lexer = new AdlLexer(CharStreams.fromString(text));
        var listener = new BaseErrorListener() {
            @Override public void syntaxError(Recognizer<?, ?> recognizer, Object offending, int line, int position,
                    String message, RecognitionException error) { throw new EngineException("ENGINE_ODIN_PARSE_ERROR"); }
        };
        lexer.removeErrorListeners(); lexer.addErrorListener(listener);
        var tokens = new CommonTokenStream(lexer);
        var parser = new AdlParser(tokens);
        parser.removeErrorListeners(); parser.addErrorListener(listener);
        var syntax = parser.odin_text();
        if (tokens.LA(1) != Token.EOF) throw new EngineException("ENGINE_ODIN_PARSE_ERROR");
        var config = new ADL14ConversionConfiguration(); config.setAllowDuplicateFieldNames(false);
        try { return new Odin14ValueParser(config).convert(syntax, type); }
        catch (Exception e) { throw new EngineException("ENGINE_ODIN_PARSE_ERROR"); }
    }
}
