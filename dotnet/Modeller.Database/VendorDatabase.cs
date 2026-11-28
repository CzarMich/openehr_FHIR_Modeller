using System.Data;
using System.Data.Common;
using System.Data.Odbc;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using MySqlConnector;
using Npgsql;
using Oracle.ManagedDataAccess.Client;
using Modeller.Core;
namespace Modeller.Database;

public sealed record VendorProfile(string Connector,string Host,int Port,string Database,string User,string Password,string Tenant,string[] Projects,string[] Schemas,string? DriverSha256=null)
{
    public string Dialect=>Connector switch { "epic-clarity-sqlserver"=>"sqlserver", "epic-clarity-oracle"=>"oracle", _=>Connector };
    public override string ToString()=>"VendorProfile [credentials redacted]";
    public void Validate(){
        if(Dialect is not("sqlserver" or "oracle" or "postgresql" or "mysql" or "mariadb" or "sap-hana")||!Regex.IsMatch(Host??"","^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$")||Port is <1 or >65535||string.IsNullOrWhiteSpace(Database)||Database.Length>128||string.IsNullOrWhiteSpace(User)||User.Length>128||string.IsNullOrEmpty(Password)||Password.Length>4096||Projects is null||Projects.Length is <1 or >100||Schemas is null||Schemas.Length is <1 or >100||Schemas.Any(s=>string.IsNullOrWhiteSpace(s)||s.Length>128||s.Any(char.IsControl)))throw new ProcessingException("SOURCE_PROFILE_INVALID");
        if(Dialect=="oracle"&&!Regex.IsMatch(Database,"^[A-Za-z0-9_.-]+$"))throw new ProcessingException("SOURCE_PROFILE_INVALID");
    }
    public static VendorProfile Load(string directory,string id,string tenant,string project){
        var full=ProfileFile(directory,id);
        var node=Data.ParseStrict(File.ReadAllBytes(full)) as JsonObject??throw new ProcessingException("SOURCE_PROFILE_INVALID");
        Data.Keys(node,"connector","host","port","database","user","password","tenant","projects","schemas","driverSha256");
        var profile=node.Deserialize<VendorProfile>(Data.Json)??throw new ProcessingException("SOURCE_PROFILE_INVALID");profile.Validate();
        if(profile.Tenant!=tenant||!profile.Projects.Contains(project,StringComparer.Ordinal))throw new ProcessingException("SOURCE_PROFILE_ACCESS_DENIED");return profile;
    }
    public static string ProfileFile(string directory,string id){
        if(!Path.IsPathFullyQualified(directory)||!Regex.IsMatch(id,"^[a-z][a-z0-9-]{0,63}$"))throw new ProcessingException("SOURCE_PROFILE_INVALID");
        var file=new FileInfo(Path.Combine(directory,id+".json"));
        for(FileSystemInfo? part=file;part is not null;part=part is FileInfo item?item.Directory:((DirectoryInfo)part).Parent)if(part.LinkTarget is not null)throw new ProcessingException("SOURCE_PROFILE_UNSAFE");
        if(!file.Exists||file.Length>65536)throw new ProcessingException("SOURCE_PROFILE_UNAVAILABLE");
        if(!OperatingSystem.IsWindows()&&(File.GetUnixFileMode(file.FullName)&(UnixFileMode.GroupRead|UnixFileMode.GroupWrite|UnixFileMode.OtherRead|UnixFileMode.OtherWrite|UnixFileMode.OtherExecute))!=0)throw new ProcessingException("SOURCE_PROFILE_UNSAFE");return file.FullName;
    }
    public DbConnection Connection(){
        Validate();
        if(Dialect=="oracle"&&Environment.GetEnvironmentVariable("MODELLER_ORACLE_TNS_ADMIN") is string tns){if(!Path.IsPathFullyQualified(tns)||!Directory.Exists(tns))throw new ProcessingException("SOURCE_ORACLE_TRUST_CONFIGURATION_INVALID");OracleConfiguration.TnsAdmin=tns;}
        return Dialect switch {
            "sqlserver"=>new SqlConnection(new SqlConnectionStringBuilder {DataSource="tcp:"+Host+","+Port,InitialCatalog=Database,UserID=User,Password=Password,Encrypt=SqlConnectionEncryptOption.Mandatory,TrustServerCertificate=false,ConnectTimeout=10,ApplicationIntent=ApplicationIntent.ReadOnly,Pooling=false,PersistSecurityInfo=false}.ConnectionString),
            "postgresql"=>new NpgsqlConnection(new NpgsqlConnectionStringBuilder {Host=Host,Port=Port,Database=Database,Username=User,Password=Password,SslMode=SslMode.VerifyFull,Timeout=10,CommandTimeout=30,Pooling=false,IncludeErrorDetail=false,RootCertificate=Environment.GetEnvironmentVariable("HTTP_CA_BUNDLE")}.ConnectionString),
            "mysql" or "mariadb"=>new MySqlConnection(new MySqlConnectionStringBuilder {Server=Host,Port=(uint)Port,Database=Database,UserID=User,Password=Password,SslMode=MySqlSslMode.VerifyFull,ConnectionTimeout=10,DefaultCommandTimeout=30,Pooling=false,AllowLoadLocalInfile=false,AllowPublicKeyRetrieval=false,PersistSecurityInfo=false,SslCa=Environment.GetEnvironmentVariable("HTTP_CA_BUNDLE")??""}.ConnectionString),
            "oracle"=>new OracleConnection(new OracleConnectionStringBuilder {DataSource="(DESCRIPTION=(TRANSPORT_CONNECT_TIMEOUT=10)(ADDRESS=(PROTOCOL=TCPS)(HOST="+Host+")(PORT="+Port+"))(CONNECT_DATA=(SERVICE_NAME="+Database+"))(SECURITY=(SSL_SERVER_DN_MATCH=YES)))",UserID=User,Password=Password,Pooling=false,ConnectionTimeout=10,PersistSecurityInfo=false}.ConnectionString),
            "sap-hana"=>Hana(),_=>throw new ProcessingException("SOURCE_CONNECTOR_UNKNOWN")};
    }
    private DbConnection Hana(){
        var path=Environment.GetEnvironmentVariable("MODELLER_HANA_ODBC_DRIVER");
        if(path is null||!Path.IsPathFullyQualified(path)||!File.Exists(path)||new FileInfo(path).LinkTarget is not null||DriverSha256 is null||!Regex.IsMatch(DriverSha256,"^[a-f0-9]{64}$")||Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)))!=DriverSha256)throw new ProcessingException("SOURCE_HANA_DRIVER_REQUIRED");
        var b=new OdbcConnectionStringBuilder {Driver=path};b["ServerNode"]=Host+":"+Port;b["UID"]=User;b["PWD"]=Password;b["Encrypt"]="true";b["sslValidateCertificate"]="true";b["sslHostNameInCertificate"]=Host;b["sslTrustStore"]=Environment.GetEnvironmentVariable("HTTP_CA_BUNDLE")??"/etc/ssl/certs/ca-certificates.crt";
        return new OdbcConnection(b.ConnectionString);
    }
}

