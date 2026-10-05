package org.openehr.modelling.engine;

import com.nedap.archie.aom.*;
import com.nedap.archie.aom.terminology.ArchetypeTerminology;
import com.nedap.archie.archetypevalidator.*;
import com.nedap.archie.archetypevalidator.validations.*;
import com.nedap.archie.adlparser.modelconstraints.ReflectionConstraintImposer;
import org.openehr.referencemodels.BuiltinReferenceModels;
import java.util.*;

/** Adapt native flat-form validators to the terminology scope of each embedded archetype. */
final class OptValidation {
    private record Scope(OperationalTemplate view, String path) {}

    static ValidationResult validate(OperationalTemplate input) {
        var pending = new ArrayDeque<CObject>();
        pending.add(input.getDefinition());
        int count = 0;
        while (!pending.isEmpty()) {
            CObject node = pending.removeFirst();
            if (++count > 20000) throw new EngineException("ENGINE_NODE_LIMIT");
            if (node instanceof ArchetypeSlot) throw new EngineException("ENGINE_OPT_UNRESOLVED_SLOT");
            if (node instanceof CComplexObjectProxy) throw new EngineException("ENGINE_OPT_UNRESOLVED_REFERENCE");
            for (var attribute : node.getAttributes()) pending.addAll(attribute.getChildren());
        }
        var model = (OperationalTemplate) input.clone();
        model.setDifferential(false);
        if (model.getComponentTerminologies() == null) model.setComponentTerminologies(new HashMap<>());
        var metaModel = BuiltinReferenceModels.getMetaModelProvider().getMetaModel(model);
        new ReflectionConstraintImposer(metaModel).setSingleOrMultiple(model.getDefinition());
        var result = new ValidationResult(model);
        var scopes = new ArrayList<Scope>();
        var rootView = (OperationalTemplate) model.clone();
        scopes.add(new Scope(rootView, ""));
        split(rootView.getDefinition(), model, scopes, result, "");
        if (!result.passes()) return result;
        var repository = new PinnedRepository();
        for (var scope : scopes) {
            if (repository.getArchetype(scope.view().getArchetypeId().getFullId()) == null) repository.addArchetype(scope.view());
        }
        repository.setOperationalTemplate(model);
        var settings = new ArchetypeValidationSettings();
        // Metadata and global path annotations belong to the complete operational template.
        for (ArchetypeValidation check : List.of(new AuthoredArchetypeMetadataChecks(), new AnnotationsValidation(), new RmOverlayValidation())) {
            result.getErrors().addAll(check.validate(metaModel, model, null, repository, settings));
            if (!result.passes()) return result;
        }
        for (var scope : scopes) {
            // Archie adds human-readable term aliases keyed by resolved archetype HRIDs.
            // They are OPT metadata, not local id/at/ac codes checked by source validators.
            for (var definitions : scope.view().getTerminology().getTermDefinitions().values()) {
                for (String identifier : model.getComponentTerminologies().keySet()) definitions.remove(identifier);
            }
            List<ArchetypeValidation> checks = List.of(new AttributeUniquenessValidation(), new NodeIdValidation(),
                    new BasicDefinitionObjectValidation(), new AttributeTupleValidation(), new BasicChecks(),
                    new MultiplicitiesValidation(), new DefinitionStructureValidation(), new BasicTerminologyValidation(),
                    new VariousStructureValidation(), new CodeValidation(), new ValidateAgainstReferenceModel(), new FlatFormValidation());
            for (var check : checks) {
                // In a flat model, inherited terminology is already included in this same scope.
                Archetype terminologyContext = check instanceof CodeValidation ? scope.view() : null;
                for (var message : check.validate(metaModel, scope.view(), terminologyContext, repository, settings)) {
                    String path = message.getPathInArchetype();
                    if (path != null && !scope.path().isEmpty()) message.setPathInArchetype(scope.path() + (path.equals("/") ? "" : path));
                    result.getErrors().add(message);
                }
                if (!result.passes()) return result;
            }
        }
        result.setFlattened(model);
        return result;
    }

    private static void split(CObject node, OperationalTemplate model, List<Scope> scopes, ValidationResult result, String prefix) {
        for (CAttribute attribute : node.getAttributes()) {
            for (CObject child : attribute.getChildren()) {
                if (child instanceof CArchetypeRoot embedded && embedded.getArchetypeRef() != null) {
                    String location = prefix + embedded.getPath();
                    ArchetypeTerminology terminology = model.getComponentTerminologies().get(embedded.getArchetypeRef());
                    if (terminology == null) {
                        result.getErrors().add(new ValidationMessage(ErrorType.STCNT, location, "Embedded archetype terminology is missing."));
                        continue;
                    }
                    if (scopes.size() >= 1024) throw new EngineException("ENGINE_COMPONENT_LIMIT");
                    var view = (OperationalTemplate) model.clone();
                    var copy = (CArchetypeRoot) embedded.clone();
                    var definition = new CComplexObject();
                    definition.setRmTypeName(copy.getRmTypeName());
                    // ADL serializes term definitions, not derived conceptCode/originalLanguage fields.
                    // Recover the deepest existing root code for this validation-only scope.
                    String rootCode = terminology.idCodes().stream().filter(code -> code.matches("id1(\\.1)*"))
                            .max(Comparator.comparingInt(String::length)).orElse(null);
                    String language = model.getOriginalLanguage().getCodeString();
                    if (rootCode == null || terminology.getTermDefinition(language, rootCode) == null) {
                        result.getErrors().add(new ValidationMessage(ErrorType.STCNT, location,
                                "Embedded archetype root terminology is unavailable in the template language."));
                        continue;
                    }
                    definition.setNodeId(rootCode);
                    definition.setOccurrences(copy.getOccurrences());
                    definition.setAttributes(copy.getAttributes());
                    definition.setAttributeTuples(copy.getAttributeTuples());
                    view.setDefinition(definition);
                    view.setArchetypeId(new ArchetypeHRID(embedded.getArchetypeRef()));
                    view.setParentArchetypeId(null);
                    view.setTerminology((ArchetypeTerminology) terminology.clone());
                    com.nedap.archie.aom.utils.ArchetypeParsePostProcessor.fixArchetype(view);
                    scopes.add(new Scope(view, location));
                    split(definition, model, scopes, result, location);
                    // Keep the reference and its parent-local id/occurrences, while validating its contents in the new scope.
                    embedded.setAttributes(List.of());
                    embedded.setAttributeTuples(List.of());
                } else split(child, model, scopes, result, prefix);
            }
        }
    }
}
