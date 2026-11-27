using System.Collections;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;
using System.Xml.XPath;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record ProjectedSourceRecord(JsonObject Record, ClinicalIdentity? PatientIdentity, string? PatientAnchor,
    Dictionary<string, ClinicalIdentity?> Relations, string SourceSha256, string SourceContractSha256,
    string? MessageId, bool AuthoritativePatientEvent, SourceValidationReport? Validation, JsonArray? InputResources = null);

/// <summary>Projects only declared fields. These records remain in the private operational boundary.</summary>
public sealed class SourceProjection
{
    private readonly SourceContract contract;
    private readonly XmlSourceValidation? xmlValidation;
    private readonly XmlNamespaceManager namespaces = new(new NameTable());
    public SourceProjection(SourceContract source) {
        // Isolate the compiled projection from mutable adapter input.
        contract = new SourceContract(source.Content);
        var definition = contract.Definition;
        if (definition.XmlValidation is not null) xmlValidation = new(XmlProfile());
        foreach (var item in definition.Namespaces ?? []) namespaces.AddNamespace(XmlConvert.VerifyNCName(item.Key), item.Value);
        if (definition.Fields.Select(field => field.Kind).Distinct(StringComparer.Ordinal).Count() != 1) throw new ProcessingException("SOURCE_SELECTOR_KINDS_MUST_MATCH");
    }
    private XmlSourceProfile XmlProfile() => JsonSerializer.Deserialize<XmlSourceProfile>(contract.Definition.XmlValidation!, Data.Json) ?? throw new ProcessingException("SOURCE_XML_PROFILE_REQUIRED");
    private static (bool Present, JsonNode? Value) Pointer(JsonNode? root, string path) {
        if (path == "") return (true, root);
        if (!path.StartsWith('/')) throw new ProcessingException("SOURCE_POINTER_INVALID");
        var current = root;
        foreach (var escaped in path[1..].Split('/')) {
            for (var i = 0; i < escaped.Length; i++) if (escaped[i] == '~' && (i + 1 >= escaped.Length || escaped[++i] is not ('0' or '1'))) throw new ProcessingException("SOURCE_POINTER_INVALID");
            var part = escaped.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal);
            if (current is JsonObject obj) { if (!obj.TryGetPropertyValue(part, out current)) return (false, null); }
            else if (current is JsonArray array && int.TryParse(part, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var index) && index >= 0 && index < array.Count) current = array[index];
            else return (false, null);
        }
        return (true, current);
    }
    private static string? Text(JsonObject record, string field) {
        if (!record.TryGetPropertyValue(field, out var value) || value is null) return null;
        if (value.GetValueKind() != JsonValueKind.String) throw new ProcessingException("SOURCE_IDENTITY_STRING_REQUIRED");
        return string.IsNullOrWhiteSpace(value.GetValue<string>()) ? null : value.GetValue<string>();
    }
    private static ClinicalIdentity? Identity(JsonObject record, string field, string? system, string? systemField) {
        var value = Text(record, field); if (value is null) return null;
        var authority = systemField is null ? system : Text(record, systemField);
        if (authority is null) return null;
        var identity = new ClinicalIdentity(authority, value); IdentityRegistry.Identity(identity); return identity;
    }
    private ProjectedSourceRecord Envelope(JsonObject record, string sourceSha, string? messageId, SourceValidationReport? report) {
        var definition = contract.Definition;
        var patient = Identity(record, definition.Patient.IdentifierField, definition.Patient.System, definition.Patient.SystemField);
        var relations = definition.Relations.ToDictionary(relation => relation.Role, relation => Identity(record, relation.IdentifierField, relation.System, relation.SystemField), StringComparer.Ordinal);
        return new(record, patient, Text(record, definition.Patient.AnchorField), relations, sourceSha, contract.Sha256, messageId, definition.Patient.AuthoritativeRegistration, report);
    }
    private JsonNode? FieldValue(JsonNode? value) {
        if (contract.Definition.Format.StartsWith("hl7-v2", StringComparison.Ordinal) && value?.GetValueKind() == JsonValueKind.String && value.GetValue<string>() == "\"\"") return null;
        return value?.DeepClone();
    }
    private JsonObject JsonRecord(JsonNode? input) {
        var record = new JsonObject();
        foreach (var field in contract.Definition.Fields) {
            var found = Pointer(input, field.Path);
            if (!found.Present) { if (field.Required) throw new ProcessingException("SOURCE_REQUIRED_FIELD_MISSING"); continue; }
            if (!field.Multiple && found.Value is JsonArray) throw new ProcessingException("SOURCE_FIELD_CARDINALITY_AMBIGUOUS");
            record[field.Name] = FieldValue(found.Value);
        }
        return record;
    }
    private List<ProjectedSourceRecord> XmlRecords(byte[] original, string sourceSha, string? messageId) {
        var document = ClinicalMessages.Xml(original);
        var report = xmlValidation?.Validate(original);
        if (report is not null && !report.Valid) throw new ProcessingException("SOURCE_PROFILE_VALIDATION_FAILED");
        IEnumerable<XElement> roots;
        try { roots = contract.Definition.RecordPath is { Length: > 0 } path ? document.XPathSelectElements(path, namespaces) : [document.Root!]; }
        catch (XPathException) { throw new ProcessingException("SOURCE_RECORD_SELECTOR_INVALID"); }
        var selected = roots.Take(10001).ToArray(); if (selected.Length is < 1 or > 10000) throw new ProcessingException("SOURCE_RECORD_LIMIT");
        var records = new List<ProjectedSourceRecord>();
        foreach (var root in selected) {
            var record = new JsonObject();
            foreach (var field in contract.Definition.Fields) {
                object result;
                try { result = root.XPathEvaluate(field.Path, namespaces); }
                catch (XPathException) { throw new ProcessingException("SOURCE_FIELD_SELECTOR_INVALID"); }
                if (result is not IEnumerable values || result is string) throw new ProcessingException("SOURCE_FIELD_NODESET_REQUIRED");
                var nodes = values.Cast<object>().Take(10001).ToArray();
                if (nodes.Length > 10000 || nodes.Length > 1 && !field.Multiple) throw new ProcessingException("SOURCE_FIELD_CARDINALITY_AMBIGUOUS");
                if (nodes.Length == 0) { if (field.Required) throw new ProcessingException("SOURCE_REQUIRED_FIELD_MISSING"); continue; }
                string Value(object node) => node switch { XElement element when !element.HasElements => element.Value, XElement => throw new ProcessingException("SOURCE_MIXED_CONTENT_SCALAR_REJECTED"), XAttribute attribute => attribute.Value, XText text => text.Value, _ => throw new ProcessingException("SOURCE_FIELD_NODE_UNSUPPORTED") };
                record[field.Name] = field.Multiple ? new JsonArray(nodes.Select(node => FieldValue(JsonValue.Create(Value(node)))).ToArray()) : FieldValue(JsonValue.Create(Value(nodes[0])));
            }
            records.Add(Envelope(record, sourceSha, messageId, report));
        }
        return records;
    }
    public List<ProjectedSourceRecord> Read(byte[] original) {
        if (original.Length is < 1 or > Sources.Limit) throw new ProcessingException("SOURCE_LIMIT");
        var sourceSha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(original));
        var definition = contract.Definition;
        if (definition.Format is "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda") {
            var messages = ClinicalMessages.Read(original, definition.Format);
            var result = new List<ProjectedSourceRecord>();
            foreach (var message in messages) {
                var messageStart = result.Count;
                if (definition.Format.StartsWith("hl7-v2", StringComparison.Ordinal) && !definition.Versions.Contains(message.Version, StringComparer.Ordinal) || definition.MessageTypes.Length > 0 && !definition.MessageTypes.Contains(message.Type, StringComparer.Ordinal)) throw new ProcessingException("SOURCE_MESSAGE_PROFILE_MISMATCH");
                if (definition.Fields[0].Kind == "xpath") {
                    var xml = message.CanonicalV2Xml ?? original;
                    result.AddRange(XmlRecords(xml, sourceSha, message.ControlId));
                } else {
                    var roots = definition.RecordPath is { Length: > 0 } path ? Pointer(message.Document, path) : (true, (JsonNode?)message.Document);
                    if (!roots.Item1 || roots.Item2 is null) throw new ProcessingException("SOURCE_RECORD_SELECTOR_EMPTY");
                    var records = roots.Item2 is JsonArray array ? array.ToArray() : [roots.Item2];
                    if (records.Length is < 1 or > 10000) throw new ProcessingException("SOURCE_RECORD_LIMIT");
                    SourceValidationReport? report = null;
                    if (xmlValidation is not null) {
                        report = xmlValidation.Validate(message.CanonicalV2Xml ?? original);
                        if (!report.Valid) throw new ProcessingException("SOURCE_PROFILE_VALIDATION_FAILED");
                    }
                    foreach (var record in records) result.Add(Envelope(JsonRecord(record), sourceSha, message.ControlId, report));
                }
                for (var ordinal = messageStart; ordinal < result.Count; ordinal++) result[ordinal] = result[ordinal] with { MessageId = message.ControlId is null ? null : message.ControlId + ":record:" + (ordinal - messageStart).ToString(System.Globalization.CultureInfo.InvariantCulture) };
                if (result.Count > 10000) throw new ProcessingException("SOURCE_RECORD_LIMIT");
            }
            return result;
        }
        if (definition.Fields[0].Kind == "xpath") return XmlRecords(original, sourceSha, null);
        var sourceRecords = Sources.Parse(original, definition.Format);
        return sourceRecords.Select(record => Envelope(JsonRecord(record), sourceSha, null, null) with { InputResources = definition.Format is "fhir-json" or "openehr-json" ? new JsonArray((definition.Format == "openehr-json" && record["composition"] is JsonObject composition ? composition : record).DeepClone()) : null }).ToList();
    }
}
