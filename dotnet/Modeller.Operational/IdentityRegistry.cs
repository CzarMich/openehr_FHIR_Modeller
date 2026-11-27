using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record OperationalScope(string Owner, string ProjectId, string SourceSystem, string DestinationId);
public sealed record ClinicalIdentity(string System, string Value);
public sealed record DestinationPrivacyPolicy(int Revision, bool PseudonymisePatientIdentifiers, string? PseudonymSystem) {
    public bool PatientIdentityRequired => true;
}
internal sealed record DestinationIdentityUse(bool Pseudonymise, string? PseudonymSystem, string EvidenceSha256, DateTimeOffset ObservedAt);
public sealed record RegisteredPatient(string RegistryId, ClinicalIdentity SourceIdentity, string SourcePatientAnchor, string Pseudonym,
    string State, string EvidenceSha256, DateTimeOffset VerifiedAt, string? DestinationReference = null);

/// <summary>Internal platform state only. This class never accepts a source database connection string.</summary>
public sealed class IdentityRegistry : IDisposable
{
    private readonly SqliteConnection connection;
    private readonly byte[] encryptionKey;
    private readonly byte[] indexKey;
    private readonly long scopeQuotaBytes;
    public IdentityRegistry(string privateRoot, ReadOnlySpan<byte> masterKey, long scopeQuotaBytes = 536870912) {
        if (scopeQuotaBytes is < 1048576 or > 8589934592) throw new ProcessingException("OPERATIONAL_QUOTA_INVALID");
        this.scopeQuotaBytes = scopeQuotaBytes;
        if (masterKey.Length != 32 || !Path.IsPathFullyQualified(privateRoot)) throw new ProcessingException("IDENTITY_STORE_CONFIGURATION_REQUIRED");
        var directory = new DirectoryInfo(Path.GetFullPath(privateRoot));
        for (var ancestor = directory; ancestor is not null; ancestor = ancestor.Parent)
            if (ancestor.LinkTarget is not null) throw new ProcessingException("IDENTITY_STORE_LINK_REJECTED");
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(directory.FullName);
        else Directory.CreateDirectory(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var file = Path.Combine(directory.FullName, "operational.sqlite");
        if (new FileInfo(file).LinkTarget is not null) throw new ProcessingException("IDENTITY_STORE_LINK_REJECTED");
        encryptionKey = HMACSHA256.HashData(masterKey, Encoding.UTF8.GetBytes("modeller-operational/encryption/v1"));
        indexKey = HMACSHA256.HashData(masterKey, Encoding.UTF8.GetBytes("modeller-operational/index/v1"));
        connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = file, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operational_records(scope TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(scope,kind,id)); CREATE TABLE IF NOT EXISTS operational_processing_state(policy_scope TEXT NOT NULL,record_scope TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(record_scope,id));";
        command.ExecuteNonQuery();
        try {
            using var transaction = Transaction();
            var marker = Read<StoreMarker>("store", "metadata", "key-proof", transaction);
            if (marker is null) {
                using var count = connection.CreateCommand(); count.Transaction = transaction;
                count.CommandText = "SELECT COUNT(*) FROM operational_records";
                if (Convert.ToInt64(count.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) != 0) throw new ProcessingException("OPERATIONAL_STORE_HEADER_REQUIRED");
                Write("store", "metadata", "key-proof", 1, new StoreMarker(1, "modeller-private-operational"), transaction);
            } else if (marker.Version != 1 || marker.Purpose != "modeller-private-operational") throw new ProcessingException("OPERATIONAL_STORE_VERSION_UNSUPPORTED");
            transaction.Commit();
        } catch { Dispose(); throw; }
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
    private sealed record SharedPseudonym(string Value);
    private sealed record PseudonymOwner(string SourceScope, string RegistryId);
    private sealed record StoreMarker(int Version, string Purpose);
    public void Dispose() { connection.Dispose(); CryptographicOperations.ZeroMemory(encryptionKey); CryptographicOperations.ZeroMemory(indexKey); }
    private static void Text(string value, int maximum = 256) {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum || value.Any(char.IsControl)) throw new ProcessingException("IDENTITY_VALUE_REQUIRED");
    }
    internal static void Identity(ClinicalIdentity value) {
        Text(value.System, 2000); Text(value.Value, 512);
        if (!Uri.TryCreate(value.System, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http" or "urn") || uri.UserInfo.Length != 0 || value.System.Any(char.IsWhiteSpace)) throw new ProcessingException("IDENTITY_ASSIGNING_AUTHORITY_REQUIRED");
    }
    internal string Scope(OperationalScope scope) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(scope.Owner, "^[a-f0-9]{64}$") || !System.Text.RegularExpressions.Regex.IsMatch(scope.ProjectId, "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")) throw new ProcessingException("IDENTITY_SCOPE_REQUIRED");
        Text(scope.SourceSystem); Text(scope.DestinationId);
        return Index(JsonSerializer.Serialize(scope, Data.Json));
    }
    internal string PolicyScope(OperationalScope scope) {
        _ = Scope(scope);
        return Index("destination-privacy/v1\n" + JsonSerializer.Serialize(new { scope.ProjectId, scope.DestinationId }, Data.Json));
    }
    internal void BindProcessingState(OperationalScope scope, string recordScope, string id, string state, SqliteTransaction transaction) {
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "INSERT INTO operational_processing_state(policy_scope,record_scope,id,state) VALUES($policy,$scope,$id,$state) ON CONFLICT(record_scope,id) DO UPDATE SET policy_scope=excluded.policy_scope,state=excluded.state";
        command.Parameters.AddWithValue("$policy", PolicyScope(scope)); command.Parameters.AddWithValue("$scope", recordScope); command.Parameters.AddWithValue("$id", id); command.Parameters.AddWithValue("$state", state); command.ExecuteNonQuery();
    }
    internal string Index(string value) => Convert.ToHexStringLower(HMACSHA256.HashData(indexKey, Encoding.UTF8.GetBytes(value)));
    internal string PatientKey(ClinicalIdentity identity) { Identity(identity); return Index(JsonSerializer.Serialize(identity, Data.Json)); }
    internal T? Read<T>(string scope, string kind, string id, SqliteTransaction? transaction = null) where T : class {
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "SELECT revision,payload FROM operational_records WHERE scope=$scope AND kind=$kind AND id=$id";
        command.Parameters.AddWithValue("$scope", scope); command.Parameters.AddWithValue("$kind", kind); command.Parameters.AddWithValue("$id", id);
        using var reader = command.ExecuteReader(); if (!reader.Read()) return null;
        var revision = reader.GetInt32(0); var sealedBytes = (byte[])reader.GetValue(1);
        if (sealedBytes.Length is < 28 or > 33554432) throw new ProcessingException("OPERATIONAL_STATE_INVALID");
        var plaintext = new byte[sealedBytes.Length - 28];
        try {
            using var aes = new AesGcm(encryptionKey, 16);
            aes.Decrypt(sealedBytes.AsSpan(0, 12), sealedBytes.AsSpan(28), sealedBytes.AsSpan(12, 16), plaintext, Encoding.UTF8.GetBytes(scope + "\n" + kind + "\n" + id + "\n" + revision));
            return JsonSerializer.Deserialize<T>(plaintext, Data.Json) ?? throw new ProcessingException("OPERATIONAL_STATE_INVALID");
        } catch (CryptographicException) { throw new ProcessingException("OPERATIONAL_STATE_INTEGRITY_FAILED"); }
        finally { CryptographicOperations.ZeroMemory(plaintext); }
    }
    internal void Write<T>(string scope, string kind, string id, int revision, T value, SqliteTransaction transaction) {
        var plaintext = JsonSerializer.SerializeToUtf8Bytes(value, Data.Json);
        if (plaintext.Length > 33554400) throw new ProcessingException("OPERATIONAL_STATE_LIMIT");
        using (var quota = connection.CreateCommand()) {
            quota.Transaction = transaction;
            quota.CommandText = "SELECT COALESCE(SUM(length(payload)),0),COALESCE(MAX(CASE WHEN kind=$kind AND id=$id THEN length(payload) ELSE 0 END),0) FROM operational_records WHERE scope=$scope";
            quota.Parameters.AddWithValue("$scope", scope); quota.Parameters.AddWithValue("$kind", kind); quota.Parameters.AddWithValue("$id", id);
            using var row = quota.ExecuteReader(); row.Read();
            if (row.GetInt64(0) - row.GetInt64(1) + plaintext.Length + 28 > scopeQuotaBytes) { CryptographicOperations.ZeroMemory(plaintext); throw new ProcessingException("OPERATIONAL_STORAGE_LIMIT"); }
        }
        var bytes = new byte[plaintext.Length + 28]; RandomNumberGenerator.Fill(bytes.AsSpan(0, 12));
        try {
            using var aes = new AesGcm(encryptionKey, 16);
            aes.Encrypt(bytes.AsSpan(0, 12), plaintext, bytes.AsSpan(28), bytes.AsSpan(12, 16), Encoding.UTF8.GetBytes(scope + "\n" + kind + "\n" + id + "\n" + revision));
        } finally { CryptographicOperations.ZeroMemory(plaintext); }
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "INSERT INTO operational_records(scope,kind,id,revision,payload) VALUES($scope,$kind,$id,$revision,$payload) ON CONFLICT(scope,kind,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload";
        command.Parameters.AddWithValue("$scope", scope); command.Parameters.AddWithValue("$kind", kind); command.Parameters.AddWithValue("$id", id); command.Parameters.AddWithValue("$revision", revision); command.Parameters.AddWithValue("$payload", bytes); command.ExecuteNonQuery();
    }
    internal string[] RecordIds(string scope, string kind, SqliteTransaction transaction) {
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "SELECT id FROM operational_records WHERE scope=$scope AND kind=$kind ORDER BY id LIMIT 5001";
        command.Parameters.AddWithValue("$scope", scope); command.Parameters.AddWithValue("$kind", kind);
        using var reader = command.ExecuteReader(); var ids = new List<string>(); while (reader.Read()) ids.Add(reader.GetString(0)); return ids.ToArray();
    }
    internal SqliteTransaction Transaction() => connection.BeginTransaction(deferred: false);
    public DestinationPrivacyPolicy Policy(OperationalScope scope) => Policy(scope, null);
    internal DestinationPrivacyPolicy Policy(OperationalScope scope, SqliteTransaction? transaction) => Read<DestinationPrivacyPolicy>(PolicyScope(scope), "privacy", "current", transaction) ?? new(0, false, null);
    public DestinationPrivacyPolicy ChangePolicy(OperationalScope scope, int expectedRevision, bool pseudonymise, string? pseudonymSystem, string? actorId = null) {
        if (actorId is not null) Text(actorId);
        var token = PolicyScope(scope); if (pseudonymise) Identity(new(pseudonymSystem ?? "", "namespace-validation"));
        using var transaction = Transaction(); var before = Read<DestinationPrivacyPolicy>(token, "privacy", "current", transaction) ?? new(0, false, null);
        if (before.Revision != expectedRevision) throw new ProcessingException("PRIVACY_POLICY_REVISION_CONFLICT");
        if (before.PseudonymisePatientIdentifiers == pseudonymise && before.PseudonymSystem == (pseudonymise ? pseudonymSystem : null)) { transaction.Commit(); return before; }
        using (var active = connection.CreateCommand()) {
            active.Transaction = transaction; active.CommandText = "SELECT COUNT(*) FROM operational_processing_state WHERE policy_scope=$policy AND state IN ('LEASED','RECONCILIATION_REQUIRED')";
            active.Parameters.AddWithValue("$policy", token);
            if (Convert.ToInt64(active.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) != 0) throw new ProcessingException("PRIVACY_POLICY_ACTIVE_PROCESSING");
        }
        var usage = Read<DestinationIdentityUse>(token, "privacy-use", "first", transaction);
        if (usage is not null && (usage.Pseudonymise != pseudonymise || usage.PseudonymSystem != (pseudonymise ? pseudonymSystem : null))) throw new ProcessingException("DESTINATION_IDENTITY_MIGRATION_REQUIRED");
        var after = new DestinationPrivacyPolicy(before.Revision + 1, pseudonymise, pseudonymise ? pseudonymSystem : null);
        Write(token, "privacy", "current", after.Revision, after, transaction);
        Write(token, "privacy-history", after.Revision.ToString(System.Globalization.CultureInfo.InvariantCulture), after.Revision, new { policy = after, actorId = actorId ?? "trusted-system", changedAt = DateTimeOffset.UtcNow }, transaction);
        transaction.Commit(); return after;
    }
    internal RegisteredPatient? PatientById(string token, string registryId, SqliteTransaction? transaction = null) => Read<RegisteredPatient>(token, "patient-by-registry-id", Index(registryId), transaction);
    internal void MarkDestinationIdentityUse(OperationalScope scope, int policyRevision, string evidenceSha256, SqliteTransaction transaction) {
        var policy = Policy(scope, transaction);
        if (policy.Revision != policyRevision) throw new ProcessingException("PRIVACY_POLICY_REVIEW_REQUIRED");
        var token = PolicyScope(scope); var before = Read<DestinationIdentityUse>(token, "privacy-use", "first", transaction);
        if (before is not null && (before.Pseudonymise != policy.PseudonymisePatientIdentifiers || before.PseudonymSystem != policy.PseudonymSystem)) throw new ProcessingException("DESTINATION_IDENTITY_POLICY_CONFLICT");
        if (before is null) Write(token, "privacy-use", "first", 1, new DestinationIdentityUse(policy.PseudonymisePatientIdentifiers, policy.PseudonymSystem, evidenceSha256, DateTimeOffset.UtcNow), transaction);
    }
    public void AuthorisePatientSource(OperationalScope scope, string connectionSha256, string actorId, string comment) {
        var token = Scope(scope);
        if (!System.Text.RegularExpressions.Regex.IsMatch(connectionSha256, "^[a-f0-9]{64}$") || string.IsNullOrWhiteSpace(actorId) || actorId.Length > 256 || string.IsNullOrWhiteSpace(comment) || comment.Length > 4000) throw new ProcessingException("SOURCE_TRUST_REVIEW_REQUIRED");
        using var transaction = Transaction();
        var evidence = new SourceTrust(connectionSha256, actorId, comment, DateTimeOffset.UtcNow);
        Write(token, "source-trust", connectionSha256, 1, evidence, transaction);
        Write(token, "source-trust-history", Guid.NewGuid().ToString("N"), 1, evidence, transaction);
        transaction.Commit();
    }
    private sealed record SourceTrust(string ConnectionSha256, string ActorId, string Comment, DateTimeOffset ConfirmedAt);
    public bool PatientSourceAuthorised(OperationalScope scope, string connectionSha256) => Read<SourceTrust>(Scope(scope), "source-trust", connectionSha256)?.ConnectionSha256 == connectionSha256;
    public RegisteredPatient? FindPatient(OperationalScope scope, ClinicalIdentity identity) => Read<RegisteredPatient>(Scope(scope), "patient", PatientKey(identity));
    public RegisteredPatient RegisterVerifiedPatient(OperationalScope scope, ClinicalIdentity identity, string sourcePatientAnchor, string evidenceSha256) {
        var token = Scope(scope); var id = PatientKey(identity); Text(sourcePatientAnchor, 512);
        if (!System.Text.RegularExpressions.Regex.IsMatch(evidenceSha256, "^[a-f0-9]{64}$")) throw new ProcessingException("VERIFIED_PATIENT_EVIDENCE_REQUIRED");
        using var transaction = Transaction(); var before = Read<RegisteredPatient>(token, "patient", id, transaction);
        if (before is not null) {
            if (before.SourcePatientAnchor != sourcePatientAnchor || before.State != "VERIFIED") throw new ProcessingException("PATIENT_IDENTITY_CONFLICT");
            transaction.Commit(); return before;
        }
        var registryId = Guid.NewGuid().ToString("N");
        for (var attempt = 0; PatientById(token, registryId, transaction) is not null; attempt++) {
            if (attempt >= 5) throw new ProcessingException("PATIENT_REGISTRY_ALLOCATION_CONFLICT");
            registryId = Guid.NewGuid().ToString("N");
        }
        var pseudonymScope = PolicyScope(scope);
        // Reuse the opaque destination identity across authorised operators in the same project/domain.
        // Their source registrations, originals, queue rows and registry records remain owner-private.
        var sharedIdentity = Index(JsonSerializer.Serialize(new { scope.ProjectId, scope.SourceSystem, scope.DestinationId, identity }, Data.Json));
        var shared = Read<SharedPseudonym>(pseudonymScope, "stable-pseudonym", sharedIdentity, transaction);
        var pseudonym = shared?.Value ?? Guid.NewGuid().ToString("N");
        if (shared is null) {
            for (var attempt = 0; Read<PseudonymOwner>(pseudonymScope, "pseudonym-uniqueness", Index(pseudonym), transaction) is not null; attempt++) {
                if (attempt >= 5) throw new ProcessingException("PSEUDONYM_ALLOCATION_CONFLICT");
                pseudonym = Guid.NewGuid().ToString("N");
            }
            Write(pseudonymScope, "pseudonym-uniqueness", Index(pseudonym), 1, new PseudonymOwner(token, registryId), transaction);
            Write(pseudonymScope, "stable-pseudonym", sharedIdentity, 1, new SharedPseudonym(pseudonym), transaction);
        }
        var patient = new RegisteredPatient(registryId, identity, sourcePatientAnchor, pseudonym, "VERIFIED", evidenceSha256, DateTimeOffset.UtcNow);
        Write(token, "patient", id, 1, patient, transaction);
        Write(token, "patient-by-registry-id", Index(patient.RegistryId), 1, patient, transaction);
        transaction.Commit(); return patient;
    }
    public ClinicalIdentity OutboundPatientIdentity(OperationalScope scope, ClinicalIdentity sourceIdentity, int confirmedPolicyRevision) {
        var policy = Policy(scope);
        if (policy.Revision != confirmedPolicyRevision) throw new ProcessingException("PRIVACY_POLICY_REVIEW_REQUIRED");
        var patient = FindPatient(scope, sourceIdentity);
        if (patient is null) throw new ProcessingException("WAITING_PATIENT_IDENTITY");
        if (patient.State != "VERIFIED") throw new ProcessingException("PATIENT_IDENTITY_REVIEW_REQUIRED");
        return policy.PseudonymisePatientIdentifiers ? new(policy.PseudonymSystem!, patient.Pseudonym) : sourceIdentity;
    }
}
