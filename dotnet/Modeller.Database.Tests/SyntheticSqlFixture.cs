using Microsoft.Data.SqlClient;
using Modeller.Core;
using Modeller.Database;
using System.Text.Json;

// Deliberately separate from all runtime code. DDL/DML is used ONLY to construct an
// ephemeral synthetic CI database and prove database-side write denials.
internal static class SyntheticSqlFixture
{
    public static async Task Run(){
        if(Environment.GetEnvironmentVariable("MODELLER_SQL_SYNTHETIC_FIXTURE")!="ephemeral-loopback-only")throw new Exception("Synthetic fixture marker required");
        var port=int.Parse(Environment.GetEnvironmentVariable("MODELLER_SQL_FIXTURE_PORT")??"19433",System.Globalization.CultureInfo.InvariantCulture);if(port is <1024 or >65535)throw new Exception("Fixture port invalid");
        var password=Environment.GetEnvironmentVariable("MODELLER_SQL_FIXTURE_PASSWORD")??throw new Exception("Fixture password required");if(!System.Text.RegularExpressions.Regex.IsMatch(password,"^[A-Za-z0-9!_-]{20,80}$"))throw new Exception("Fixture password alphabet invalid");
        var checks=0;var builder=new SqlConnectionStringBuilder{DataSource="tcp:127.0.0.1,"+port,InitialCatalog="master",UserID="sa",Password=password,Encrypt=SqlConnectionEncryptOption.Mandatory,TrustServerCertificate=false,Pooling=false,ConnectTimeout=3};
        using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(2));await using var admin=new SqlConnection(builder.ConnectionString);await admin.OpenAsync(timeout.Token);
        async Task Admin(string sql){await using var cmd=admin.CreateCommand();cmd.CommandText=sql;cmd.CommandTimeout=10;await cmd.ExecuteNonQueryAsync(timeout.Token);}
        await Admin("CREATE DATABASE modeller_synthetic_fixture;");await Admin("USE modeller_synthetic_fixture;");
        await Admin("CREATE SCHEMA [vendor-x];");await Admin("CREATE TABLE [vendor-x].[A] ([id] bigint PRIMARY KEY, [label] nvarchar(100) NULL); CREATE TABLE [vendor-x].[B] ([id] bigint PRIMARY KEY, [subject_ref] bigint REFERENCES [vendor-x].[A](id), [value] decimal(12,3), [derived] AS ([value]*2)); INSERT INTO [vendor-x].[A] VALUES (1,N'Synthetic only'); INSERT INTO [vendor-x].[B] (id,subject_ref,value) VALUES (2,1,12.3);");
        await Admin("CREATE PROCEDURE [vendor-x].[mutate] AS DELETE FROM [vendor-x].[B];");
        foreach(var login in new[]{"fixture_reader","fixture_column_writer","fixture_executor","fixture_owner"}){await Admin("CREATE LOGIN ["+login+"] WITH PASSWORD='"+password+"', CHECK_POLICY=OFF; CREATE USER ["+login+"] FOR LOGIN ["+login+"]; GRANT SELECT, VIEW DEFINITION TO ["+login+"];");}
        await Admin("GRANT UPDATE ON OBJECT::[vendor-x].[B] ([value]) TO fixture_column_writer; GRANT EXECUTE ON OBJECT::[vendor-x].[mutate] TO fixture_executor; ALTER ROLE db_owner ADD MEMBER fixture_owner;");
        // Print only synthetic effective permission names to diagnose version-specific read grants.
        var diagnosticBuilder=new SqlConnectionStringBuilder(builder.ConnectionString){InitialCatalog="modeller_synthetic_fixture",UserID="fixture_reader"};
        await using(var diagnostic=new SqlConnection(diagnosticBuilder.ConnectionString)){await diagnostic.OpenAsync(timeout.Token);await using var cmd=diagnostic.CreateCommand();cmd.CommandText="SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE');";await using var rows=await cmd.ExecuteReaderAsync(timeout.Token);var names=new List<string>();while(await rows.ReadAsync(timeout.Token))names.Add(rows.GetString(0));Console.WriteLine(JsonSerializer.Serialize(new{syntheticDatabasePermissions=names}));}
        var profile=new SqlSourceProfile("127.0.0.1",port,"modeller_synthetic_fixture","fixture_reader",password,"shared",["synthetic"]);
        await using(var source=await SqlServerSource.Open(profile,timeout.Token)){var schema=await source.Discover(timeout.Token);if(schema.Tables.Length!=2||schema.Keys.Length!=1||schema.Tables.Single(t=>t.Name=="B").Columns.Single(c=>c.Name=="derived").Computed!=true)throw new Exception("Live metadata mismatch");checks++;var root=schema.Tables.Single(t=>t.Name=="B");var compiled=SourcePlanCompiler.Compile(schema,new(schema.Fingerprint,root.Id,[new(root.Id,root.Columns.Single(c=>c.Name=="value").Id,"value")],[],[],10));if(!compiled.Sql.StartsWith("SELECT TOP",StringComparison.Ordinal))throw new Exception("SELECT shape");checks++;}
        foreach(var login in new[]{"fixture_column_writer","fixture_executor","fixture_owner"}){try{await using var ignored=await SqlServerSource.Open(profile with{User=login},timeout.Token);throw new Exception("Write-capable login accepted");}catch(ProcessingException e)when(e.Code=="SOURCE_WRITE_PERMISSION_DENIED"){checks++;}}
        builder.InitialCatalog="modeller_synthetic_fixture";builder.UserID="fixture_reader";await using(var reader=new SqlConnection(builder.ConnectionString)){await reader.OpenAsync(timeout.Token);foreach(var sql in new[]{"INSERT INTO [vendor-x].[A] VALUES (99,N'Synthetic denial test');","UPDATE [vendor-x].[B] SET [value]=99;","DELETE FROM [vendor-x].[B];","CREATE TABLE dbo.forbidden_fixture (id int);","ALTER TABLE [vendor-x].[B] ADD forbidden_column int;","EXEC [vendor-x].[mutate];"}){await using var cmd=reader.CreateCommand();cmd.CommandText=sql;try{await cmd.ExecuteNonQueryAsync(timeout.Token);throw new Exception("Database accepted forbidden fixture operation");}catch(SqlException e)when(e.Number is 229 or 262 or 15151||e.Number==1088&&sql.StartsWith("ALTER TABLE",StringComparison.Ordinal)){checks++;}}}
        await using(var verify=admin.CreateCommand()){verify.CommandText="SELECT COUNT(*) FROM [vendor-x].[B] WHERE id=2 AND [value]=12.3;";if(Convert.ToInt32(await verify.ExecuteScalarAsync(timeout.Token),System.Globalization.CultureInfo.InvariantCulture)!=1)throw new Exception("Synthetic source was mutated");checks++;}
        // A newly granted permission must invalidate an already-open source on the next operation.
        await using(var source=await SqlServerSource.Open(profile,timeout.Token)){await Admin("GRANT UPDATE ON OBJECT::[vendor-x].[B] ([value]) TO fixture_reader;");try{await source.Discover(timeout.Token);throw new Exception("Permission drift accepted");}catch(ProcessingException e)when(e.Code=="SOURCE_WRITE_PERMISSION_DENIED"){checks++;}}
        Console.WriteLine(JsonSerializer.Serialize(new{suite="sql-server-synthetic-permissions-and-discovery",status="PASS",checks,clinicalData=false,tlsCertificateVerified=true}));
    }
}
