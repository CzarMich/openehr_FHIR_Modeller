using System.Text.Json.Nodes;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record EntityKey(string Type, string System, string Value);
public sealed record EntityEvidence(EntityKey Key, string Reference, string EvidenceSha256, string State, string PatientRegistryId);
public sealed record HeldSource(string Sha256, byte[] OriginalBytes, DateTimeOffset ReceivedAt);
public sealed record PendingInput(string SourceConnection, string IntakeId, string MessageId, string SourceSha256, string MappingSubject,
    string MappingSha256, int PrivacyPolicyRevision, ClinicalIdentity? PatientIdentity, EntityKey[] Dependencies, JsonObject Source,
    DateTimeOffset ExpiresAt, string? SourcePatientAnchor = null, string? ExpectedPatientSystem = null, bool RequireDestinationPatient = false, string? IdentityResolutionEvidenceSha256 = null, Dictionary<string, ClinicalIdentity>? ResolvedRelations = null);
public sealed record PendingMessage(string Id, int Revision, PendingInput Input, string State, DateTimeOffset ReceivedAt,
    string? LeaseId = null, DateTimeOffset? LeaseUntil = null, string? LastEvidenceSha256 = null);
public sealed record ProcessingLease(string Id, string LeaseId, PendingInput Input, ClinicalIdentity OutboundPatientIdentity, EntityEvidence[] Dependencies);

