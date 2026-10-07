package org.openehr.modelling.engine;

import com.nedap.archie.aom.Archetype;
import com.nedap.archie.aom.ArchetypeHRID;
import com.nedap.archie.flattener.InMemoryFullArchetypeRepository;
import java.util.LinkedHashMap;
import java.util.Map;

/** All candidates are already selected and hash pinned. Never choose a newer supplied revision implicitly. */
final class PinnedRepository extends InMemoryFullArchetypeRepository {
    private final Map<String, Archetype> exact = new LinkedHashMap<>();
    private final Map<String, Archetype> major = new LinkedHashMap<>();

    @Override public void addArchetype(Archetype archetype) {
        ArchetypeHRID id = archetype.getArchetypeId();
        String alias = id.getIdUpToConcept() + ".v" + id.getMajorVersion();
        if (exact.containsKey(id.getFullId()) || major.containsKey(alias)) throw new EngineException("ENGINE_DEPENDENCY_AMBIGUOUS");
        exact.put(id.getFullId(), archetype);
        major.put(alias, archetype);
        super.addArchetype(archetype);
    }

    @Override public Archetype getArchetype(String identifier) {
        if (exact.containsKey(identifier)) return exact.get(identifier);
        return major.get(identifier);
    }
}
