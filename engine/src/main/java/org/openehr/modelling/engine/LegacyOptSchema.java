package org.openehr.modelling.engine;

import org.apache.xmlbeans.XmlOptions;
import org.openehr.schemas.v1.TemplateDocument;

final class LegacyOptSchema {
    static void validate(String content) {
        var document = SafeXml.parse(content);
        if (!SafeXml.OPT.equals(document.getDocumentElement().getNamespaceURI()) || !"template".equals(document.getDocumentElement().getLocalName()))
            throw new EngineException("ENGINE_DOCUMENT_KIND_MISMATCH");
        try {
            var parsed = (TemplateDocument) TemplateDocument.type.getTypeSystem().parse(document, TemplateDocument.type,
                    new XmlOptions().setLoadExternalDTD(false).setLoadDTDGrammar(false));
            if (!parsed.validate()) throw new EngineException("ENGINE_OPT14_SCHEMA_INVALID");
        } catch (EngineException e) { throw e; }
        catch (Exception e) { throw new EngineException("ENGINE_OPT14_SCHEMA_INVALID"); }
    }
}
