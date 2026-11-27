using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Modeller.Core;
namespace Modeller.Application;

// Installation-only maintenance for the application's internal audit store.
// No source profile, source connection or HTTP/MCP operation enters this path.
public sealed partial class AuditLedger
{
    private sealed record StoredEvent(string Tenant, string Subject, int Sequence, string Project, string Raw, string Hash);
    private static (long Events, long Subjects) VerifiedRows(DbConnection database, Action<StoredEvent>? visit = null)
    {
        using var command = database.CreateCommand(); command.CommandTimeout = 15;
        command.CommandText = "SELECT tenant,subject,sequence,project,event,hash FROM governance_events ORDER BY tenant,subject,sequence";
        using var reader = command.ExecuteReader();
        string? identity = null, project = null; var previous = new string('0', 64); var sequence = 0; long rows = 0, subjects = 0;
        while (reader.Read()) {
            var row = new StoredEvent(reader.GetString(0), reader.GetString(1), reader.GetInt32(2), reader.GetString(3), reader.GetString(4), reader.GetString(5));
            Identity(row.Tenant, row.Subject); ProjectId(row.Project);
            if (++rows > 1000000 || Encoding.UTF8.GetByteCount(row.Raw) > 65536) throw new ProcessingException("GOVERNANCE_MAINTENANCE_LIMIT");
            var current = row.Tenant + "\n" + row.Subject;
            if (current != identity) { identity = current; project = row.Project; previous = new string('0', 64); sequence = 0; subjects++; }
            var value = Data.ParseStrict(Encoding.UTF8.GetBytes(row.Raw)) as JsonObject ?? throw new ProcessingException("GOVERNANCE_AUDIT_INTEGRITY_FAILED");
            if (++sequence > 256 || sequence != row.Sequence || row.Project != project || value["tenant"]?.GetValue<string>() != row.Tenant || value["subject"]?.GetValue<string>() != row.Subject || value["project"]?.GetValue<string>() != row.Project || value["sequence"]?.GetValue<int>() != row.Sequence || value["previous_hash"]?.GetValue<string>() != previous || Data.Hash(row.Raw) != row.Hash) throw new ProcessingException("GOVERNANCE_AUDIT_INTEGRITY_FAILED");
            visit?.Invoke(row); previous = row.Hash;
        }
        return (rows, subjects);
    }
    public JsonObject InspectStorage()
    {
        var observed = VerifiedRows(connection);
        return new JsonObject { ["status"] = "PASS", ["driver"] = postgres ? "postgres" : "sqlite", ["events"] = observed.Events, ["subjects"] = observed.Subjects, ["hashChainsVerified"] = true, ["scope"] = "Internal application audit metadata; observed reads, not clinical approval." };
    }
    private JsonObject ImportInternalSqlite(string sourcePath)
    {
        if (!postgres) throw new ProcessingException("GOVERNANCE_POSTGRES_REQUIRED");
        if (!Path.IsPathFullyQualified(sourcePath) || !File.Exists(sourcePath)) throw new ProcessingException("GOVERNANCE_SQLITE_SOURCE_REQUIRED");
        SnapshotRepository.Safe(sourcePath);
        var backupPath = sourcePath + ".cutover-" + DateTimeOffset.UtcNow.ToString("yyyyMMddTHHmmssZ", CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N") + ".sqlite";
        using (var source = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = sourcePath, Mode = SqliteOpenMode.ReadOnly, DefaultTimeout = 5 }.ConnectionString)) {
            source.Open();
            using var backup = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = backupPath, Mode = SqliteOpenMode.ReadWriteCreate }.ConnectionString); backup.Open();
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(backupPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            source.BackupDatabase(backup);
        }
        using var snapshot = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = backupPath, Mode = SqliteOpenMode.ReadOnly, DefaultTimeout = 5 }.ConnectionString); snapshot.Open();
        // Validate the complete consistent source before attempting an import.
        var expected = VerifiedRows(snapshot);
        Begin("internal-storage-cutover"); long inserted = 0, duplicates = 0, nonces = 0;
        try {
            using (var guard = Command("LOCK TABLE governance_events,governance_nonces IN SHARE ROW EXCLUSIVE MODE")) guard.ExecuteNonQuery();
            VerifiedRows(snapshot, row => {
                using var current = Command("SELECT project,event,hash FROM governance_events WHERE tenant=@p0 AND subject=@p1 AND sequence=@p2", row.Tenant, row.Subject, row.Sequence);
                using (var reader = current.ExecuteReader()) {
                    if (reader.Read()) {
                        if (reader.GetString(0) != row.Project || reader.GetString(1) != row.Raw || reader.GetString(2) != row.Hash) throw new ProcessingException("GOVERNANCE_MIGRATION_CONFLICT");
                        duplicates++; return;
                    }
                }
                using var insert = Command("INSERT INTO governance_events(tenant,subject,sequence,project,event,hash) VALUES(@p0,@p1,@p2,@p3,@p4,@p5)", row.Tenant, row.Subject, row.Sequence, row.Project, row.Raw, row.Hash);
                if (insert.ExecuteNonQuery() != 1) throw new ProcessingException("GOVERNANCE_MIGRATION_FAILED"); inserted++;
            });
            var actual = VerifiedRows(connection);
            if (actual != expected) throw new ProcessingException("GOVERNANCE_MIGRATION_DESTINATION_DIVERGED");
            using var exists = snapshot.CreateCommand(); exists.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='governance_nonces'";
            if (Convert.ToInt64(exists.ExecuteScalar(), CultureInfo.InvariantCulture) == 1) {
                using var query = snapshot.CreateCommand(); query.CommandText = "SELECT nonce,expires FROM governance_nonces WHERE expires>=@now"; query.Parameters.AddWithValue("@now", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                using var reader = query.ExecuteReader();
                while (reader.Read()) {
                    if (++nonces > 10000) throw new ProcessingException("GOVERNANCE_ASSERTION_LIMIT_EXCEEDED");
                    var nonce = reader.GetString(0); var expiry = reader.GetInt64(1);
                    if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[a-f0-9]{64}$")) throw new ProcessingException("GOVERNANCE_AUDIT_INTEGRITY_FAILED");
                    using var insert = Command("INSERT INTO governance_nonces(nonce,expires) VALUES(@p0,@p1) ON CONFLICT(nonce) DO UPDATE SET expires=GREATEST(governance_nonces.expires,excluded.expires)", nonce, expiry); insert.ExecuteNonQuery();
                }
            }
            Finish(true);
        } catch { Finish(false); throw; }
        using var backupFile = File.OpenRead(backupPath);
        return new JsonObject { ["status"] = "PASS", ["driver"] = "postgres", ["events"] = expected.Events, ["subjects"] = expected.Subjects, ["inserted"] = inserted, ["existingIdentical"] = duplicates, ["activeNoncesPreserved"] = nonces, ["backup"] = backupPath, ["backupSha256"] = Convert.ToHexStringLower(SHA256.HashData(backupFile)), ["originalRetained"] = true, ["hashChainsVerified"] = true, ["scope"] = "Internal application audit storage only; exact event bytes/hashes retained, no clinical/source connection." };
    }
    public static int StorageCommand(string[] arguments)
    {
        try {
            if (arguments.Length is < 1 or > 2 || arguments[0] is not ("check" or "verify" or "cutover" or "import-sqlite") || arguments[0] != "import-sqlite" && arguments.Length != 1 || arguments[0] == "import-sqlite" && arguments.Length != 2) throw new ProcessingException("GOVERNANCE_STORAGE_COMMAND_INVALID");
            var action = arguments[0];
            using var ledger = new AuditLedger(false, action == "cutover");
            JsonObject result;
            if (action is "check" or "verify") result = ledger.InspectStorage();
            else {
                if (!ledger.postgres) throw new ProcessingException("GOVERNANCE_POSTGRES_REQUIRED");
                var source = action == "import-sqlite" ? arguments[1] : Environment.GetEnvironmentVariable("GOVERNANCE_DATABASE_PATH") ?? "/data/governance/audit.sqlite";
                result = File.Exists(source) ? ledger.ImportInternalSqlite(source) : action == "cutover" ? ledger.InspectStorage() : throw new ProcessingException("GOVERNANCE_SQLITE_SOURCE_REQUIRED");
            }
            Console.WriteLine(result.ToJsonString()); return 0;
        } catch (ProcessingException error) { Console.WriteLine(new JsonObject { ["status"] = "FAIL", ["error"] = error.Code }.ToJsonString()); return 1; }
        catch (Exception error) { Console.WriteLine(new JsonObject { ["status"] = "FAIL", ["error"] = "GOVERNANCE_STORAGE_MAINTENANCE_FAILED", ["failureKind"] = error.GetType().Name, ["databaseCode"] = error is Npgsql.PostgresException database ? database.SqlState : null }.ToJsonString()); return 1; }
    }
}
