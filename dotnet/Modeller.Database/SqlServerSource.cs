using System.Data;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Modeller.Core;
namespace Modeller.Database;

public sealed record SqlSourceProfile(string Host,int Port,string Database,string User,string Password,string Tenant,string[] Projects)
{
    public static SqlSourceProfile Load(string directory,string id,string tenant,string project){
        if(!Regex.IsMatch(id,"^[a-z][a-z0-9-]{0,63}$")||!Path.IsPathFullyQualified(directory))throw new ProcessingException("SOURCE_PROFILE_INVALID");
        var full=Path.Combine(directory,id+".json");var current=new FileInfo(full);for(FileSystemInfo? part=current;part is not null;part=part is FileInfo file?file.Directory:((DirectoryInfo)part).Parent)if(part.LinkTarget is not null)throw new ProcessingException("SOURCE_PROFILE_UNSAFE");
        if(!current.Exists||current.Length>32768)throw new ProcessingException("SOURCE_PROFILE_UNAVAILABLE");
        if(!OperatingSystem.IsWindows()&&(File.GetUnixFileMode(full)&(UnixFileMode.GroupRead|UnixFileMode.GroupWrite|UnixFileMode.GroupExecute|UnixFileMode.OtherRead|UnixFileMode.OtherWrite|UnixFileMode.OtherExecute))!=0)throw new ProcessingException("SOURCE_PROFILE_UNSAFE");
        SqlSourceProfile profile;try{using var json=JsonDocument.Parse(File.ReadAllText(full));var keys=json.RootElement.EnumerateObject().Select(p=>p.Name).ToArray();var allowed=new[]{"host","port","database","user","password","tenant","projects"};if(keys.Distinct().Count()!=keys.Length||keys.Except(allowed).Any()||allowed.Except(keys).Any())throw new ProcessingException("SOURCE_PROFILE_INVALID");profile=JsonSerializer.Deserialize<SqlSourceProfile>(json.RootElement.GetRawText(),new JsonSerializerOptions{PropertyNameCaseInsensitive=true})??throw new ProcessingException("SOURCE_PROFILE_INVALID");}catch(JsonException){throw new ProcessingException("SOURCE_PROFILE_INVALID");}
        if(profile.Tenant!=tenant||!profile.Projects.Contains(project,StringComparer.Ordinal))throw new ProcessingException("SOURCE_PROFILE_ACCESS_DENIED");
        if(profile.Host.Length is <1 or >253||!Regex.IsMatch(profile.Host,"^[A-Za-z0-9][A-Za-z0-9.-]*$")||profile.Port is <1 or >65535||profile.Database.Length is <1 or >128||profile.User.Length is <1 or >128||profile.Password.Length is <1 or >1024)throw new ProcessingException("SOURCE_PROFILE_INVALID");
        return profile;
    }
    public override string ToString()=>"SqlSourceProfile [credentials redacted]";
    internal string ConnectionString=>new SqlConnectionStringBuilder{DataSource="tcp:"+Host+","+Port,InitialCatalog=Database,UserID=User,Password=Password,Encrypt=SqlConnectionEncryptOption.Mandatory,TrustServerCertificate=false,ConnectTimeout=10,ApplicationIntent=ApplicationIntent.ReadOnly,ApplicationName="Hygeoniq Modeller read-only discovery",Pooling=false,MultipleActiveResultSets=false,PersistSecurityInfo=false}.ConnectionString;
}

