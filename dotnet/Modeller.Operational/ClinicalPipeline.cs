using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Modeller.Core;

namespace Modeller.Operational;

/// <summary>Private clinical admission and deterministic identity/reference enforcement. No model-provider calls.</summary>
public sealed class ClinicalPipeline
{
    private readonly IdentityRegistry registry;
    private readonly DependencyQueue queue;
    private readonly OperationalScope scope;
    private readonly ClinicalPolicy policy;
    private readonly SourceContract contract;
    public ClinicalPipeline(IdentityRegistry registry, OperationalScope scope, ClinicalPolicy policy, SourceContract contract) {
        this.registry = registry; queue = new(registry); this.scope = scope; this.policy = policy; this.contract = new(contract.Content);
        if (policy.IdentityDomain != scope.SourceSystem || policy.DestinationId != scope.DestinationId) throw new ProcessingException("CLINICAL_POLICY_SCOPE_MISMATCH");
        var actual = registry.Policy(scope);
        if (actual.Revision != policy.PrivacyPolicyRevision || actual.PseudonymisePatientIdentifiers != policy.PseudonymisePatientIdentifiers || actual.PseudonymSystem != policy.PseudonymSystem) throw new ProcessingException("PRIVACY_POLICY_REVIEW_REQUIRED");
        foreach (var reference in policy.References) if (reference.Role != "patient" && !contract.Definition.Relations.Any(relation => relation.Role == reference.Role)) throw new ProcessingException("SOURCE_RELATION_POLICY_REQUIRED");
        foreach (var publication in policy.Publications) if (publication.Role != "patient" && !contract.Definition.Relations.Any(relation => relation.Role == publication.Role)) throw new ProcessingException("SOURCE_PUBLICATION_RELATION_REQUIRED");
    }
    public static IdentityRegistry Open(Configuration config) {
        if (config.OperationalRoot is null || config.OperationalKeyFile is null || !Path.IsPathFullyQualified(config.OperationalKeyFile)) throw new ProcessingException("OPERATIONAL_STORE_CONFIGURATION_REQUIRED");
        var file = new FileInfo(config.OperationalKeyFile);
        if (!file.Exists || file.LinkTarget is not null || file.Length != 32) throw new ProcessingException("OPERATIONAL_KEY_REQUIRED");
        var key = File.ReadAllBytes(file.FullName);
        try { return new(config.OperationalRoot, key); }
        finally { CryptographicOperations.ZeroMemory(key); }
    }
    private ClinicalIdentity? Relation(ProjectedSourceRecord record, string role) => role == "patient" ? record.PatientIdentity : record.Relations.GetValueOrDefault(role);
    public static string SourceFingerprint(SourceConnection source) {
        static string Part(string value) => System.Text.Encoding.UTF8.GetByteCount(value).ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + value;
        static string Array(string[] values) => values.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + string.Concat(values.Select(Part));
        return Data.Hash("modeller-source-connection/v1\n" + string.Concat(new[] { source.Id, source.Root, source.Format, source.IdentityDomain ?? "", source.TrustPatientRegistration ? "true" : "false", Array(source.Projects), Array(source.Owners) }.Select(Part)));
    }
    public PendingMessage Admit(SourceConnection source, string intakeId, string subject, string mappingHash, ProjectedSourceRecord record,
        string recordId, byte[] original, DateTimeOffset now) {
        if (source.IdentityDomain != policy.IdentityDomain || source.Format != contract.Definition.Format || record.SourceContractSha256 != contract.Sha256) throw new ProcessingException("SOURCE_IDENTITY_DOMAIN_MISMATCH");
        var dependencies = policy.References.Where(reference => reference.RequireDestination || reference.Mode != "logical").Select(reference => {
            var identity = Relation(record, reference.Role);
            return identity is null ? null : new EntityKey(reference.TargetType, identity.System, identity.Value);
        }).OfType<EntityKey>().Distinct().ToArray();
        // An absent required relationship is held separately; inventing a key would hide missing data.
        var missing = policy.References.Any(reference => reference.Role != "patient" && Relation(record, reference.Role) is null);
        var envelope = new JsonObject { ["record"] = record.Record.DeepClone(), ["relations"] = System.Text.Json.JsonSerializer.SerializeToNode(record.Relations, Data.Json), ["missingRelationship"] = missing, ["missingRelationships"] = new JsonArray(policy.References.Where(reference => reference.Role != "patient" && Relation(record, reference.Role) is null).Select(reference => reference.Role).Distinct(StringComparer.Ordinal).Select(role => (JsonNode)JsonValue.Create(role)!).ToArray()) };
        var expectedSystem = contract.Definition.Patient.System ?? (contract.Definition.Patient.SystemField is string systemField ? record.Record[systemField]?.GetValue<string>() : null);
        var item = queue.Accept(scope, new(source.Id, intakeId, recordId, record.SourceSha256, subject, mappingHash, policy.PrivacyPolicyRevision,
            record.PatientIdentity, dependencies, envelope, now.AddDays(policy.HoldDays), record.PatientAnchor, expectedSystem, policy.References.Any(reference => reference.Role == "patient" && (reference.RequireDestination || reference.Mode != "logical"))), original, now);
        try {
            if (record.AuthoritativePatientEvent && (source.TrustPatientRegistration || registry.PatientSourceAuthorised(scope, SourceFingerprint(source))) && record.PatientIdentity is not null && record.PatientAnchor is not null)
                registry.RegisterVerifiedPatient(scope, record.PatientIdentity, record.PatientAnchor, record.SourceSha256);
        } catch (ProcessingException error) when (error.Code is "PATIENT_IDENTITY_CONFLICT" or "PATIENT_IDENTIFIER_CHANGE_REVIEW_REQUIRED") {
            return queue.BlockIdentityConflict(scope, item.Id, error.Code, now);
        }
        return queue.Inspect(scope, item.Id, now);
    }
    public PendingMessage Inspect(string id, DateTimeOffset now) => queue.Inspect(scope, id, now);
    public ProcessingLease? Acquire(string id, string subject, string mappingHash, DateTimeOffset now) {
        var item = queue.Inspect(scope, id, now);
        if (item.Input.MappingSubject != subject || item.Input.MappingSha256 != mappingHash) throw new ProcessingException("HELD_MAPPING_CHANGED");
        if (item.Input.Source["missingRelationships"] is JsonArray missing && missing.Any(role => !((item.Input.ResolvedRelations ?? []).ContainsKey(role!.GetValue<string>())))) return null;
        return queue.Acquire(scope, id, now);
    }
    public JsonObject MappingInput(ProcessingLease lease) {
        var record = (JsonObject)lease.Input.Source["record"]!.DeepClone();
        void BindResolvedRelationships(JsonObject row) {
            foreach (var relation in contract.Definition.Relations) if (lease.Input.ResolvedRelations?.GetValueOrDefault(relation.Role) is { } identity) {
                row[relation.IdentifierField] = identity.Value;
                if (relation.SystemField is string field) row[field] = identity.System;
            }
        }
        if (record["_group"]?["records"] is JsonArray groupedRecords) foreach (var member in groupedRecords.OfType<JsonObject>()) BindResolvedRelationships(member); else BindResolvedRelationships(record);

        if (!policy.PseudonymisePatientIdentifiers) {
            void Bind(JsonObject row) { row[contract.Definition.Patient.IdentifierField] = lease.Input.PatientIdentity!.Value; if (contract.Definition.Patient.SystemField is string field) row[field] = lease.Input.PatientIdentity.System; }
            if (record["_group"]?["records"] is JsonArray members) foreach (var member in members.OfType<JsonObject>()) Bind(member); else Bind(record);
            return record;
        }
        void Filter(JsonObject row) {
            foreach (var field in contract.Definition.Fields) {
                if (field.Classification == "patient-identifier") row[field.Name] = lease.OutboundPatientIdentity.Value;
                else if (field.Classification is "direct-identifier" or "narrative" || field.Name == contract.Definition.Patient.AnchorField) row.Remove(field.Name);
            }
            if (contract.Definition.Patient.SystemField is string authority) row[authority] = lease.OutboundPatientIdentity.System;
        }
        if (record["_group"] is JsonObject group && group["records"] is JsonArray rows) {
            foreach (var row in rows.OfType<JsonObject>()) Filter(row);
            group.Remove("key"); // Raw grouping keys are internal correlation data, not an outbound identity.
        } else Filter(record);
        return record;
    }
    public JsonObject ApplyReferences(ProcessingLease lease, JsonObject input) {
        var resource = (JsonObject)input.DeepClone();
        var relations = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, ClinicalIdentity?>>(lease.Input.Source["relations"]!, Data.Json)!;
        foreach (var relation in lease.Input.ResolvedRelations ?? []) relations[relation.Key] = relation.Value;
        foreach (var reference in policy.References) {
            var identity = reference.Role == "patient" ? lease.Input.PatientIdentity : relations.GetValueOrDefault(reference.Role);
            var existing = Get(resource, reference.Path) as JsonObject;
            var resolved = FhirReferences.Resolve(registry, queue, scope, policy.PrivacyPolicyRevision, lease.Input.PatientIdentity,
                new(reference.Mode, reference.TargetType), identity, existing?["reference"]?.GetValue<string>());
            if (resolved.State != "RESOLVED") throw new ProcessingException(resolved.State);
            Set(resource, reference.Path, resolved.Reference!);
        }
        if (resource["resourceType"]?.GetValue<string>() == "Patient") resource["identifier"] = new JsonArray(new JsonObject { ["system"] = lease.OutboundPatientIdentity.System, ["value"] = lease.OutboundPatientIdentity.Value });
        // A seeded or copied literal Patient reference must obey the same verified identity binding as configured paths.
        void CheckPatientReferences(JsonNode? node) {
            if (node is JsonObject obj) {
                if (obj["reference"] is JsonValue value && value.GetValue<string>().StartsWith("Patient/", StringComparison.Ordinal)) {
                    var reference = value.GetValue<string>();
                    if (!lease.Dependencies.Any(entity => entity.Key.Type == "Patient" && entity.Reference == reference && new ClinicalIdentity(entity.Key.System, entity.Key.Value) == lease.Input.PatientIdentity))
                        throw new ProcessingException("OUTBOUND_PATIENT_REFERENCE_UNVERIFIED");
                }
                foreach (var pair in obj) CheckPatientReferences(pair.Value);
            } else if (node is JsonArray array) foreach (var child in array) CheckPatientReferences(child);
        }
        CheckPatientReferences(resource);
        CheckPrivacy(lease, resource);
        return resource;
    }
    public void CheckPrivacy(ProcessingLease lease, JsonObject resource) {
        if (!policy.PseudonymisePatientIdentifiers) return;
        var original = (JsonObject)lease.Input.Source["record"]!;
        var rows = original["_group"]?["records"] is JsonArray grouped ? grouped.OfType<JsonObject>() : [original];
        var forbidden = rows.SelectMany(row => contract.Definition.Fields.Where(field => field.Classification is "patient-identifier" or "direct-identifier" or "narrative" || field.Name == contract.Definition.Patient.AnchorField).Select(field => row[field.Name]))
            .Where(value => value?.GetValueKind() == System.Text.Json.JsonValueKind.String).Select(value => value!.GetValue<string>()).Append(lease.Input.PatientIdentity!.Value).Where(value => value.Length > 0 && value != lease.OutboundPatientIdentity.Value).Distinct(StringComparer.Ordinal).ToArray();
        void Walk(JsonNode? node) {
            if (node is JsonObject obj) { foreach (var pair in obj) Walk(pair.Value); }
            else if (node is JsonArray array) { foreach (var child in array) Walk(child); }
            else if (node?.GetValueKind() == System.Text.Json.JsonValueKind.String && forbidden.Any(value => node.GetValue<string>().Contains(value, StringComparison.Ordinal))) throw new ProcessingException("OUTBOUND_DIRECT_IDENTIFIER_REJECTED");
        }
        Walk(resource);
    }
    public ClinicalIdentity? PublicationIdentity(ProcessingLease lease, string resourceType) {
        var publication = policy.Publications.SingleOrDefault(item => item.ResourceType == resourceType);
        if (publication is null) return null;
        if (publication.Role == "patient") return lease.Input.PatientIdentity;
        var relations = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, ClinicalIdentity?>>(lease.Input.Source["relations"]!, Data.Json)!;
        return lease.Input.ResolvedRelations?.GetValueOrDefault(publication.Role) ?? relations.GetValueOrDefault(publication.Role);
    }
    public PendingMessage Complete(ProcessingLease lease, string evidenceHash, bool uncertain, DateTimeOffset now) => queue.Complete(scope, lease.Id, lease.LeaseId, evidenceHash, uncertain, now);
    private static string[] Tokens(string path) {
        if (!path.StartsWith('/') || path == "/") throw new ProcessingException("REFERENCE_TARGET_PATH_INVALID");
        return path[1..].Split('/').Select(part => {
            for (var i = 0; i < part.Length; i++) if (part[i] == '~' && (i + 1 >= part.Length || part[++i] is not ('0' or '1'))) throw new ProcessingException("REFERENCE_TARGET_PATH_INVALID");
            return part.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal);
        }).ToArray();
    }
    private static JsonNode? Get(JsonNode root, string path) {
        JsonNode? node = root;
        foreach (var token in Tokens(path)) node = node is JsonObject obj ? obj[token] : node is JsonArray array && int.TryParse(token, out var i) && i >= 0 && i < array.Count ? array[i] : null;
        return node;
    }
    private static void Set(JsonObject root, string path, JsonObject value) {
        var tokens = Tokens(path); JsonNode node = root;
        for (var i = 0; i < tokens.Length - 1; i++) {
            if (node is JsonObject obj) { if (obj[tokens[i]] is null) obj[tokens[i]] = new JsonObject(); node = obj[tokens[i]]!; }
            else if (node is JsonArray array && int.TryParse(tokens[i], out var index) && index >= 0 && index < array.Count) node = array[index] ?? throw new ProcessingException("REFERENCE_TARGET_PATH_INVALID");
            else throw new ProcessingException("REFERENCE_TARGET_PATH_INVALID");
        }
        if (node is JsonObject parent) parent[tokens[^1]] = value.DeepClone();
        else if (node is JsonArray array && int.TryParse(tokens[^1], out var index) && index >= 0 && index < array.Count) array[index] = value.DeepClone();
        else throw new ProcessingException("REFERENCE_TARGET_PATH_INVALID");
    }
}
