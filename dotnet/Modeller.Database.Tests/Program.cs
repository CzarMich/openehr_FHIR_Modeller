using System.Text.Json;
using Modeller.Core;
using Modeller.Database;
if(args.Contains("--synthetic-sql-fixture")){await SyntheticSqlFixture.Run();return;}
var checks=0;
void Check(bool value,string message){if(!value)throw new Exception(message);checks++;}
void Reject(Action action,string code){try{action();throw new Exception("Expected "+code);}catch(ProcessingException e){Check(e.Code==code,"Expected "+code+" got "+e.Code);}}
JsonElement Value(string value)=>JsonSerializer.SerializeToElement(value);
var schema=new SchemaCatalogue([
    new(41,"vendor-A","X]01",[new(1,"record]key","bigint",false,false,1),new(2,"subject_ref","bigint",false,false,0),new(3,"raw_text","nvarchar",true,false,0),new(4,"calculated","int",false,true,0)]),
    new(99,"site_B","subjects",[new(1,"key","bigint",false,false,1),new(2,"identifier","nvarchar",false,false,0)]),
    new(107,"other","no-key",[new(1,"text","nvarchar",false,false,0)])
],[new(7,41,[2],99,[1],false,false)]);
var plan=new SourcePlan(schema.Fingerprint,41,[new(41,1,"recordId"),new(99,2,"subject")],[new(7,"left")],[new(41,3,"eq",Value("x'; DROP TABLE anything;--"))],100);
var sql=SourcePlanCompiler.Compile(schema,plan);
Check(sql.Sql.StartsWith("SELECT TOP (@rowLimit) t0.[record]]key] AS [recordId]",StringComparison.Ordinal),"Quote vendor-specific identifiers");
Check(sql.Sql.Contains("[vendor-A].[X]]01] t0 LEFT JOIN [site_B].[subjects] t1 ON t0.[subject_ref] = t1.[key]",StringComparison.Ordinal),"Declared cross-schema foreign key");
Check(!sql.Sql.Contains("DROP TABLE",StringComparison.Ordinal)&&sql.Parameters[0].Value.Equals("x'; DROP TABLE anything;--"),"Filters always parameterized");
Check(sql.Parameters[^1].Value.Equals(100),"Bounded row limit parameter");
Check(schema.Search("subject").Length==2&&schema.Search("notfound").Length==0,"Search real metadata without assuming clinical tables");
Check(schema.Search("",41,1).Single().Id==99,"Stable metadata paging");
Reject(()=>schema.Search("",0,51),"SOURCE_DISCOVERY_LIMIT");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{SchemaFingerprint=new string('0',64)}),"SOURCE_SCHEMA_CHANGED");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Root=1}),"SOURCE_TABLE_UNKNOWN");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Fields=[new(41,22,"field")]}),"SOURCE_COLUMN_UNKNOWN");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Fields=[new(41,4,"field")]}),"SOURCE_COMPUTED_COLUMN_DENIED");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Fields=[new(41,1,"invalid]; DROP TABLE x")]}),"SOURCE_FIELD_INVALID");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Fields=[new(41,1,"same"),new(41,2,"SAME")]}),"SOURCE_FIELD_INVALID");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Joins=[]}),"SOURCE_TABLE_NOT_JOINED");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Joins=[new(7,"cross")]}),"SOURCE_JOIN_UNSUPPORTED");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Joins=[new(123,"inner")]}),"SOURCE_KEY_UNKNOWN");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Joins=[new(7,"inner"),new(7,"inner")]}),"SOURCE_JOIN_DISCONNECTED");
Reject(()=>SourcePlanCompiler.Compile(schema with{Keys=[schema.Keys[0] with{Untrusted=true}]},plan with{SchemaFingerprint=(schema with{Keys=[schema.Keys[0] with{Untrusted=true}]}).Fingerprint}),"SOURCE_KEY_UNQUALIFIED");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Limit=10001}),"SOURCE_PLAN_LIMIT");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Filters=[new(41,1,"execute",Value("any"))]}),"SOURCE_FILTER_INVALID");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Filters=[new(41,1,"eq",Value("1 OR 1=1"))]}),"SOURCE_FILTER_INVALID");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Filters=[new(41,1,"is-null",Value("value"))]}),"SOURCE_FILTER_INVALID");
Reject(()=>SourcePlanCompiler.Compile(schema,plan with{Root=107,Fields=[new(107,1,"text")],Joins=[],Filters=[]}),"SOURCE_STABLE_KEY_REQUIRED");
var config=new SqlSourceProfile("db.internal",1433,"clinical","reader","synthetic-secret","shared",["fixture"]);
Check(!config.ToString().Contains("synthetic-secret",StringComparison.Ordinal),"Credentials redacted from diagnostic representation");
var directory=Path.Combine(Path.GetTempPath(),"source-profile-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
try{
 var file=Path.Combine(directory,"fixture.json");File.WriteAllText(file,JsonSerializer.Serialize(config,JsonSerializerOptions.Web));if(!OperatingSystem.IsWindows())File.SetUnixFileMode(file,UnixFileMode.UserRead|UnixFileMode.UserWrite);
 Check(SqlSourceProfile.Load(directory,"fixture","shared","fixture").Host=="db.internal","Operator profile exact tenant/project binding");
 Reject(()=>SqlSourceProfile.Load(directory,"fixture","other","fixture"),"SOURCE_PROFILE_ACCESS_DENIED");
 Reject(()=>SqlSourceProfile.Load(directory,"fixture","shared","other"),"SOURCE_PROFILE_ACCESS_DENIED");
 Reject(()=>SqlSourceProfile.Load(directory,"../fixture","shared","fixture"),"SOURCE_PROFILE_INVALID");
 File.WriteAllText(file,"{\"host\":\"one\",\"host\":\"two\"}");Reject(()=>SqlSourceProfile.Load(directory,"fixture","shared","fixture"),"SOURCE_PROFILE_INVALID");
 File.WriteAllText(file,JsonSerializer.Serialize(config,JsonSerializerOptions.Web).Replace("\"port\":1433","\"port\":1433,\"trustServerCertificate\":true",StringComparison.Ordinal));Reject(()=>SqlSourceProfile.Load(directory,"fixture","shared","fixture"),"SOURCE_PROFILE_INVALID");
 if(!OperatingSystem.IsWindows()){File.SetUnixFileMode(file,UnixFileMode.UserRead|UnixFileMode.GroupRead);Reject(()=>SqlSourceProfile.Load(directory,"fixture","shared","fixture"),"SOURCE_PROFILE_UNSAFE");}
}finally{Directory.Delete(directory,true);}
Console.WriteLine(JsonSerializer.Serialize(new{suite="vendor-neutral-source-schema-and-plan-safety",status="PASS",checks,clinicalData=false,liveDatabaseTested=false}));
