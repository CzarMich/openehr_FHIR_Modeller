package org.openehr.modelling.engine;

import com.nedap.archie.rm.composition.Composition;
import java.util.*;
import org.apache.xmlbeans.XmlOptions;
import org.ehrbase.openehr.sdk.serialisation.jsonencoding.CanonicalJson;
import com.nedap.archie.rminfo.ArchieRMInfoLookup;
import com.nedap.archie.rmobjectvalidator.RMObjectValidator;
import com.nedap.archie.rmobjectvalidator.RMObjectValidationMessageType;
import com.nedap.archie.rmobjectvalidator.ValidationConfiguration;
import org.ehrbase.openehr.sdk.validation.ConstraintViolation;
import org.ehrbase.openehr.sdk.validation.webtemplate.ValidationWalker;
import org.ehrbase.openehr.sdk.webtemplate.parser.OPTParser;
import org.openehr.schemas.v1.TemplateDocument;

/** Private runtime validation of canonical RM compositions against a hash-pinned OPT 1.4. */
final class CompositionValidation {
    static Map<String, Object> validate(Request request, Map<String, Object> result) {
        if (request.dependencies().size() != 1) throw new EngineException("ENGINE_EXACT_OPT_REQUIRED");
        var dependency = request.dependencies().getFirst();
        if (!NativeEngine.sha256(dependency.content()).equals(dependency.sha256())) throw new EngineException("ENGINE_DEPENDENCY_HASH_MISMATCH");
        var inspected = LegacyOptProfile.inspect(dependency.content());
        try {
            var document = (TemplateDocument) TemplateDocument.type.getTypeSystem().parse(SafeXml.parse(dependency.content()),
                    TemplateDocument.type, new XmlOptions().setLoadExternalDTD(false).setLoadDTDGrammar(false));
            if (!document.validate()) throw new EngineException("ENGINE_OPT_SCHEMA_INVALID");
            var template = OPTParser.parse(document.getTemplate());
            if (!template.getTemplateId().equals(dependency.identifier())) throw new EngineException("ENGINE_TEMPLATE_ID_MISMATCH");
            // Apply the existing bounded, duplicate-rejecting JSON parser before RM deserialization.
            var parser = Json.MAPPER.createParser(request.content());
            com.fasterxml.jackson.databind.JsonNode node = Json.MAPPER.readTree(parser);
            if (parser.nextToken() != null || node == null || !node.isObject() || !"COMPOSITION".equals(node.path("_type").asText())) throw new EngineException("ENGINE_COMPOSITION_REQUIRED");
            var composition = CanonicalJson.DEFAULT_INSTANCE.unmarshal(request.content(), Composition.class);
            var findings = new ArrayList<Map<String, String>>();
            if (composition.getArchetypeDetails() == null || composition.getArchetypeDetails().getTemplateId() == null
                    || !template.getTemplateId().equals(composition.getArchetypeDetails().getTemplateId().getValue())) {
                findings.add(Map.of("code", "COMPOSITION_TEMPLATE_ID_MISMATCH", "path", "/archetype_details/template_id"));
            } else {
                // Use public lower-level validators: SDK 2.35's fast wrapper passes
                // null metadata to a constructor rejected by Archie 3.20.
                var validator = new RMObjectValidator(ArchieRMInfoLookup.getInstance(), id -> null,
                        new ValidationConfiguration.Builder().validateInvariants(true).failOnUnknownTerminologyId(false).build());
                var messages = validator.validate(composition).stream()
                        .filter(message -> message.getType() != RMObjectValidationMessageType.ARCHETYPE_NOT_FOUND).toList();
                for (var message : messages) findings.add(Map.of("code", "COMPOSITION_RM_CONSTRAINT", "path", message.getPath(), "message", message.getMessage()));
                var violations = new ArrayList<ConstraintViolation>();
                if (messages.isEmpty()) new ValidationWalker(null, true).walk(composition, violations, template.getTree(), template.getTemplateId());
                for (var violation : violations) {
                    if (findings.size() >= 100) break;
                    findings.add(Map.of("code", "COMPOSITION_CONSTRAINT", "path", violation.getAqlPath(), "message", violation.getMessage()));
                }
            }
            boolean valid = findings.isEmpty();
            result.put("profile", "CANONICAL_RM_JSON_OPT_1_4");
            result.put("valid", valid); result.put("status", valid ? "PASS" : "FAIL");
            result.put("findings", findings);
            result.put("template_sha256", dependency.sha256());
            result.put("template_id", template.getTemplateId());
            result.put("scope", "Reference-model invariants and exact OPT 1.4 web-template constraints; external terminology and clinical approval are separate.");
            result.put("terminology", inspected.bindings().isEmpty() ? "LOCAL_RM_ONLY" : "EXTERNAL_NOT_EXECUTED");
            return result;
        } catch (EngineException error) { throw error; }
        catch (Exception error) { throw new EngineException("ENGINE_COMPOSITION_VALIDATION_FAILED"); }
    }
}
