package org.openehr.modelling.engine;

import com.nedap.archie.adl14.ADL14ConversionConfiguration;
import com.nedap.archie.adl14.ADL14Parser;
import com.nedap.archie.adl14.aom14.ArchetypeOntology;
import com.nedap.archie.aom.Archetype;
import com.nedap.archie.rminfo.MetaModelProvider;

/** Original ADL 1.4 identifiers and ontology, never the converter's inferred binding URLs. */
record LegacyArchetype(Archetype model, ArchetypeOntology ontology, String identifier, String sourceSha256,
        com.nedap.archie.adlparser.antlr.Adl14Parser.ArchetypeContext syntax) {
    static LegacyArchetype parse(String content) {
        var configuration = new ADL14ConversionConfiguration();
        configuration.setAllowDuplicateFieldNames(false);
        var parser = new ADL14Parser((MetaModelProvider) null);
        parser.setLogEnabled(false);
        try {
            Archetype model = parser.parse(content.startsWith("\ufeff") ? content.substring(1) : content, configuration);
            if (parser.getErrors().hasErrors() || !"1.4".equals(model.getAdlVersion())) {
                throw new EngineException("ENGINE_ADL14_PARSE_ERROR");
            }
            var tree = parser.getTree().archetype();
            // The maintained parser creates generic binding URLs during its ADL2 preparation.
            // Keep the original typed ontology separately and remove those inferred URLs.
            var ontology = LegacyOdin.parse(
                    tree.terminology_section().odin_text().getText(), ArchetypeOntology.class);
            model.getTerminology().getTermBindings().clear();
            return new LegacyArchetype(model, ontology, tree.ARCHETYPE_HRID().getText(), NativeEngine.sha256(content), tree);
        } catch (EngineException e) { throw e; }
        catch (Exception e) { throw new EngineException("ENGINE_ADL14_PARSE_ERROR"); }
    }
}