/// <summary>Durable private inputs. Acknowledged receipt is distinct from clinical delivery.</summary>
public sealed partial class DependencyQueue(IdentityRegistry registry, int maximumPending = 5000)
{
    private readonly int pendingLimit = maximumPending is >= 1 and <= 5000 ? maximumPending : throw new ProcessingException("DEPENDENCY_CAPACITY_INVALID");
    private static readonly HashSet<string> Final = ["DELIVERED", "CANCELLED", "EXPIRED"];
    private static void Hash(string value) { if (!System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-f0-9]{64}$")) throw new ProcessingException("DEPENDENCY_EVIDENCE_REQUIRED"); }
    private string EntityId(EntityKey key) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(key.Type, "^[A-Z][A-Za-z0-9]{1,63}$") || string.IsNullOrWhiteSpace(key.System) || string.IsNullOrWhiteSpace(key.Value) || key.System.Length > 2000 || key.Value.Length > 512 || (key.System + key.Value).Any(char.IsControl)) throw new ProcessingException("DEPENDENCY_IDENTITY_REQUIRED");
        if (!Uri.TryCreate(key.System, UriKind.Absolute, out var authority) || authority.Scheme is not ("https" or "http" or "urn") || authority.UserInfo.Length != 0 || key.System.Any(char.IsWhiteSpace)) throw new ProcessingException("DEPENDENCY_ASSIGNING_AUTHORITY_REQUIRED");
        return registry.Index(System.Text.Json.JsonSerializer.Serialize(key, Data.Json));
    }
    private void Save(OperationalScope scope, string token, PendingMessage item, Microsoft.Data.Sqlite.SqliteTransaction transaction) {
        registry.Write(token, "pending", item.Id, item.Revision, item, transaction);
        registry.BindProcessingState(scope, token, item.Id, item.State, registry.Index(item.Input.SourceConnection + "\n" + item.Input.IntakeId), transaction);
    }
    public PendingMessage Accept(OperationalScope scope, PendingInput input, byte[] original, DateTimeOffset now) {
        if (original.Length is < 1 or > Sources.Limit || Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(original)) != input.SourceSha256) throw new ProcessingException("SOURCE_CHANGED");
        var token = registry.Scope(scope);
        using var transaction = registry.Transaction();
        var sourceId = registry.Index(input.SourceSha256);
        var before = registry.Read<HeldSource>(token, "original-source", sourceId, transaction);
        if (before is null) registry.Write(token, "original-source", sourceId, 1, new HeldSource(input.SourceSha256, original, now), transaction);
        else if (before.Sha256 != input.SourceSha256 || !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(before.OriginalBytes, original)) throw new ProcessingException("HELD_SOURCE_INTEGRITY_FAILED");
        var item = EnqueueWithin(scope, input, now, transaction);
        transaction.Commit(); return item;
    }
    public byte[] ReadOriginal(OperationalScope scope, string sourceSha256) {
        Hash(sourceSha256);
        var source = registry.Read<HeldSource>(registry.Scope(scope), "original-source", registry.Index(sourceSha256)) ?? throw new ProcessingException("HELD_SOURCE_UNAVAILABLE");
        if (source.Sha256 != sourceSha256 || Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(source.OriginalBytes)) != sourceSha256) throw new ProcessingException("HELD_SOURCE_INTEGRITY_FAILED");
        return source.OriginalBytes;
    }
    internal PendingMessage Enqueue(OperationalScope scope, PendingInput input, DateTimeOffset now) {
        using var transaction = registry.Transaction(); var item = EnqueueWithin(scope, input, now, transaction); transaction.Commit(); return item;
    }
    private PendingMessage EnqueueWithin(OperationalScope scope, PendingInput input, DateTimeOffset now, Microsoft.Data.Sqlite.SqliteTransaction transaction) {
        var token = registry.Scope(scope); Hash(input.SourceSha256); Hash(input.MappingSubject); Hash(input.MappingSha256);
        if (string.IsNullOrWhiteSpace(input.SourceConnection) || string.IsNullOrWhiteSpace(input.IntakeId) || string.IsNullOrWhiteSpace(input.MessageId) || input.SourceConnection.Length > 256 || input.IntakeId.Length > 256 || input.MessageId.Length > 512 || (input.SourceConnection + input.IntakeId + input.MessageId).Any(char.IsControl)
            || input.Dependencies.Length > 64 || input.Source.ToJsonString().Length > Sources.Limit || input.ExpiresAt <= now || input.ExpiresAt > now.AddDays(366)) throw new ProcessingException("DEPENDENCY_INPUT_INVALID");
        foreach (var dependency in input.Dependencies) _ = EntityId(dependency);
        var id = registry.Index(System.Text.Json.JsonSerializer.Serialize(new { input.SourceConnection, input.IntakeId, input.MessageId }, Data.Json));
        var before = registry.Read<PendingMessage>(token, "pending", id, transaction);
        if (before is not null) {
            if (before.Input.SourceSha256 != input.SourceSha256 || Data.Canonical(before.Input.Source) != Data.Canonical(input.Source)) throw new ProcessingException("MESSAGE_CONTROL_ID_CONFLICT");
            return before; // A repeated input never adopts a different mapping/privacy policy silently.
        }
        if (registry.ActivePendingCount(token, registry.Index(input.SourceConnection + "\n" + input.IntakeId), transaction) >= pendingLimit) throw new ProcessingException("DEPENDENCY_QUEUE_CAPACITY");
        var item = new PendingMessage(id, 1, input, "WAITING", now);
        item = item with { State = Readiness(token, scope, item, now, transaction) };
        Save(scope, token, item, transaction); return item;
    }
    private string Readiness(string token, OperationalScope scope, PendingMessage item, DateTimeOffset now, Microsoft.Data.Sqlite.SqliteTransaction transaction) {
        if (Final.Contains(item.State) || item.State is "RECONCILIATION_REQUIRED" or "LEASED" or "PROCESSING_REVIEW_REQUIRED" or "RECONCILING" or "IDENTITY_CONFLICT") return item.State;
        if (item.Input.ExpiresAt <= now) return "EXPIRED";
        var policy = registry.Policy(scope, transaction);
        if (policy.Revision != item.Input.PrivacyPolicyRevision) return "POLICY_REVIEW_REQUIRED";
        if (item.Input.PatientIdentity is null) return "WAITING_PATIENT_IDENTITY";
        if (item.Input.Source["missingRelationships"] is JsonArray missingRoles) {
            if (missingRoles.Any(role => !((item.Input.ResolvedRelations ?? []).ContainsKey(role!.GetValue<string>())))) return "WAITING_RELATIONSHIP_IDENTIFIER";
        } else if (item.Input.Source["missingRelationship"]?.GetValue<bool>() == true) return "WAITING_RELATIONSHIP_IDENTIFIER";
        var patient = registry.Read<RegisteredPatient>(token, "patient", registry.PatientKey(item.Input.PatientIdentity), transaction);
        if (patient?.State != "VERIFIED") return "WAITING_PATIENT_IDENTITY";
        foreach (var key in item.Input.Dependencies) {
            var entity = registry.Read<EntityEvidence>(token, "entity", EntityId(key), transaction);
            if (entity?.State == "CONFLICT" || entity is not null && entity.PatientRegistryId != patient.RegistryId) return "IDENTITY_CONFLICT";
            if (entity?.State != "VERIFIED") return "WAITING_DEPENDENCIES";
        }
        return "READY";
    }
    private PendingMessage BindTrustedPatientAnchor(OperationalScope scope, PendingMessage item, Microsoft.Data.Sqlite.SqliteTransaction transaction, DateTimeOffset now) {
        if (item.Input.PatientIdentity is not null || item.Input.SourcePatientAnchor is null || item.Input.ExpiresAt <= now || Final.Contains(item.State) || item.State is "LEASED" or "RECONCILING" or "RECONCILIATION_REQUIRED" or "IDENTITY_CONFLICT") return item;
        var patient = registry.FindByAnchor(scope, item.Input.SourcePatientAnchor, transaction);
        if (patient?.State != "VERIFIED") return item;
        if (item.Input.ExpectedPatientSystem is not null && item.Input.ExpectedPatientSystem != patient.SourceIdentity.System) return item with { Revision = item.Revision + 1, State = "IDENTITY_CONFLICT" };
        var dependencies = item.Input.Dependencies;
        if (item.Input.RequireDestinationPatient) dependencies = dependencies.Append(new EntityKey("Patient", patient.SourceIdentity.System, patient.SourceIdentity.Value)).Distinct().ToArray();
        var after = item with { Revision = item.Revision + 1, Input = item.Input with { PatientIdentity = patient.SourceIdentity, Dependencies = dependencies, IdentityResolutionEvidenceSha256 = patient.EvidenceSha256 } };
        registry.Write(registry.Scope(scope), "identity-resolution-history", Guid.NewGuid().ToString("N"), after.Revision,
            new { pendingId = item.Id, item.Input.SourceSha256, patient.RegistryId, patient.EvidenceSha256, actorId = "trusted-source-anchor", resolvedAt = now }, transaction);
        return after;
    }
    public PendingMessage BlockIdentityConflict(OperationalScope scope, string id, string code, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(id); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (Final.Contains(item.State) || item.State is "LEASED" or "RECONCILING" or "RECONCILIATION_REQUIRED") throw new ProcessingException("PENDING_INPUT_REVISION_CONFLICT");
        var after = item with { Revision = item.Revision + 1, State = "IDENTITY_CONFLICT", LastEvidenceSha256 = Data.Hash(code) };
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
    public PendingMessage Inspect(OperationalScope scope, string id, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(id); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        item = BindTrustedPatientAnchor(scope, item, transaction, now);
        if (item.State is "LEASED" or "RECONCILING" && item.LeaseUntil <= now) item = item with { Revision = item.Revision + 1, State = "RECONCILIATION_REQUIRED" };
        else {
            var state = Readiness(token, scope, item, now, transaction);
            if (state != item.State) item = item with { State = state, Revision = item.Revision + 1 };
        }
        Save(scope, token, item, transaction); transaction.Commit(); return item;
    }
    public ProcessingLease? Acquire(OperationalScope scope, string id, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(id); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        item = BindTrustedPatientAnchor(scope, item, transaction, now);
        var state = item.State is "LEASED" or "RECONCILING" && item.LeaseUntil <= now ? "RECONCILIATION_REQUIRED" : Readiness(token, scope, item, now, transaction);
        if (state != "READY") { var after = item with { State = state, Revision = item.Revision + (state == item.State ? 0 : 1) }; Save(scope, token, after, transaction); transaction.Commit(); return null; }
        var leaseId = Guid.NewGuid().ToString("N");
        var patient = registry.Read<RegisteredPatient>(token, "patient", registry.PatientKey(item.Input.PatientIdentity!), transaction)!;
        var policy = registry.Policy(scope, transaction);
        var outbound = policy.PseudonymisePatientIdentifiers ? new ClinicalIdentity(policy.PseudonymSystem!, patient.Pseudonym) : patient.SourceIdentity;
        var dependencies = item.Input.Dependencies.Select(key => registry.Read<EntityEvidence>(token, "entity", EntityId(key), transaction)!).ToArray();
        Save(scope, token, item with { Revision = item.Revision + 1, State = "LEASED", LeaseId = leaseId, LeaseUntil = now.AddMinutes(15) }, transaction);
        transaction.Commit(); return new(id, leaseId, item.Input, outbound, dependencies);
    }
    public PendingMessage AttachVerifiedPatient(OperationalScope scope, string id, int expectedRevision, string originalSourceSha256,
        ClinicalIdentity identity, string actorId, string evidenceSha256, DateTimeOffset now, EntityKey[]? additionalDependencies = null, string? comment = null) {
        var token = registry.Scope(scope); Hash(id); Hash(originalSourceSha256); Hash(evidenceSha256);
        if (string.IsNullOrWhiteSpace(actorId) || actorId.Length > 256 || actorId.Any(char.IsControl)) throw new ProcessingException("IDENTITY_RESOLUTION_ACTOR_REQUIRED");
        using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.Revision != expectedRevision || item.Input.SourceSha256 != originalSourceSha256 || item.Input.PatientIdentity is not null || Final.Contains(item.State) || item.State is "LEASED" or "RECONCILING" or "RECONCILIATION_REQUIRED") throw new ProcessingException("PATIENT_RESOLUTION_CONFLICT");
        if (item.Input.ExpiresAt <= now) throw new ProcessingException("PENDING_INPUT_EXPIRED");
        if (item.Input.ExpectedPatientSystem is not null && item.Input.ExpectedPatientSystem != identity.System) throw new ProcessingException("PATIENT_ASSIGNING_AUTHORITY_MISMATCH");
        var patient = registry.Read<RegisteredPatient>(token, "patient", registry.PatientKey(identity), transaction);
        if (patient?.State != "VERIFIED") throw new ProcessingException("WAITING_PATIENT_IDENTITY");
        var dependencies = item.Input.Dependencies.Concat(additionalDependencies ?? []).Distinct().ToArray();
        if (dependencies.Length > 64) throw new ProcessingException("DEPENDENCY_INPUT_INVALID");
        foreach (var dependency in dependencies) _ = EntityId(dependency);
        var after = item with { Revision = item.Revision + 1, Input = item.Input with { PatientIdentity = identity, Dependencies = dependencies, IdentityResolutionEvidenceSha256 = evidenceSha256 } };
        after = after with { State = Readiness(token, scope, after, now, transaction) };
        registry.Write(token, "identity-resolution-history", registry.Index(id + "\n" + after.Revision), after.Revision,
            new { pendingId = id, originalSourceSha256, identity, patient.RegistryId, actorId, evidenceSha256, comment, resolvedAt = now }, transaction);
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
    public PendingMessage AttachVerifiedRelationship(OperationalScope scope, string id, int expectedRevision, string sourceSha256, string role, EntityKey key, string actorId, string comment, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(id); Hash(sourceSha256); _ = EntityId(key);
        if (!System.Text.RegularExpressions.Regex.IsMatch(role, "^[A-Za-z][A-Za-z0-9_]{0,63}$") || role == "patient" || string.IsNullOrWhiteSpace(actorId) || string.IsNullOrWhiteSpace(comment) || comment.Length > 4000) throw new ProcessingException("RELATIONSHIP_REVIEW_REQUIRED");
        using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.Revision != expectedRevision || item.Input.SourceSha256 != sourceSha256 || Final.Contains(item.State) || item.State is "LEASED" or "RECONCILING" or "RECONCILIATION_REQUIRED" || item.Input.ExpiresAt <= now) throw new ProcessingException("RELATIONSHIP_RESOLUTION_CONFLICT");
        var original = item.Input.Source["relations"] as JsonObject;
        if (original is null || !original.ContainsKey(role) || original[role] is not null || item.Input.ResolvedRelations?.ContainsKey(role) == true) throw new ProcessingException("RELATIONSHIP_REASSIGNMENT_REQUIRES_REVIEW");
        var patient = item.Input.PatientIdentity is null ? null : registry.Read<RegisteredPatient>(token, "patient", registry.PatientKey(item.Input.PatientIdentity), transaction);
        var entity = registry.Read<EntityEvidence>(token, "entity", EntityId(key), transaction);
        if (patient?.State != "VERIFIED" || entity?.State != "VERIFIED" || entity.PatientRegistryId != patient.RegistryId) throw new ProcessingException("ENTITY_PATIENT_BINDING_REQUIRED");
        var relations = new Dictionary<string, ClinicalIdentity>(item.Input.ResolvedRelations ?? [], StringComparer.Ordinal) { [role] = new(key.System, key.Value) };
        var dependencies = item.Input.Dependencies.Append(key).Distinct().ToArray();
        if (dependencies.Length > 64) throw new ProcessingException("DEPENDENCY_INPUT_INVALID");
        var after = item with { Revision = item.Revision + 1, Input = item.Input with { ResolvedRelations = relations, Dependencies = dependencies } };
        after = after with { State = Readiness(token, scope, after, now, transaction) };
        registry.Write(token, "relationship-resolution-history", Guid.NewGuid().ToString("N"), after.Revision, new { pendingId = id, sourceSha256, role, key, entity.EvidenceSha256, actorId, comment, resolvedAt = now }, transaction);
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
    public EntityEvidence? ResolveEntity(OperationalScope scope, EntityKey key) => registry.Read<EntityEvidence>(registry.Scope(scope), "entity", EntityId(key));
    // Only the trusted destination adapter calls this after authenticating a successful receipt or read response.
    public void PublishVerifiedEntity(OperationalScope scope, EntityEvidence evidence) {
        var token = registry.Scope(scope); var key = EntityId(evidence.Key); Hash(evidence.EvidenceSha256);
        if (evidence.State != "VERIFIED" || !System.Text.RegularExpressions.Regex.IsMatch(evidence.Reference, "^" + evidence.Key.Type + "/[A-Za-z0-9.-]{1,64}$")) throw new ProcessingException("VERIFIED_ENTITY_REFERENCE_REQUIRED");
        using var transaction = registry.Transaction();
        var patient = registry.PatientById(token, evidence.PatientRegistryId, transaction);
        if (patient?.State != "VERIFIED" || evidence.Key.Type == "Patient" && new ClinicalIdentity(evidence.Key.System, evidence.Key.Value) != patient.SourceIdentity) throw new ProcessingException("ENTITY_PATIENT_BINDING_REQUIRED");
        var before = registry.Read<EntityEvidence>(token, "entity", key, transaction);
        var after = before is not null && (before.Reference != evidence.Reference || before.PatientRegistryId != evidence.PatientRegistryId || before.State == "CONFLICT") ? before with { State = "CONFLICT" } : evidence;
        registry.MarkDestinationIdentityUse(scope, registry.Policy(scope, transaction).Revision, evidence.EvidenceSha256, transaction);
        registry.Write(token, "entity-history", registry.Index(System.Text.Json.JsonSerializer.Serialize(evidence, Data.Json)), 1, evidence, transaction);
        registry.Write(token, "entity", key, 1, after, transaction); transaction.Commit();
    }
    public PendingMessage Complete(OperationalScope scope, string id, string leaseId, string evidenceSha256, bool uncertain, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(id); Hash(evidenceSha256); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.State != "LEASED" || item.LeaseId != leaseId || item.LeaseUntil <= now) throw new ProcessingException("PROCESSING_LEASE_CONFLICT");
        if (!uncertain) registry.MarkDestinationIdentityUse(scope, item.Input.PrivacyPolicyRevision, evidenceSha256, transaction);
        var after = item with { Revision = item.Revision + 1, State = uncertain ? "RECONCILIATION_REQUIRED" : "DELIVERED", LastEvidenceSha256 = evidenceSha256, LeaseUntil = null };
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
    public PendingMessage Fail(OperationalScope scope, ProcessingLease lease, string evidenceSha256, bool writeMayHaveOccurred, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(lease.Id); Hash(evidenceSha256); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", lease.Id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.State != "LEASED" || item.LeaseId != lease.LeaseId || item.LeaseUntil <= now) throw new ProcessingException("PROCESSING_LEASE_CONFLICT");
        var after = item with { Revision = item.Revision + 1, State = writeMayHaveOccurred ? "RECONCILIATION_REQUIRED" : "PROCESSING_REVIEW_REQUIRED", LastEvidenceSha256 = evidenceSha256, LeaseUntil = null };
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
    public void InvalidateEntity(OperationalScope scope, EntityKey key, string evidenceSha256) {
        var token = registry.Scope(scope); Hash(evidenceSha256); using var transaction = registry.Transaction();
        var entityId = EntityId(key); var before = registry.Read<EntityEvidence>(token, "entity", entityId, transaction);
        if (before is not null) registry.Write(token, "entity", entityId, 1, before with { State = "UNAVAILABLE", EvidenceSha256 = evidenceSha256 }, transaction);
        transaction.Commit();
    }
    public PendingMessage Cancel(OperationalScope scope, string id, int expectedRevision) {
        var token = registry.Scope(scope); Hash(id); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.Revision != expectedRevision || item.State is "LEASED" or "RECONCILING" or "RECONCILIATION_REQUIRED" or "DELIVERED") throw new ProcessingException("PENDING_INPUT_REVISION_CONFLICT");
        var after = item with { Revision = item.Revision + 1, State = "CANCELLED" };
        Save(scope, token, after, transaction); transaction.Commit(); return after;
    }
}
