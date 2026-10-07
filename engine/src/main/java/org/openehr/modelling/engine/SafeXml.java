package org.openehr.modelling.engine;

import java.io.StringReader;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.*;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.*;
import org.xml.sax.*;

/** In-memory XML only. No DTDs, entity expansion, XInclude, schema downloads or transforms. */
final class SafeXml {
    static final String OPT = "http://schemas.openehr.org/v1";
    static final String OET = "openEHR/v1/Template";
    static final String XSI = XMLConstants.W3C_XML_SCHEMA_INSTANCE_NS_URI;

    static Document parse(String content) {
        if (content.getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024) throw new EngineException("ENGINE_INPUT_LIMIT");
        try {
            var factory = factory();
            var builder = factory.newDocumentBuilder();
            builder.setEntityResolver((publicId, systemId) -> { throw new SAXException("External entities prohibited"); });
            builder.setErrorHandler(new ErrorHandler() {
                public void warning(SAXParseException e) throws SAXException { throw e; }
                public void error(SAXParseException e) throws SAXException { throw e; }
                public void fatalError(SAXParseException e) throws SAXException { throw e; }
            });
            // StringReader has already decoded UTF-8; consume only its optional BOM for parsing.
            // The caller hashes and stores the untouched source bytes independently.
            Document doc = builder.parse(new InputSource(new StringReader(content.startsWith("\ufeff") ? content.substring(1) : content)));
            bound(doc.getDocumentElement(), 0, new int[] {0});
            return doc;
        } catch (EngineException e) { throw e; }
        catch (Exception e) { throw new EngineException("ENGINE_XML_PARSE_ERROR"); }
    }

    static Document create() {
        try { return factory().newDocumentBuilder().newDocument(); }
        catch (Exception e) { throw new EngineException("ENGINE_XML_CONFIGURATION_ERROR"); }
    }

    private static DocumentBuilderFactory factory() throws Exception {
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        factory.setAttribute("http://www.oracle.com/xml/jaxp/properties/maxElementDepth", "128");
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        return factory;
    }

    private static void bound(Element node, int depth, int[] count) {
        if (depth > 128 || ++count[0] > 100000 || node.getAttributes().getLength() > 64) throw new EngineException("ENGINE_XML_STRUCTURE_LIMIT");
        for (Element child : children(node)) bound(child, depth + 1, count);
    }

    static String serialize(Document doc) {
        try {
            var factory = TransformerFactory.newInstance();
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
            var transformer = factory.newTransformer();
            transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
            transformer.setOutputProperty(OutputKeys.INDENT, "no");
            StringWriter writer = new StringWriter();
            transformer.transform(new DOMSource(doc), new StreamResult(writer));
            String output = writer.toString();
            if (output.getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024) throw new EngineException("ENGINE_OUTPUT_LIMIT");
            return output;
        } catch (EngineException e) { throw e; }
        catch (Exception e) { throw new EngineException("ENGINE_XML_SERIALIZATION_ERROR"); }
    }

    static List<Element> children(Element element) {
        List<Element> result = new ArrayList<>();
        for (Node node = element.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element child) result.add(child);
        }
        return result;
    }
    static List<Element> children(Element element, String local) {
        return children(element).stream().filter(child -> local.equals(child.getLocalName())).toList();
    }
    static Element one(Element element, String local, boolean required) {
        var values = children(element, local);
        if (values.size() > 1 || (required && values.isEmpty())) throw new EngineException("ENGINE_XML_ELEMENT_CARDINALITY");
        return values.isEmpty() ? null : values.getFirst();
    }
    static String text(Element element, String local) {
        return one(element, local, true).getTextContent();
    }
    static Element add(Element parent, String local) {
        Element child = parent.getOwnerDocument().createElementNS(OPT, local);
        parent.appendChild(child);
        return child;
    }
    static Element value(Element parent, String local, Object value) {
        Element child = add(parent, local);
        child.setTextContent(String.valueOf(value));
        return child;
    }
    static void type(Element element, String type) { element.setAttributeNS(XSI, "xsi:type", type); }
    static String type(Element element) {
        String name = element.getAttributeNS(XSI, "type");
        int colon = name.indexOf(':');
        String namespace = element.lookupNamespaceURI(colon < 0 ? null : name.substring(0, colon));
        if (!Objects.equals(namespace, element.getNamespaceURI())) throw new EngineException("ENGINE_XML_TYPE_NAMESPACE");
        return colon < 0 ? name : name.substring(colon + 1);
    }
    static void closed(Element element, String namespace, Set<String> children, Set<String> attributes) {
        if (!namespace.equals(element.getNamespaceURI())) throw new EngineException("ENGINE_XML_NAMESPACE");
        for (Node node = element.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node instanceof Element child && (!namespace.equals(child.getNamespaceURI()) || !children.contains(child.getLocalName())))
                throw new EngineException("ENGINE_OET_CONSTRUCT_UNSUPPORTED");
            if ((node.getNodeType() == Node.TEXT_NODE || node.getNodeType() == Node.CDATA_SECTION_NODE)
                    && !node.getTextContent().isBlank() && !children.isEmpty())
                throw new EngineException("ENGINE_OET_MIXED_CONTENT");
        }
        var attrs = element.getAttributes();
        for (int i = 0; i < attrs.getLength(); i++) {
            Node attr = attrs.item(i);
            if (XMLConstants.XMLNS_ATTRIBUTE_NS_URI.equals(attr.getNamespaceURI())) continue;
            if (XSI.equals(attr.getNamespaceURI()) && "type".equals(attr.getLocalName())
                    && Set.of("definition", "Content", "Item", "Items", "constraint").contains(element.getLocalName())) continue;
            if (attr.getNamespaceURI() != null || !attributes.contains(attr.getNodeName())) throw new EngineException("ENGINE_OET_CONSTRUCT_UNSUPPORTED");
        }
    }
}
