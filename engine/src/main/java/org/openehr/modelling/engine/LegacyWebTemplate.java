package org.openehr.modelling.engine;

import java.util.Map;
import org.apache.xmlbeans.XmlOptions;
import org.openehr.schemas.v1.TemplateDocument;
import org.ehrbase.openehr.sdk.webtemplate.parser.OPTParser;

/** Independent consumer check: an XML-valid OPT must also be usable by a form schema parser. */
final class LegacyWebTemplate {
    static Map<String, String> generate(String content) {
        try {
            var document = (TemplateDocument) TemplateDocument.type.getTypeSystem().parse(SafeXml.parse(content),
                    TemplateDocument.type, new XmlOptions().setLoadExternalDTD(false).setLoadDTDGrammar(false));
            var model = OPTParser.parse(document.getTemplate());
            if (model.getTree() == null || !model.getLanguages().contains(model.getDefaultLanguage()))
                throw new EngineException("ENGINE_WEB_TEMPLATE_INVALID");
            String json = Json.MAPPER.writeValueAsString(model);
            return Map.of("format", "web_template_json", "content", json, "sha256", NativeEngine.sha256(json));
        } catch (Exception error) {
            throw new EngineException("ENGINE_WEB_TEMPLATE_GENERATION_FAILED");
        }
    }
}
