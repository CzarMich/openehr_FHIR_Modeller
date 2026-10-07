package org.openehr.modelling.engine;

import com.nedap.archie.adlparser.antlr.Adl14Parser.C_complex_objectContext;
import com.nedap.archie.aom.CComplexObjectProxy;
import com.nedap.archie.aom.CObject;
import java.util.*;

/** Exact original paths calculated by Archie, paired with the original constraint syntax. */
final class LegacyReferences {
    record Target(CObject model, C_complex_objectContext syntax) {}
    private final Map<String, List<Target>> targets = new HashMap<>();
    private int count;

    LegacyReferences(LegacyArchetype source) {
        index(source.model().getDefinition(), source.syntax().definition_section().c_complex_object(), 0);
    }

    Target resolve(CComplexObjectProxy proxy) {
        List<Target> matches = targets.getOrDefault(proxy.getTargetPath(), List.of());
        if (matches.isEmpty()) throw new EngineException("ENGINE_INTERNAL_REFERENCE_MISSING");
        if (matches.size() != 1) throw new EngineException("ENGINE_INTERNAL_REFERENCE_AMBIGUOUS");
        return matches.getFirst();
    }

    private void index(CObject model, C_complex_objectContext syntax, int depth) {
        if (depth > 64 || ++count > 20000) throw new EngineException("ENGINE_NODE_LIMIT");
        targets.computeIfAbsent(model.getPath(), ignored -> new ArrayList<>()).add(new Target(model, syntax));
        if (syntax.c_attribute_def().size() != model.getAttributes().size())
            throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
        for (int i = 0; i < syntax.c_attribute_def().size(); ++i) {
            var attribute = syntax.c_attribute_def(i).c_attribute();
            if (attribute == null || attribute.c_objects() == null) continue;
            var children = attribute.c_objects().c_non_primitive_object_ordered();
            if (children.isEmpty()) continue;
            var models = model.getAttributes().get(i).getChildren();
            if (models.size() != children.size()) throw new EngineException("ENGINE_ADL14_CONSTRUCT_UNSUPPORTED");
            for (int j = 0; j < children.size(); ++j) {
                var complex = children.get(j).c_non_primitive_object().c_complex_object();
                if (complex != null) index(models.get(j), complex, depth + 1);
            }
        }
    }
}