public sealed record SourceCursor(int Table,int Column,string Field);
public sealed record DatabaseWindow(JsonArray Records,bool HasMore);

public interface IReadOnlySource:IAsyncDisposable
{
    Task<SchemaCatalogue> Discover(CancellationToken cancellation);
    Task<JsonArray> Read(SourcePlan plan,CancellationToken cancellation);
}

/// <summary>Only closed catalogue queries and compiler-generated SELECTs. No caller SQL/procedures.</summary>
public sealed class VendorDatabase:IReadOnlySource
{
    private readonly VendorProfile profile;private readonly DbConnection connection;private DbTransaction? transaction;private bool snapshotStarted;
    private VendorDatabase(VendorProfile profile,DbConnection connection){this.profile=profile;this.connection=connection;}
    public static async Task<VendorDatabase> Open(VendorProfile profile,CancellationToken cancellation){
        var connection=profile.Connection();var result=new VendorDatabase(profile,connection);
        try{await connection.OpenAsync(cancellation);await result.VerifyReadOnly(cancellation);await result.BeginReadOnly(cancellation);return result;}catch{await connection.DisposeAsync();throw;}
    }
    public async ValueTask DisposeAsync(){if(transaction is not null)await transaction.DisposeAsync();await connection.DisposeAsync();}
    private async Task<List<object[]>> Query(string sql,CancellationToken ct,params object[] values){
        await using var command=connection.CreateCommand();command.CommandText=sql;command.CommandTimeout=30;command.Transaction=transaction;
        for(var i=0;i<values.Length;i++){var p=command.CreateParameter();p.ParameterName=profile.Dialect=="oracle"?"p"+i:"@p"+i;p.Value=values[i];command.Parameters.Add(p);}
        if(command is OracleCommand oracle)oracle.BindByName=true;
        await using var reader=await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess,ct);var rows=new List<object[]>();
        while(await reader.ReadAsync(ct)){if(rows.Count>=100000)throw new ProcessingException("SOURCE_CATALOGUE_LIMIT");var row=new object[reader.FieldCount];reader.GetValues(row);rows.Add(row);}return rows;
    }
    private async Task Control(string sql,CancellationToken ct){await using var cmd=connection.CreateCommand();cmd.CommandText=sql;cmd.CommandTimeout=15;cmd.Transaction=transaction;await cmd.ExecuteNonQueryAsync(ct);}
    private async Task BeginReadOnly(CancellationToken ct){
        switch(profile.Dialect){
            case "postgresql":await Control("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",ct);break;
            case "oracle":await Control("SET TRANSACTION READ ONLY",ct);break;
            case "mysql":case "mariadb":await Control("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",ct);await Control("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY",ct);break;
            case "sap-hana":await Control("SET TRANSACTION READ ONLY",ct);transaction=await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead,ct);break;
            case "sqlserver":break; // Metadata discovery does not require a clinical-data transaction.
            default:throw new ProcessingException("SOURCE_CONNECTOR_UNKNOWN");
        }
    }
    private async Task EnsureSnapshot(CancellationToken ct){
        if(profile.Dialect!="sqlserver"||snapshotStarted)return;
        var state=await Query("SELECT snapshot_isolation_state FROM sys.databases WHERE name=DB_NAME()",ct);
        if(state.Count!=1||Convert.ToInt32(state[0][0])!=1)throw new ProcessingException("SOURCE_SNAPSHOT_ISOLATION_REQUIRED");
        await Control("SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION",ct);snapshotStarted=true;
    }
    private static string S(object value)=>Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture)??"";
    private static bool B(object value)=>Convert.ToBoolean(value,System.Globalization.CultureInfo.InvariantCulture);
    private async Task Empty(string sql,CancellationToken ct){if((await Query(sql,ct)).Count!=0)throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");}
    public async Task VerifyReadOnly(CancellationToken ct){
        switch(profile.Dialect){
            case "sqlserver":
                foreach(var level in new[]{"SERVER","DATABASE"}){
                    var allowed=level=="SERVER"?new[]{"CONNECT SQL","VIEW ANY DATABASE","VIEW SERVER STATE","VIEW SERVER PERFORMANCE STATE","VIEW SERVER SECURITY STATE","VIEW ANY DEFINITION","VIEW ANY SECURITY DEFINITION","VIEW ANY PERFORMANCE DEFINITION"}:new[]{"CONNECT","SELECT","VIEW DEFINITION","VIEW SECURITY DEFINITION","VIEW PERFORMANCE DEFINITION","VIEW ANY COLUMN ENCRYPTION KEY DEFINITION","VIEW ANY COLUMN MASTER KEY DEFINITION","SHOWPLAN","VIEW DATABASE STATE","VIEW DATABASE PERFORMANCE STATE","VIEW DATABASE SECURITY STATE"};
                    var sqlGrants=await Query("SELECT permission_name FROM sys.fn_my_permissions(NULL, '"+level+"')",ct);
                    if(sqlGrants.Any(row=>!allowed.Contains(S(row[0]),StringComparer.Ordinal))||level=="DATABASE"&&!sqlGrants.Any(row=>S(row[0])=="VIEW DEFINITION"))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");
                }
                var objectGrants=await Query("SELECT p.permission_name FROM sys.objects o CROSS APPLY sys.fn_my_permissions(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name), 'OBJECT') p WHERE o.is_ms_shipped=0 UNION ALL SELECT p.permission_name FROM sys.schemas s CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name), 'SCHEMA') p WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA')",ct);
                if(objectGrants.Any(row=>!new[]{"SELECT","VIEW DEFINITION","VIEW SECURITY DEFINITION","VIEW PERFORMANCE DEFINITION"}.Contains(S(row[0]),StringComparer.Ordinal)))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");
                await Empty("SELECT TOP (1) 1 FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id WHERE o.is_ms_shipped=0 AND (HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','UPDATE',c.name,'COLUMN')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','REFERENCES',c.name,'COLUMN')=1)",ct);break;
            case "postgresql":
                await Empty("SELECT 1 FROM pg_roles WHERE pg_has_role(oid,'MEMBER') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)",ct);
                await Empty("SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege(oid,'CREATE')",ct);
                await Empty("SELECT 1 WHERE has_database_privilege(current_database(),'CREATE') OR has_database_privilege(current_database(),'TEMP')",ct);
                await Empty("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))",ct);break;
            case "oracle":
                var system=await Query("SELECT PRIVILEGE FROM SESSION_PRIVS",ct);
                if(system.Any(row=>!new[]{"CREATE SESSION","SELECT ANY TABLE","SELECT ANY DICTIONARY","READ ANY TABLE"}.Contains(S(row[0]),StringComparer.Ordinal)))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");
                await Empty("SELECT 1 FROM USER_TABLES WHERE ROWNUM <= 1",ct);
                var grants=await Query("SELECT PRIVILEGE,GRANTABLE,OWNER,TYPE,GRANTEE FROM ALL_TAB_PRIVS_RECD",ct);
                if(grants.Any(row=>!ReadOnlyOracleGrant(S(row[0]),S(row[1]),S(row[2]),S(row[3]),S(row[4]))))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");
                var columnGrants=await Query("SELECT PRIVILEGE,GRANTABLE FROM ALL_COL_PRIVS_RECD",ct);
                if(columnGrants.Any(row=>S(row[0]) is not("SELECT" or "READ")||S(row[1])=="YES"))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");break;
            case "mysql":case "mariadb":
                // Role grants are refused: do not mistake an unexpanded grant for effective read-only rights.
                var mysql=await Query("SHOW GRANTS FOR CURRENT_USER",ct);
                if(mysql.Count==0||mysql.Any(row=>!ReadOnlyMySqlGrant(S(row[0]))))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");break;
            case "sap-hana":
                var hana=await Query("SELECT PRIVILEGE,IS_GRANTABLE,IS_VALID FROM SYS.EFFECTIVE_PRIVILEGES WHERE USER_NAME=CURRENT_USER",ct);
                if(hana.Count==0||hana.Any(row=>S(row[2])!="TRUE"||S(row[1])!="FALSE"||S(row[0]) is not("SELECT" or "CATALOG READ")))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");break;
            default:throw new ProcessingException("SOURCE_CONNECTOR_UNKNOWN");
        }
    }
    // Oracle's standard SYS/PUBLIC packages are not source procedure operations. The closed adapter never calls them.
    public static bool ReadOnlyOracleGrant(string privilege,string grantable,string owner,string type,string grantee)=>grantable=="NO"&&(privilege is "SELECT" or "READ" || privilege=="EXECUTE"&&owner=="SYS"&&grantee=="PUBLIC"&&type is "PACKAGE" or "TYPE" or "FUNCTION" or "PROCEDURE");
    public static bool ReadOnlyMySqlGrant(string grant)=>Regex.IsMatch(grant,"^GRANT (USAGE|SELECT(?: \\([^;]+\\))?|SHOW VIEW)(?:, (?:SELECT|SHOW VIEW))* ON (?:`(?:[^`]|``)+`|\\*)(?:\\.(?:`(?:[^`]|``)+`|\\*))? TO (?:'(?:[^']|'')*'|`(?:[^`]|``)*`)@(?:'(?:[^']|'')*'|`(?:[^`]|``)*`)(?: IDENTIFIED BY PASSWORD '[A-Za-z0-9*]+')?$",RegexOptions.CultureInvariant);
    private Task<List<object[]>> Catalogue(string sql,CancellationToken ct,bool keys=false){
        var parameters=profile.Schemas.Select((_,i)=>profile.Dialect=="oracle"?":p"+i:profile.Dialect=="sap-hana"?"?":"@p"+i);
        var names=keys?"c_schema,c_constraint,c_table,c_column,ref_schema,ref_table,ref_column,key_position,c_disabled,c_untrusted":"c_schema,c_table,c_ordinal,c_name,c_type,c_null,c_computed,c_key";
        return Query("WITH catalogue ("+names+") AS ("+sql+") SELECT * FROM catalogue WHERE c_schema IN ("+string.Join(',',parameters)+")",ct,profile.Schemas.Cast<object>().ToArray());
    }
    public async Task<SchemaCatalogue> Discover(CancellationToken ct){
        await VerifyReadOnly(ct);
        // Each row has schema, table, ordinal, column, physical type, nullable, computed, PK ordinal.
        var columns=await Catalogue(CatalogueSql.Columns(profile.Dialect),ct);
        var filtered=columns.Where(row=>profile.Schemas.Contains(S(row[0]),StringComparer.Ordinal)).ToArray();
        var groups=filtered.GroupBy(row=>(Schema:S(row[0]),Name:S(row[1]))).OrderBy(g=>g.Key.Schema,StringComparer.Ordinal).ThenBy(g=>g.Key.Name,StringComparer.Ordinal).ToArray();
        if(groups.Length>10000)throw new ProcessingException("SOURCE_CATALOGUE_LIMIT");
        var tables=groups.Select((g,index)=>new SourceTable(index+1,g.Key.Schema,g.Key.Name,g.OrderBy(row=>Convert.ToInt32(row[2])).Select(row=>new SourceColumn(Convert.ToInt32(row[2]),S(row[3]),S(row[4]),S(row[5]) is "YES" or "Y" or "1" or "True" or "TRUE",S(row[6]) is "YES" or "Y" or "1" or "True" or "TRUE",Convert.ToInt32(row[7]))).ToArray())).ToArray();
        var rawKeys=await Catalogue(CatalogueSql.Keys(profile.Dialect),ct,true);var keys=new List<SourceKey>();
        foreach(var group in rawKeys.GroupBy(row=>(Schema:S(row[0]),Name:S(row[1]))).OrderBy(g=>g.Key.Schema,StringComparer.Ordinal).ThenBy(g=>g.Key.Name,StringComparer.Ordinal)){
            var first=group.First();var from=tables.SingleOrDefault(t=>t.Schema==S(first[0])&&t.Name==S(first[2]));var to=tables.SingleOrDefault(t=>t.Schema==S(first[4])&&t.Name==S(first[5]));if(from is null||to is null)continue;
            var rows=group.OrderBy(row=>Convert.ToInt32(row[7])).ToArray();
            keys.Add(new(keys.Count+1,from.Id,rows.Select(row=>from.Columns.Single(c=>c.Name==S(row[3])).Id).ToArray(),to.Id,rows.Select(row=>to.Columns.Single(c=>c.Name==S(row[6])).Id).ToArray(),rows.Any(row=>S(row[8]) is "1" or "True"),rows.Any(row=>S(row[9]) is "1" or "True")));
        }
        return new(tables,keys.ToArray());
    }
    public async Task<JsonArray> Read(SourcePlan plan,CancellationToken ct)=>(await ReadWindow(plan,false,ct)).Records;
    public async Task<DatabaseWindow> ReadAppend(SourcePlan plan,SourceCursor cursor,JsonElement? after,CancellationToken ct){
        var schema=await Discover(ct);ValidateAppend(schema,plan,cursor);
        if(after is not null&&after.Value.ValueKind!=JsonValueKind.Null)plan=plan with{Filters=plan.Filters.Append(new SourceFilter(cursor.Table,cursor.Column,"gt",after)).ToArray()};
        return await ReadWindow(plan,true,ct);
    }
    public static void ValidateAppend(SchemaCatalogue schema,SourcePlan plan,SourceCursor cursor){
        if(plan.Filters.Length>=32)throw new ProcessingException("SOURCE_PLAN_LIMIT");
var root=schema.Table(plan.Root);var keys=root.Columns.Where(column=>column.KeyOrdinal>0).ToArray();
        if(cursor.Table!=root.Id||keys.Length!=1||keys[0].Id!=cursor.Column||keys[0].Nullable||!new[]{"bigint","int8","int","integer","int4","smallint","int2","tinyint","decimal","numeric","number"}.Contains(keys[0].Type.ToLowerInvariant(),StringComparer.Ordinal)||!plan.Fields.Any(field=>field.Table==cursor.Table&&field.Column==cursor.Column&&field.Field==cursor.Field&&field.Representation=="native"))throw new ProcessingException("SOURCE_APPEND_CURSOR_REQUIRES_UNIQUE_NATIVE_NUMERIC_KEY");
        var known=new HashSet<int>{root.Id};foreach(var join in plan.Joins){var key=schema.Keys.Single(item=>item.Id==join.Key);if(!known.Contains(key.FromTable)||known.Contains(key.ToTable))throw new ProcessingException("SOURCE_APPEND_TO_MANY_JOIN_DENIED");known.Add(key.ToTable);}
    }
    private async Task<DatabaseWindow> ReadWindow(SourcePlan plan,bool allowMore,CancellationToken ct){
        await EnsureSnapshot(ct);var schema=await Discover(ct);if(plan.Limit>9999)throw new ProcessingException("SOURCE_PRIVATE_WINDOW_LIMIT");var compiled=SourcePlanCompiler.Compile(schema,plan with { Limit=plan.Limit+1 },profile.Dialect);
        await using var cmd=connection.CreateCommand();cmd.CommandText=compiled.Sql;cmd.CommandTimeout=45;cmd.Transaction=transaction;if(cmd is OracleCommand oracle)oracle.BindByName=true;
        foreach(var value in compiled.Parameters){var p=cmd.CreateParameter();p.ParameterName=value.Name.TrimStart(':');p.Value=value.Value;cmd.Parameters.Add(p);}
        var rows=new JsonArray();long bytes=2;
        await using var reader=await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess,ct);
        while(await reader.ReadAsync(ct)){
            if(rows.Count>=plan.Limit){if(allowMore)return new(rows,true);throw new ProcessingException("SOURCE_WINDOW_INCOMPLETE");}var row=new JsonObject();
            for(var i=0;i<reader.FieldCount;i++){
                var value=reader.GetValue(i);
                if(plan.Fields[i].Representation=="string" && value is not DBNull) { if(value is byte[])throw new ProcessingException("SOURCE_BINARY_FIELD_REQUIRES_REVIEW");value=Convert.ToString(value,System.Globalization.CultureInfo.InvariantCulture)??""; }
                row[reader.GetName(i)]=value switch {DBNull=>null,byte[]=>throw new ProcessingException("SOURCE_BINARY_FIELD_REQUIRES_REVIEW"),DateTime date=>JsonValue.Create(date.ToString("O",System.Globalization.CultureInfo.InvariantCulture)),DateTimeOffset date=>JsonValue.Create(date.ToString("O",System.Globalization.CultureInfo.InvariantCulture)),string s when s.Length<=1048576=>JsonValue.Create(s),string=>throw new ProcessingException("SOURCE_FIELD_LIMIT"),bool b=>JsonValue.Create(b),byte or sbyte or short or ushort or int or uint or long or ulong or decimal or float or double=>JsonSerializer.SerializeToNode(value),Guid guid=>JsonValue.Create(guid.ToString()),_=>throw new ProcessingException("SOURCE_TYPE_REQUIRES_REVIEW")};
            }
            bytes+=System.Text.Encoding.UTF8.GetByteCount(row.ToJsonString());if(bytes>64*1048576)throw new ProcessingException("SOURCE_BATCH_LIMIT");rows.Add(row);
        }
        return new(rows,false);
    }
}
