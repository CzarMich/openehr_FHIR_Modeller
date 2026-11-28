using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Modeller.Core;
using Modeller.Database;
try {
    if(args.Length!=3||args[0] is not("validate" or "discover" or "check-plan" or "extract"))throw new ProcessingException("SOURCE_USAGE_REQUIRED");
    var request=Data.ParseStrict(File.ReadAllBytes(args[1])) as JsonObject??throw new ProcessingException("SOURCE_REQUEST_INVALID");
    Data.Keys(request,"profile","plan","readPath","originalKeyFile","cursor","afterJson");
    var profile=request["profile"] as JsonObject??throw new ProcessingException("SOURCE_PROFILE_INVALID");
    var connector=Data.Required(profile,"connector");
    var output=Path.GetFullPath(args[2]);Directory.CreateDirectory(output);
    if(!OperatingSystem.IsWindows())File.SetUnixFileMode(output,UnixFileMode.UserRead|UnixFileMode.UserWrite|UnixFileMode.UserExecute);
    using var deadline=new CancellationTokenSource(TimeSpan.FromMinutes(10));
    using var termination=System.Runtime.InteropServices.PosixSignalRegistration.Create(System.Runtime.InteropServices.PosixSignal.SIGTERM,c=>{c.Cancel=true;deadline.Cancel();});
    JsonObject metadata;JsonArray? records=null;JsonNode? nextCursor=null;bool hasMore=false;PrivateApiRead? apiRead=null;
    if(connector is "epic-fhir" or "fhir-api" or "sap-bw" or "clinical-rest-api") {
        var settings=profile.Deserialize<ApiSourceProfile>(Data.Json)??throw new ProcessingException("SOURCE_PROFILE_INVALID");
        _=settings.Root();
        metadata=new(){["connector"]=connector,["readOnly"]=true,["configurationValid"]=true};
        if(args[0]!="validate"){
            using var source=new ApiSource(settings);metadata=await source.Discover(deadline.Token);
            if(args[0]=="check-plan"&&!settings.ReadPaths.Contains(Data.Required(request,"readPath"),StringComparer.Ordinal))throw new ProcessingException("SOURCE_READ_PATH_NOT_APPROVED");
            if(args[0]=="extract") {apiRead=await source.Read(Data.Required(request,"readPath"),deadline.Token);records=apiRead.Records;}
        }
    } else {
        var settings=profile.Deserialize<VendorProfile>(Data.Json)??throw new ProcessingException("SOURCE_PROFILE_INVALID");settings.Validate();
        if(settings.Dialect!="sap-hana") {using var connection=settings.Connection();} // Also fails closed when a configured proprietary driver is absent.
        metadata=new(){["connector"]=connector,["readOnly"]=true,["configurationValid"]=true};
        if(args[0]!="validate"){
            await using var source=await VendorDatabase.Open(settings,deadline.Token);var catalogue=await source.Discover(deadline.Token);
            metadata=new(){["connector"]=connector,["schemaFingerprint"]=catalogue.Fingerprint,["tables"]=JsonSerializer.SerializeToNode(catalogue.Tables,Data.Json),["keys"]=JsonSerializer.SerializeToNode(catalogue.Keys,Data.Json),["metadataOnly"]=true,["readOnly"]=true};
            if(args[0]=="check-plan") {var proposed=request["plan"]?.Deserialize<SourcePlan>(Data.Json)??throw new ProcessingException("SOURCE_APPROVED_PLAN_REQUIRED");var compiled=SourcePlanCompiler.Compile(catalogue,proposed,settings.Dialect);if(request["cursor"] is JsonObject cursor)VendorDatabase.ValidateAppend(catalogue,proposed,cursor.Deserialize<SourceCursor>(Data.Json)??throw new ProcessingException("SOURCE_CURSOR_REQUIRED"));metadata=new(){["schemaFingerprint"]=catalogue.Fingerprint,["sqlShape"]=compiled.Sql,["readOnly"]=true,["patientRowsIncluded"]=false};}
            if(args[0]=="extract"){
                var readPlan=request["plan"]?.Deserialize<SourcePlan>(Data.Json)??throw new ProcessingException("SOURCE_APPROVED_PLAN_REQUIRED");
                if(request["cursor"] is JsonObject selectedCursor){
                    var cursor=selectedCursor.Deserialize<SourceCursor>(Data.Json)??throw new ProcessingException("SOURCE_CURSOR_REQUIRED");
                    var window=await source.ReadAppend(readPlan,cursor,request["afterJson"] is null?null:JsonSerializer.SerializeToElement(Data.ParseStrict(Encoding.UTF8.GetBytes(Data.Required(request,"afterJson")))),deadline.Token);records=window.Records;hasMore=window.HasMore;nextCursor=records.LastOrDefault()?[cursor.Field]?.DeepClone()??(request["afterJson"] is null?null:Data.ParseStrict(Encoding.UTF8.GetBytes(Data.Required(request,"afterJson"))));
                }else records=await source.Read(readPlan,deadline.Token);
            }
        }
    }
    if(args[0]=="extract") {
        if(records is null)throw new ProcessingException("SOURCE_READ_REQUIRED");
        var bytes=Encoding.UTF8.GetBytes(records.ToJsonString());if(bytes.Length>Sources.Limit)throw new ProcessingException("SOURCE_SNAPSHOT_LIMIT");
        var sha=Convert.ToHexStringLower(SHA256.HashData(bytes));
        // The caller publishes this file only after the full bounded snapshot and all pages succeed.
        PrivateWrite(Path.Combine(output,"records.json"),bytes);
        if(apiRead is not null) {
            var keyPath=Data.Required(request,"originalKeyFile");if(!Path.IsPathFullyQualified(keyPath))throw new ProcessingException("SOURCE_ORIGINAL_KEY_REQUIRED");var key=File.ReadAllBytes(keyPath);if(key.Length!=32)throw new ProcessingException("SOURCE_ORIGINAL_KEY_REQUIRED");
            try {foreach(var original in apiRead.OriginalPages){
                var nonce=RandomNumberGenerator.GetBytes(12);var cipher=new byte[original.Value.Length];var tag=new byte[16];using var aes=new AesGcm(key,16);aes.Encrypt(nonce,original.Value,cipher,tag,Encoding.ASCII.GetBytes(original.Key));
                PrivateWrite(Path.Combine(output,"received-"+original.Key+".encrypted"),[1,..nonce,..tag,..cipher]);
            }}finally{CryptographicOperations.ZeroMemory(key);}
        }
        metadata=new(){["connector"]=connector,["readOnly"]=true,["records"]=records.Count,["sha256"]=sha,["complete"]=true,["hasMore"]=hasMore,["nextCursorJson"]=nextCursor?.ToJsonString(),["provenance"]=apiRead?.Provenance.DeepClone(),["receivedAt"]=DateTimeOffset.UtcNow.ToString("O")};
    }
    PrivateWrite(Path.Combine(output,"result.json"),Encoding.UTF8.GetBytes(metadata.ToJsonString()));
    Console.WriteLine("{\"status\":\"PASS\"}");
} catch(ProcessingException error) {Console.Error.WriteLine(error.Code);Environment.ExitCode=1;}
catch(OperationCanceledException){Console.Error.WriteLine("SOURCE_READ_CANCELLED");Environment.ExitCode=1;}
catch{Console.Error.WriteLine("SOURCE_ADAPTER_UNAVAILABLE");Environment.ExitCode=1;}
static void PrivateWrite(string path,byte[] bytes){
    var options=new FileStreamOptions{Mode=FileMode.CreateNew,Access=FileAccess.Write,Share=FileShare.None,Options=FileOptions.WriteThrough};if(!OperatingSystem.IsWindows())options.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;
    using var file=new FileStream(path,options);file.Write(bytes);file.Flush(true);
}
