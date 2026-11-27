using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

public sealed record SourceField(string Name, string Kind, string Path, bool Required = false, bool Multiple = false, string Classification = "clinical");
public sealed record SourcePatientBinding(string IdentifierField, string AnchorField, string? System = null, string? SystemField = null, bool AuthoritativeRegistration = false);
public sealed record SourceRelation(string Role, string IdentifierField, string? System = null, string? SystemField = null);
public sealed record SourceContractDefinition(int SchemaVersion, string Format, string[] Versions, string[] MessageTypes,
    SourceField[] Fields, SourcePatientBinding Patient, SourceRelation[] Relations, string? RecordPath = null,
    JsonObject? XmlValidation = null, Dictionary<string, string>? Namespaces = null);

/// <summary>Versioned source definitions only. No patient content, credentials or source database commands.</summary>
public sealed class SourceContract
{
    public SourceContractDefinition Definition { get; }
    public string Content { get; }
    public string Sha256 { get; }
    public SourceContract(string content) {
        if (System.Text.Encoding.UTF8.GetByteCount(content) > 4194304 || Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(content)) is not JsonObject node) throw new ProcessingException("SOURCE_CONTRACT_INVALID");
        Content = content;
        Definition = JsonSerializer.Deserialize<SourceContractDefinition>(node, Data.Json) ?? throw new ProcessingException("SOURCE_CONTRACT_REQUIRED");
        var definition = Definition;
        if (definition.SchemaVersion != 1 || definition.Format is not ("csv" or "json" or "xml" or "xlsx" or "fhir-json" or "openehr-json" or "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda")
            || definition.Fields is null || definition.Fields.Length is < 1 or > 256 || definition.Patient is null || definition.Relations is null || definition.Relations.Length > 32 || definition.Versions is null || definition.Versions.Length > 32 || definition.MessageTypes is null || definition.MessageTypes.Length > 64) throw new ProcessingException("SOURCE_CONTRACT_INVALID");
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in definition.Fields) {
            if (field is null || field.Name is null || !Regex.IsMatch(field.Name, "^[A-Za-z][A-Za-z0-9_]{0,63}$") || !names.Add(field.Name) || field.Kind is not ("json-pointer" or "xpath") || field.Path is null || field.Path.Length > 2048 || field.Path.Any(char.IsControl)
                || field.Classification is not ("clinical" or "patient-identifier" or "direct-identifier" or "narrative" or "record-identifier")) throw new ProcessingException("SOURCE_FIELD_DEFINITION_INVALID");
            if (field.Kind == "json-pointer" && field.Path.Length > 0 && !field.Path.StartsWith('/')) throw new ProcessingException("SOURCE_FIELD_POINTER_REQUIRED");
            if (field.Kind == "xpath" && definition.Format is not ("xml" or "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda")) throw new ProcessingException("SOURCE_FIELD_FORMAT_MISMATCH");
        }
        if (!names.Contains(definition.Patient.IdentifierField) || !names.Contains(definition.Patient.AnchorField)) throw new ProcessingException("SOURCE_PATIENT_BINDING_REQUIRED");
        var patientField = definition.Fields.Single(field => field.Name == definition.Patient.IdentifierField);
        if (patientField.Classification != "patient-identifier" || patientField.Multiple) throw new ProcessingException("SOURCE_PATIENT_IDENTIFIER_CLASSIFICATION_REQUIRED");
        Binding(definition.Patient.System, definition.Patient.SystemField, names);
        var relationNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var relation in definition.Relations) {
            if (relation is null || relation.Role is null || !Regex.IsMatch(relation.Role, "^[A-Za-z][A-Za-z0-9_]{0,63}$") || relation.Role == "patient" || !relationNames.Add(relation.Role) || !names.Contains(relation.IdentifierField)) throw new ProcessingException("SOURCE_RELATION_INVALID");
            Binding(relation.System, relation.SystemField, names);
        }
        if (definition.Versions.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 100 || value.Any(char.IsControl)) || definition.MessageTypes.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 100 || value.Any(char.IsControl))) throw new ProcessingException("SOURCE_MESSAGE_SCOPE_REQUIRED");
        if (definition.Format.StartsWith("hl7-v2", StringComparison.Ordinal) && (definition.Versions.Length == 0 || definition.MessageTypes.Length == 0)) throw new ProcessingException("SOURCE_MESSAGE_SCOPE_REQUIRED");
        if (definition.Format is ("hl7-v3" or "cda" or "hl7-v2-xml") && definition.XmlValidation is null) throw new ProcessingException("SOURCE_XML_PROFILE_REQUIRED");
        if (definition.XmlValidation is not null && definition.Format is not ("xml" or "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda")) throw new ProcessingException("SOURCE_XML_PROFILE_FORMAT_MISMATCH");
        if (definition.RecordPath?.Length > 2048 || definition.RecordPath?.Any(char.IsControl) == true || definition.Namespaces?.Count > 32) throw new ProcessingException("SOURCE_RECORD_SCOPE_INVALID");
        Sha256 = Data.Hash(Data.Canonical(node));
    }
    private static void Binding(string? system, string? field, HashSet<string> fields) {
        if ((system is null) == (field is null) || field is not null && !fields.Contains(field)) throw new ProcessingException("SOURCE_ASSIGNING_AUTHORITY_REQUIRED");
        if (system is not null && (!Uri.TryCreate(system, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "urn") || uri.UserInfo.Length != 0 || system.Any(char.IsWhiteSpace))) throw new ProcessingException("SOURCE_ASSIGNING_AUTHORITY_REQUIRED");
    }
}