// No ExecuteNonQuery API, caller SQL, stored-procedure execution or clinical-row MCP result exists here.
public sealed class SqlServerSource:IAsyncDisposable
{
    private readonly SqlConnection connection;private readonly List<SqlCommand> commands=[];
    private SqlServerSource(SqlConnection connection){this.connection=connection;}
    public static async Task<SqlServerSource> Open(SqlSourceProfile profile,CancellationToken cancellation){
        var connection=new SqlConnection(profile.ConnectionString);try{await connection.OpenAsync(cancellation);var source=new SqlServerSource(connection);await source.VerifyReadOnly(cancellation);return source;}catch{await connection.DisposeAsync();throw;}
    }
    public async ValueTask DisposeAsync(){foreach(var command in commands)command.Dispose();await connection.DisposeAsync();}
    private async Task<SqlDataReader> Read(string sql,CancellationToken cancellation){var cmd=connection.CreateCommand();commands.Add(cmd);cmd.CommandText=sql;cmd.CommandTimeout=15;try{return await cmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess,cancellation);}catch{cmd.Dispose();throw;}}
    // Fail closed on unknown effective permissions. VIEW DEFINITION is mandatory so object checks
    // cannot silently omit objects hidden by metadata visibility. No source permissions are changed.
    public async Task VerifyReadOnly(CancellationToken cancellation){
        var databaseAllowed=new HashSet<string>(["CONNECT","SELECT","VIEW DEFINITION","SHOWPLAN","VIEW DATABASE STATE","VIEW DATABASE PERFORMANCE STATE","VIEW DATABASE SECURITY STATE"],StringComparer.Ordinal);
        var serverAllowed=new HashSet<string>(["CONNECT SQL","VIEW ANY DATABASE","VIEW SERVER STATE","VIEW SERVER PERFORMANCE STATE","VIEW SERVER SECURITY STATE","VIEW ANY DEFINITION","VIEW ANY SECURITY DEFINITION","VIEW ANY PERFORMANCE DEFINITION"],StringComparer.Ordinal);
        var objectAllowed=new HashSet<string>(["SELECT","VIEW DEFINITION","VIEW SECURITY DEFINITION","VIEW PERFORMANCE DEFINITION"],StringComparer.Ordinal);
        await using(var r=await Read("SELECT permission_name FROM sys.fn_my_permissions(NULL, 'SERVER');",cancellation)){while(await r.ReadAsync(cancellation))if(!serverAllowed.Contains(r.GetString(0)))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");}
        var definition=false;await using(var r=await Read("SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE');",cancellation)){while(await r.ReadAsync(cancellation)){var permission=r.GetString(0);definition|=permission=="VIEW DEFINITION";if(!databaseAllowed.Contains(permission))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");}}
        if(!definition)throw new ProcessingException("SOURCE_METADATA_PERMISSION_REQUIRED");
        const string permissions="SELECT p.permission_name FROM sys.objects o CROSS APPLY sys.fn_my_permissions(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name), 'OBJECT') p WHERE o.is_ms_shipped=0 UNION ALL SELECT p.permission_name FROM sys.schemas s CROSS APPLY sys.fn_my_permissions(QUOTENAME(s.name), 'SCHEMA') p WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA');";
        await using(var r=await Read(permissions,cancellation)){while(await r.ReadAsync(cancellation))if(!objectAllowed.Contains(r.GetString(0)))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");}
        // A column-level UPDATE grant can be absent from the containing object's permission list.
        const string columns="SELECT TOP (1) 1 FROM sys.columns c JOIN sys.objects o ON o.object_id=c.object_id WHERE o.is_ms_shipped=0 AND (HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','UPDATE',c.name,'COLUMN')=1 OR HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id))+'.'+QUOTENAME(o.name),'OBJECT','REFERENCES',c.name,'COLUMN')=1);";
        await using(var r=await Read(columns,cancellation))if(await r.ReadAsync(cancellation))throw new ProcessingException("SOURCE_WRITE_PERMISSION_DENIED");
    }
    public async Task<SchemaCatalogue> Discover(CancellationToken cancellation){
        await VerifyReadOnly(cancellation);var tables=new Dictionary<int,(string Schema,string Name,List<SourceColumn> Columns)>();
        const string columns="SELECT t.object_id,s.name,t.name,c.column_id,c.name,ty.name,c.is_nullable,c.is_computed,COALESCE(pk.key_ordinal,0) FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.system_type_id AND ty.user_type_id=ty.system_type_id OUTER APPLY (SELECT ic.key_ordinal FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=t.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) pk WHERE t.is_ms_shipped=0 AND t.is_external=0 ORDER BY t.object_id,c.column_id;";
        var count=0;await using(var r=await Read(columns,cancellation)){while(await r.ReadAsync(cancellation)){if(++count>100000)throw new ProcessingException("SOURCE_CATALOGUE_LIMIT");var id=r.GetInt32(0);if(!tables.TryGetValue(id,out var t)){if(tables.Count>=10000)throw new ProcessingException("SOURCE_CATALOGUE_LIMIT");t=(r.GetString(1),r.GetString(2),[]);tables.Add(id,t);}t.Columns.Add(new(r.GetInt32(3),r.GetString(4),r.GetString(5),r.GetBoolean(6),r.GetBoolean(7),Convert.ToInt32(r.GetValue(8),System.Globalization.CultureInfo.InvariantCulture)));}}
        var keys=new Dictionary<int,(int From,int To,bool Disabled,bool Untrusted,List<int> A,List<int> B)>();
        const string foreignKeys="SELECT f.object_id,f.parent_object_id,f.referenced_object_id,f.is_disabled,f.is_not_trusted,c.parent_column_id,c.referenced_column_id FROM sys.foreign_keys f JOIN sys.foreign_key_columns c ON c.constraint_object_id=f.object_id ORDER BY f.object_id,c.constraint_column_id;";
        count=0;await using(var r=await Read(foreignKeys,cancellation)){while(await r.ReadAsync(cancellation)){if(++count>100000)throw new ProcessingException("SOURCE_CATALOGUE_LIMIT");var id=r.GetInt32(0);if(!keys.TryGetValue(id,out var k)){k=(r.GetInt32(1),r.GetInt32(2),r.GetBoolean(3),r.GetBoolean(4),[],[]);keys.Add(id,k);}k.A.Add(r.GetInt32(5));k.B.Add(r.GetInt32(6));}}
        return new(tables.OrderBy(p=>p.Key).Select(p=>new SourceTable(p.Key,p.Value.Schema,p.Value.Name,p.Value.Columns.ToArray())).ToArray(),keys.OrderBy(p=>p.Key).Where(p=>tables.ContainsKey(p.Value.From)&&tables.ContainsKey(p.Value.To)).Select(p=>new SourceKey(p.Key,p.Value.From,p.Value.A.ToArray(),p.Value.To,p.Value.B.ToArray(),p.Value.Disabled,p.Value.Untrusted)).ToArray());
    }
}
