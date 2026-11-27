using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using Modeller.Core;
using NHapi.Base.Model;
using NHapi.Base.Parser;

namespace Modeller.Operational;

public sealed record ParsedClinicalMessage(string Standard, string Version, string Type, string? ControlId,
    string SourceSha256, JsonObject Document, string ValidationStage, bool ProfileValidated = false, byte[]? CanonicalV2Xml = null);

/// <summary>Private message parsing. Never publish Document through a general MCP tool.</summary>
public static class ClinicalMessages
{
    public static readonly string[] ModelledV2Versions = ["2.1", "2.2", "2.3", "2.3.1", "2.4", "2.5", "2.5.1", "2.6", "2.7", "2.7.1", "2.8", "2.8.1"];
    public static List<ParsedClinicalMessage> Read(byte[] original, string format) {
        if (original.Length is < 1 or > Sources.Limit) throw new ProcessingException("MESSAGE_SIZE_LIMIT");
        return format switch {
            "hl7-v2" => ReadV2Inputs(original),
            "hl7-v2-xml" => [ReadV2Xml(original)],
            "hl7-v3" or "cda" => [ReadV3(original, format)],
            _ => throw new ProcessingException("MESSAGE_FORMAT_UNSUPPORTED")
        };
    }
    public static JsonObject Describe(byte[] original, string format) {
        var messages = Read(original, format);
        var fields = new SortedDictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var complete = true;
        void Walk(JsonNode? node, string path, int depth) {
            if (depth > 24 || fields.Count >= 256 || path.Length > 512) { complete = false; return; }
            if (path.Length > 0) {
                if (!fields.TryGetValue(path, out var types)) fields[path] = types = new(StringComparer.Ordinal);
                types.Add(node is null ? "null" : node.GetValueKind().ToString().ToLowerInvariant());
            }
            if (node is JsonObject obj) foreach (var pair in obj) Walk(pair.Value, path + "/" + pair.Key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal), depth + 1);
            else if (node is JsonArray array) foreach (var child in array) Walk(child, path + "/*", depth + 1);
        }
        foreach (var message in messages) Walk(message.Document, "", 0);
        return new JsonObject { ["format"] = format, ["count"] = messages.Count, ["versions"] = new JsonArray(messages.Select(message => message.Version).Distinct().Select(value => (JsonNode)JsonValue.Create(value)!).ToArray()),
            ["messageTypes"] = new JsonArray(messages.Select(message => message.Type).Distinct().Select(value => (JsonNode)JsonValue.Create(value)!).ToArray()),
            ["fields"] = new JsonArray(fields.Select(field => (JsonNode)new JsonObject { ["path"] = field.Key, ["types"] = new JsonArray(field.Value.Order(StringComparer.Ordinal).Select(value => (JsonNode)JsonValue.Create(value)!).ToArray()), ["meaning"] = "UNRESOLVED" }).ToArray()),
            ["complete"] = complete, ["sampleValues"] = "NOT_INCLUDED", ["profileValidation"] = "NOT_EXECUTED", ["clinicalApproval"] = false };
    }
    private static List<ParsedClinicalMessage> ReadV2Inputs(byte[] bytes) {
        var messages = ReadFrames(bytes).SelectMany(SplitMessages).Take(10001).ToArray();
        if (messages.Length > 10000) throw new ProcessingException("HL7_MESSAGE_COUNT_LIMIT");
        return messages.Select(ReadV2).ToList();
    }
    public static List<byte[]> ReadFrames(byte[] bytes) {
        if (bytes.Length is < 1 or > Sources.Limit) throw new ProcessingException("MESSAGE_SIZE_LIMIT");
        if (bytes.Length == 0 || bytes[0] != 0x0b) return [bytes];
        var frames = new List<byte[]>(); var cursor = 0;
        while (cursor < bytes.Length) {
            if (bytes[cursor++] != 0x0b) throw new ProcessingException("MLLP_FRAME_INVALID");
            var end = Array.IndexOf(bytes, (byte)0x1c, cursor);
            if (end <= cursor || end + 1 >= bytes.Length || bytes[end + 1] != 0x0d || frames.Count >= 10000) throw new ProcessingException("MLLP_FRAME_INVALID");
            frames.Add(bytes[cursor..end]); cursor = end + 2;
        }
        return frames;
    }
    private static List<byte[]> SplitMessages(byte[] bytes) {
        var starts = new List<int>();
        for (var i = 0; i + 3 < bytes.Length; i++) {
            if ((i == 0 || bytes[i - 1] is 0x0d or 0x0a) && bytes[i] == 'M' && bytes[i + 1] == 'S' && bytes[i + 2] == 'H') starts.Add(i);
        }
        if (starts.Count is < 1 or > 10000 || starts[0] != 0) throw new ProcessingException("HL7_MESSAGE_HEADER_REQUIRED");
        return starts.Select((start, index) => bytes[start..(index + 1 < starts.Count ? starts[index + 1] : bytes.Length)]).ToList();
    }
    private static string DecodeV2(byte[] bytes) {
        var first = Array.IndexOf(bytes, (byte)0x0d); if (first < 0) first = bytes.Length;
        if (first < 8 || bytes[3] < 33 || bytes[3] > 126) throw new ProcessingException("HL7_ENCODING_CHARACTERS_REQUIRED");
        var header = Encoding.Latin1.GetString(bytes, 0, first).Split((char)bytes[3]);
        var charset = header.Length > 17 ? header[17] : "";
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var name = charset switch {
            "" or "ASCII" => "us-ascii",
            "UNICODE UTF-8" or "UTF-8" => "utf-8",
            "8859/1" => "iso-8859-1", "8859/2" => "iso-8859-2", "8859/3" => "iso-8859-3", "8859/4" => "iso-8859-4",
            "8859/5" => "iso-8859-5", "8859/6" => "iso-8859-6", "8859/7" => "iso-8859-7", "8859/8" => "iso-8859-8", "8859/9" => "iso-8859-9",
            _ => throw new ProcessingException("HL7_CHARACTER_SET_UNSUPPORTED")
        };
        try { return Encoding.GetEncoding(name, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback).GetString(bytes); }
        catch (DecoderFallbackException) { throw new ProcessingException("HL7_CHARACTER_ENCODING_INVALID"); }
    }
    private static ParsedClinicalMessage ReadV2(byte[] bytes) {
        var content = DecodeV2(bytes).Replace("\r\n", "\r", StringComparison.Ordinal);
        if (content.Contains('\n') || content.Any(c => c is '\u000b' or '\u001c' or '\0')) throw new ProcessingException("HL7_SEGMENT_DELIMITER_INVALID");
        var lines = content.TrimEnd('\r').Split('\r');
        if (lines.Length is < 1 or > 10000 || lines.Any(string.IsNullOrEmpty)) throw new ProcessingException("HL7_SEGMENT_LIMIT_OR_INVALID");
        var separator = content[3]; var header = lines[0].Split(separator);
        if (header.Length < 12 || header[1].Length is < 4 or > 5 || (header[1] + separator).Distinct().Count() != header[1].Length + 1 || string.IsNullOrWhiteSpace(header[9])) throw new ProcessingException("HL7_HEADER_INVALID");
        var version = header[11].Split(header[1][0])[0];
        if (!ModelledV2Versions.Contains(version, StringComparer.Ordinal)) throw new ProcessingException("HL7_VERSION_PROFILE_REQUIRED");
        var wire = new JsonArray();
        foreach (var line in lines) {
            var fields = line.Split(separator); var name = fields[0];
            if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Z][A-Z0-9]{2}$") || fields.Length > 1025) throw new ProcessingException("HL7_SEGMENT_INVALID");
            wire.Add(new JsonObject { ["name"] = name, ["fields"] = new JsonArray(fields.Skip(1).Select(value => (JsonNode)JsonValue.Create(value)!).ToArray()) });
        }
        try {
            var model = new PipeParser().Parse(content); var visits = 0;
            var document = new JsonObject { ["wire"] = wire, ["model"] = Structure(model, 0, ref visits), ["fieldSeparator"] = separator.ToString(), ["encodingCharacters"] = header[1] };
            return new("HL7v2", version, header[8].Replace(header[1][0], '^'), header[9], Convert.ToHexStringLower(SHA256.HashData(bytes)), document, "MODEL_PARSED", CanonicalV2Xml: Encoding.UTF8.GetBytes(new DefaultXMLParser().Encode(model)));
        } catch (NHapi.Base.HL7Exception) { throw new ProcessingException("HL7_V2_MODEL_VALIDATION_FAILED"); }
    }
    private static JsonObject Structure(IStructure structure, int depth, ref int visits) {
        if (++visits > 100000 || depth > 16) throw new ProcessingException("HL7_STRUCTURE_LIMIT");
        var result = new JsonObject();
        if (structure is ISegment segment) {
            for (var field = 1; field <= segment.NumFields(); field++) {
                var repetitions = segment.GetField(field); if (repetitions.Length == 0) continue;
                var values = new JsonArray(); foreach (var repetition in repetitions) values.Add(Value(repetition, depth + 1, ref visits));
                result[field.ToString(System.Globalization.CultureInfo.InvariantCulture)] = values;
            }
        } else if (structure is IGroup group) {
            foreach (var name in group.Names) {
                var repetitions = group.GetAll(name); if (repetitions.Length == 0) continue;
                var values = new JsonArray(); foreach (var repetition in repetitions) values.Add(Structure(repetition, depth + 1, ref visits)); result[name] = values;
            }
        } else throw new ProcessingException("HL7_STRUCTURE_UNSUPPORTED");
        return result;
    }
    private static JsonNode? Value(IType value, int depth, ref int visits) {
        if (++visits > 100000 || depth > 16) throw new ProcessingException("HL7_STRUCTURE_LIMIT");
        if (value is Varies varies) return Value(varies.Data, depth + 1, ref visits);
        var result = new JsonObject { ["datatype"] = value.TypeName };
        if (value is IPrimitive primitive) result["value"] = primitive.Value;
        else if (value is IComposite composite) {
            var components = new JsonArray(); foreach (var component in composite.Components) components.Add(Value(component, depth + 1, ref visits)); result["components"] = components;
        } else throw new ProcessingException("HL7_DATATYPE_UNSUPPORTED");
        if (value.ExtraComponents.NumComponents() > 0) {
            var extra = new JsonArray(); for (var i = 0; i < value.ExtraComponents.NumComponents(); i++) extra.Add(Value(value.ExtraComponents.GetComponent(i), depth + 1, ref visits)); result["extraComponents"] = extra;
        }
        return result;
    }
    internal static XDocument Xml(byte[] bytes) {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = Sources.Limit * 2L, MaxCharactersFromEntities = 0, IgnoreWhitespace = false };
        try {
            using (var input = new MemoryStream(bytes)) using (var preflight = XmlReader.Create(input, settings)) {
                var count = 0;
                while (preflight.Read()) if (++count > 100000 || preflight.Depth > 64) throw new ProcessingException("HL7_XML_STRUCTURE_LIMIT");
            }
            using var bounded = new MemoryStream(bytes); using var reader = XmlReader.Create(bounded, settings);
            return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        } catch (XmlException) { throw new ProcessingException("HL7_XML_INVALID"); }
    }
    private static ParsedClinicalMessage ReadV2Xml(byte[] bytes) {
        var xml = Xml(bytes);
        if (xml.Root?.Name.NamespaceName != "urn:hl7-org:v2xml") throw new ProcessingException("HL7_V2_XML_NAMESPACE_REQUIRED");
        try {
            var model = new DefaultXMLParser().Parse(xml.ToString(SaveOptions.DisableFormatting)); var visits = 0;
            if (!ModelledV2Versions.Contains(model.Version, StringComparer.Ordinal)) throw new ProcessingException("HL7_VERSION_PROFILE_REQUIRED");
            var msh = model.GetAll("MSH").SingleOrDefault() as ISegment ?? throw new ProcessingException("HL7_HEADER_INVALID");
            var controlId = (msh.GetField(10, 0) as IPrimitive)?.Value;
            if (string.IsNullOrWhiteSpace(controlId)) throw new ProcessingException("HL7_HEADER_INVALID");
            var header = new PipeParser().Encode(model).Split('\r')[0].Split('|');
            return new("HL7v2", model.Version, header[8], controlId, Convert.ToHexStringLower(SHA256.HashData(bytes)), new JsonObject { ["model"] = Structure(model, 0, ref visits) }, "MODEL_PARSED", CanonicalV2Xml: Encoding.UTF8.GetBytes(new DefaultXMLParser().Encode(model)));
        } catch (NHapi.Base.HL7Exception) { throw new ProcessingException("HL7_V2_MODEL_VALIDATION_FAILED"); }
    }
    private static ParsedClinicalMessage ReadV3(byte[] bytes, string format) {
        var xml = Xml(bytes); var root = xml.Root ?? throw new ProcessingException("HL7_XML_ROOT_REQUIRED");
        if (root.Name.NamespaceName != "urn:hl7-org:v3" || (format == "cda") != (root.Name.LocalName == "ClinicalDocument")) throw new ProcessingException("HL7_V3_DOCUMENT_TYPE_MISMATCH");
        var nodes = new JsonArray();
        void Add(XNode node, int? parent) {
            var index = nodes.Count;
            if (node is XElement element) {
                var attributes = new JsonObject(); foreach (var attribute in element.Attributes()) attributes[attribute.Name.ToString()] = attribute.Value;
                nodes.Add(new JsonObject { ["kind"] = "element", ["parent"] = parent, ["name"] = element.Name.ToString(), ["attributes"] = attributes });
                foreach (var child in element.Nodes()) Add(child, index);
            } else if (node is XText text) nodes.Add(new JsonObject { ["kind"] = "text", ["parent"] = parent, ["value"] = text.Value });
            else if (node is XComment comment) nodes.Add(new JsonObject { ["kind"] = "comment", ["parent"] = parent, ["value"] = comment.Value });
            else if (node is XProcessingInstruction instruction) nodes.Add(new JsonObject { ["kind"] = "processing-instruction", ["parent"] = parent, ["name"] = instruction.Target, ["value"] = instruction.Data });
            else throw new ProcessingException("HL7_XML_NODE_UNSUPPORTED");
        }
        Add(root, null);
        return new(format == "cda" ? "CDA" : "HL7v3", "PROFILE_REQUIRED", root.Name.LocalName, null, Convert.ToHexStringLower(SHA256.HashData(bytes)), new JsonObject { ["nodes"] = nodes }, "XML_WELL_FORMED_ONLY");
    }
}
