using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Modeller.Core;
using Modeller.Database;
if(args.Length==2&&args[0]=="--synthetic-database-diagnostic"){
    var request=Data.ParseStrict(File.ReadAllBytes(args[1]))!.AsObject();var p=request["profile"]!.Deserialize<VendorProfile>(Data.Json)!;
    if(Environment.GetEnvironmentVariable("MODELLER_VENDOR_SYNTHETIC_FIXTURE")!="ephemeral-loopback-only"||p.Host!="127.0.0.1"||p.Tenant!="synthetic"||p.Port is <19541 or >19543)throw new Exception("Synthetic diagnostic boundary");
    try{using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(45));await using var db=await VendorDatabase.Open(p,timeout.Token);var tables=await db.Discover(timeout.Token);Console.WriteLine("Synthetic metadata tables="+tables.Tables.Length);}
    catch(Exception e){Console.Error.WriteLine((e.GetType().Name+": "+e.Message).Replace(p.Password,"REDACTED",StringComparison.Ordinal));Environment.ExitCode=1;}return;
}
var checks=0;
void Check(bool valid,string reason){if(!valid)throw new Exception(reason);checks++;}
void Reject(Action action,string code){try{action();throw new Exception("Expected "+code);}catch(ProcessingException e)when(e.Code==code){checks++;}}
async Task RejectAsync(Func<Task> action,string code){try{await action();throw new Exception("Expected "+code);}catch(ProcessingException e)when(e.Code==code){checks++;}}
var schema=new SchemaCatalogue([new(1,"vendor-schema","events",[new(1,"id","bigint",false,false,1),new(2,"value","varchar",false,false,0)])],[]);
var plan=new SourcePlan(schema.Fingerprint,1,[new(1,1,"id"),new(1,2,"value")],[],[new(1,2,"eq",JsonSerializer.SerializeToElement("synthetic-string"))],10);
foreach(var dialect in new[]{"sqlserver","oracle","postgresql","mysql","mariadb","sap-hana"}){
 var compiled=SourcePlanCompiler.Compile(schema,plan,dialect);Check(compiled.Sql.StartsWith("SELECT ",StringComparison.Ordinal)&&!compiled.Sql.Contains("synthetic-string",StringComparison.Ordinal),dialect+" uses bound values");Check(compiled.Parameters.Length==2&&compiled.Parameters[^1].Value.Equals(10),dialect+" bounds the window");
 var profile=new VendorProfile(dialect,"db.example.internal",dialect=="oracle"?2484:5432,"Clinical","reader","SYNTHETIC-secret","tenant",["project"],["vendor-schema"]);profile.Validate();
 if(dialect!="sap-hana"){using var connection=profile.Connection();Check(!profile.ToString().Contains("SYNTHETIC-secret",StringComparison.Ordinal)&&connection.ConnectionString.Length>0,dialect+" has a native driver and redacts profile strings");}
}
VendorDatabase.ValidateAppend(schema,plan,new(1,1,"id"));checks++;
Reject(()=>VendorDatabase.ValidateAppend(schema,plan,new(1,2,"value")),"SOURCE_APPEND_CURSOR_REQUIRES_UNIQUE_NATIVE_NUMERIC_KEY");
var exact=SourcePlanCompiler.Compile(schema,plan with{Filters=[new(1,1,"gt",JsonSerializer.SerializeToElement("9223372036854775806"))]});Check(exact.Parameters[0].Value.Equals(9223372036854775806L),"Large numeric filter text binds without browser rounding");
Reject(()=>SourcePlanCompiler.Compile(schema,plan,"unknown"),"SOURCE_DIALECT_UNKNOWN");
Reject(()=>new VendorProfile("oracle","server",2484,"x)(BAD=1)","reader","password","t",["p"],["s"]).Validate(),"SOURCE_PROFILE_INVALID");
Check(VendorDatabase.ReadOnlyMySqlGrant("GRANT USAGE ON *.* TO 'reader'@'%'"),"Read-only MySQL login grant accepted");
Check(VendorDatabase.ReadOnlyMySqlGrant("GRANT SELECT ON `clinical`.* TO 'reader'@'%'"),"Read-only MySQL SELECT grant accepted");
Check(!VendorDatabase.ReadOnlyMySqlGrant("GRANT SELECT, UPDATE ON `clinical`.* TO 'reader'@'%'"),"MySQL write grant rejected without a source write probe");
Check(!VendorDatabase.ReadOnlyMySqlGrant("GRANT 'unexpanded_role'@'%' TO 'reader'@'%'"),"Unexpanded role is not mistaken for effective read-only access");
using var key=RSA.Create(2048);var authentication=new SourceAuthentication("smart-private-key-jwt",ClientId:"synthetic-client",TokenEndpoint:"https://auth.example/token",Scopes:["system/Observation.rs"],PrivateKeyPem:key.ExportPkcs8PrivateKeyPem(),KeyId:"synthetic-key");
var assertion=ApiSource.Assertion(authentication,"https://auth.example/token");var parts=assertion.Split('.');byte[] Decode(string value)=>Convert.FromBase64String(value.Replace('-','+').Replace('_','/').PadRight((value.Length+3)/4*4,'='));
Check(key.VerifyData(Encoding.ASCII.GetBytes(parts[0]+'.'+parts[1]),Decode(parts[2]),HashAlgorithmName.SHA384,RSASignaturePadding.Pkcs1),"SMART assertion is actually signed with RS384");
var claims=JsonNode.Parse(Decode(parts[1]))!;Check(claims["aud"]!.GetValue<string>()=="https://auth.example/token"&&claims["exp"]!.GetValue<long>()-claims["iat"]!.GetValue<long>()<=300,"SMART audience and bounded lifetime retained");
Check(ApiSource.Assertion(authentication,"https://auth.example/token")!=assertion,"Each SMART token assertion has a fresh nonce");
foreach(var invalid in new[]{"../Patient","https://other.example/Patient","Patient/$export","Patient\\../Observation"})Reject(()=>ApiSourceProfile.ValidatePath(invalid),invalid.Contains("$export",StringComparison.Ordinal)?"SOURCE_STATEFUL_OPERATION_DENIED":"SOURCE_READ_PATH_INVALID");
var sock=new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);sock.Start();var port=((IPEndPoint)sock.LocalEndpoint).Port;sock.Stop();
using var listener=new HttpListener();listener.Prefixes.Add($"http://127.0.0.1:{port}/");listener.Start();
var posts=0;var gets=0;var scenario="fhir";var lastAuth="";
var server=Task.Run(async()=>{while(listener.IsListening){HttpListenerContext context;try{context=await listener.GetContextAsync();}catch(HttpListenerException){break;}catch(ObjectDisposedException){break;}
 try{
  var path=context.Request.Url!.AbsolutePath;var query=context.Request.Url.Query;lastAuth=context.Request.Headers["Authorization"]??"";JsonObject data;
  if(path.EndsWith("/$metadata",StringComparison.Ordinal)){
    if(context.Request.Headers["Accept"]!="application/xml")throw new Exception("OData metadata media type");
    context.Response.ContentType="application/xml";await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("<edmx:Edmx xmlns:edmx='http://schemas.microsoft.com/ado/2007/06/edmx'><edmx:DataServices><Schema xmlns='http://schemas.microsoft.com/ado/2008/09/edm' xmlns:sap='http://www.sap.com/Protocols/SAPData'><EntityType Name='SyntheticQuery'><Property Name='measure' Type='Edm.Decimal' sap:aggregation-role='measure'/></EntityType></Schema></edmx:DataServices></edmx:Edmx>"));context.Response.Close();continue;
  }

  if(context.Request.HttpMethod=="POST"){
   Interlocked.Increment(ref posts);using var body=new StreamReader(context.Request.InputStream);var form=await body.ReadToEndAsync();if(path!="/token"||!form.Contains("client_credentials",StringComparison.Ordinal))throw new Exception("Unexpected source write");data=new(){["access_token"]="synthetic-token",["token_type"]="Bearer",["expires_in"]=300,["scope"]="system/Observation.rs"};
  }else{
   Interlocked.Increment(ref gets);
   if(path.EndsWith("metadata",StringComparison.Ordinal))data=new(){["resourceType"]="CapabilityStatement",["fhirVersion"]="4.0.1",["rest"]=new JsonArray()};
   else if(scenario=="odata")data=new(){["value"]=new JsonArray(new JsonObject{["key"]="synthetic-analytic-key",["measure"]=12,["unit"]="mg"})};
   else if(scenario=="rest")data=new(){["items"]=new JsonArray(new JsonObject{["id"]="synthetic-rest-key"})};
   else{
    var second=query.Contains("page=2",StringComparison.Ordinal);data=new(){["resourceType"]="Bundle",["type"]="searchset",["entry"]=new JsonArray(new JsonObject{["resource"]=new JsonObject{["resourceType"]="Observation",["id"]=second?"two":"one",["meta"]=new JsonObject{["versionId"]="7"},["status"]="final"}})};
    if(!second)data["link"]=new JsonArray(new JsonObject{["relation"]="next",["url"]=scenario=="foreign"?"https://outside.example/fhir/Observation?page=2":"Observation?page=2"});
   }
  }
  context.Response.ContentType="application/json";var bytes=Encoding.UTF8.GetBytes(data.ToJsonString());await context.Response.OutputStream.WriteAsync(bytes);
 }finally{context.Response.Close();}
}});
var previous=Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT");Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT","Development");
try{
 var endpoint=$"http://127.0.0.1:{port}/";
 var profile=new ApiSourceProfile("epic-fhir",endpoint+"fhir/",["Observation"],authentication with{TokenEndpoint=endpoint+"token"},"t",["p"],"4.0.1");
 using(var source=new ApiSource(profile,true)){
  var data=await source.Read("Observation",CancellationToken.None);Check(data.Records.Count==2&&data.Provenance.Count==2&&data.OriginalPages.Count==2,"Real HTTP FHIR paging retains every resource and original page");
  Check(data.Records[0]!["meta"]!["versionId"]!.GetValue<string>()=="7","FHIR source version provenance survives extraction");Check(posts==1&&lastAuth=="Bearer synthetic-token","OAuth token is exchanged once; all source data operations use authenticated GET");
  await RejectAsync(async()=>{await source.Read("Patient",CancellationToken.None);},"SOURCE_READ_PATH_NOT_APPROVED");
 }
 scenario="foreign";using(var source=new ApiSource(profile with{Authentication=new("bearer",Token:"synthetic-token")},true))await RejectAsync(async()=>{await source.Read("Observation",CancellationToken.None);},"SOURCE_PAGE_ORIGIN_DENIED");
 scenario="rest";using(var source=new ApiSource(new("clinical-rest-api",endpoint,["records"],new("basic",User:"reader",Password:"SYNTHETIC-password"),"t",["p"]),true)){var data=await source.Read("records",CancellationToken.None);Check(data.Records.Count==1&&lastAuth.StartsWith("Basic ",StringComparison.Ordinal),"Generic clinical REST uses its explicit read contract and HTTPS credential mode");}
 scenario="odata";using(var source=new ApiSource(new("sap-bw",endpoint,["query"],new("bearer",Token:"synthetic-token"),"t",["p"],Analytics:new(){["grain"]="synthetic-event",["dimensions"]=new JsonArray("key"),["measures"]=new JsonArray("measure"),["units"]=new JsonObject{["measure"]="unit"},["filters"]=new JsonObject()}),true)){var metadata=await source.Discover(CancellationToken.None);Check(metadata["entities"]!.ToJsonString().Contains("aggregation-role",StringComparison.Ordinal),"BW XML metadata preserves analytic annotations");var data=await source.Read("query",CancellationToken.None);Check(data.Records[0]!["unit"]!.GetValue<string>()=="mg","BW OData extraction preserves analytic units");}
 Check(posts==1&&gets>=6,"No clinical source POST, DELETE, PUT or procedure execution was issued");
}finally{Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT",previous);listener.Stop();await server;}
Console.WriteLine(JsonSerializer.Serialize(new{vendorChecks=checks,status="PASS",clinicalData="SYNTHETIC_ONLY",liveVendorQualification=false}));
