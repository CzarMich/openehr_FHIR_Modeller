using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;

internal static class OpenEhrDeliveryTests {
    public static async Task Run() {
        var previous=Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT");Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT","Development");
        var root=Path.Combine(Path.GetTempPath(),"openehr-delivery-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
        try {
            var token=Path.Combine(root,"token");File.WriteAllText(token,"synthetic-destination-token-for-functional-acceptance");
            await using var server=new Destination();
            var options=new OpenEhrDestination(["Synthetic.opt.v1"],"urn:synthetic:source","source-record","source-version",true,true,"urn:synthetic:qualified-cdr");
            var destination=new DestinationConnection("cdr",server.Url,token,["synthetic"],["synthetic"],["COMPOSITION"],null,"openehr",options);
            var configuration=new Configuration(root,"",token,"",token,[],[destination],true);
            using var client=new OpenEhrDelivery(configuration,destination);
            using var alias=new OpenEhrDelivery(configuration,destination with{Id="another-private-profile"});
            var one=Composition(1,"first");
            if(client.TargetKey(one,"urn:synthetic:patients","patient-1")!=alias.TargetKey(one,"urn:synthetic:patients","patient-1"))throw new Exception("CDR target identity depends on a private profile ID");
            var validations=0;Task Validate(JsonObject body,CancellationToken cancellation){validations++;if(body["_type"]?.GetValue<string>()!="COMPOSITION")throw new Exception("Final outbound body was not validated");return Task.CompletedTask;}
            async Task<DeliveryReceipt> Send(JsonObject body)=>await client.Send(body,"urn:synthetic:patients","patient-1",()=>{},Validate,CancellationToken.None);
            var created=await Send(one);if(created.State!="CREATED"||server.Posts!=1||validations!=1)throw new Exception("Qualified openEHR create failed");
            if((await Send(one)).State!="ALREADY_PRESENT"||server.Posts!=1||server.Puts!=0)throw new Exception("Repeated composition created another version");
            var two=Composition(2,"corrected");if((await Send(two)).State!="UPDATED"||server.Puts!=1||!server.LastIfMatch!.EndsWith("::1\"",StringComparison.Ordinal))throw new Exception("Version-conditional update failed");
            if((await Send(one)).State!="SUPERSEDED"||server.Puts!=1)throw new Exception("Late source version overwrote newer data");
            if((await Send(Composition(2,"different-same-version"))).State!="SOURCE_VERSION_CONTENT_CONFLICT"||server.Puts!=1)throw new Exception("Conflicting source version was overwritten");
            server.Conflict=true;if((await Send(Composition(3,"third"))).State!="VERSION_CONFLICT"||server.Puts!=2)throw new Exception("Concurrent destination edit was overwritten or blindly retried");server.Conflict=false;
            server.Ambiguous=true;await Reject(()=>Send(two),"DESTINATION_COMPOSITION_IDENTIFIER_AMBIGUOUS");server.Ambiguous=false;
            server.MissingPatient=true;await Reject(()=>Send(two),"DESTINATION_PATIENT_EHR_REQUIRED");server.MissingPatient=false;
            server.FailAfterCommit=true;var another=Composition(1,"uncertain","another-record");
            var uncertain=await Send(another);if(uncertain.State!="UNCERTAIN"||server.Posts!=2)throw new Exception("Ambiguous write was retried");
            if((await client.CheckExisting(another,"urn:synthetic:patients","patient-1",CancellationToken.None))?.State!="ALREADY_PRESENT")throw new Exception("Committed ambiguous write could not be reconciled");
            using var unqualified=new OpenEhrDelivery(configuration,destination with{OpenEhr=options with{ClientAssignedIdsQualified=false}});
            await Reject(()=>unqualified.Send(Composition(1,"unqualified","new-record"),"urn:synthetic:patients","patient-1",()=>{},Validate,CancellationToken.None),"DESTINATION_COMPOSITION_UUID_QUALIFICATION_REQUIRED");
            if(server.Posts!=2)throw new Exception("Unqualified server received an unsafe create");
            var extra=Composition(1,"original","extra-field");extra["name"]=new JsonObject{["value"]="preserved-clinical-name"};
            if((await Send(extra)).State!="CREATED")throw new Exception("Extra field fixture create failed");
            if((await Send(Composition(1,"original","extra-field"))).State!="SOURCE_VERSION_CONTENT_CONFLICT")throw new Exception("Partial expected content incorrectly matched extra clinical content");
            using var timestampClient=new OpenEhrDelivery(configuration,destination with{OpenEhr=options with{VersionKind="utc-timestamp"}});
            JsonObject Timed(string version,string text){var value=Composition(1,text,"timestamp-record");value["feeder_audit"]!["originating_system_item_ids"]![1]!["id"]=version;return value;}
            var timedOne=Timed("2026-11-28T10:00:00Z","one");
            if((await timestampClient.Send(timedOne,"urn:synthetic:patients","patient-1",()=>{},Validate,CancellationToken.None)).State!="CREATED")throw new Exception("Timestamp version create failed");
            if((await timestampClient.Send(Timed("2026-11-28T12:01:00+02:00","two"),"urn:synthetic:patients","patient-1",()=>{},Validate,CancellationToken.None)).State!="UPDATED")throw new Exception("Offset-normalised timestamp ordering failed");
            await Reject(()=>timestampClient.Send(Timed("2026-11-28T12:02:00","invalid"),"urn:synthetic:patients","patient-1",()=>{},Validate,CancellationToken.None),"RECORD_EXPLICIT_SOURCE_VERSION_TIME_REQUIRED");
            Console.WriteLine("PASS openEHR HTTP: stable UUID, AQL/identity checks, no duplicate version, If-Match update, stale/conflicting versions, ambiguity, missing patient and committed-timeout reconciliation");
        } finally {Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT",previous);Directory.Delete(root,true);}
    }
    private static async Task Reject(Func<Task<DeliveryReceipt>> action,string code) {try{await action();}catch(ProcessingException e) when(e.Code==code){return;}throw new Exception("Expected "+code);}
    private static JsonObject Composition(int version,string text,string id="record-1")=>new(){["_type"]="COMPOSITION",["archetype_details"]=new JsonObject{["template_id"]=new JsonObject{["value"]="Synthetic.opt.v1"}},["feeder_audit"]=new JsonObject{["originating_system_item_ids"]=new JsonArray(new JsonObject{["issuer"]="urn:synthetic:source",["type"]="source-record",["id"]=id},new JsonObject{["issuer"]="urn:synthetic:source",["type"]="source-version",["id"]=version.ToString(System.Globalization.CultureInfo.InvariantCulture)})},["content"]=new JsonArray(new JsonObject{["synthetic"]=text})};
    private sealed class Destination:IAsyncDisposable {
        private readonly HttpListener listener=new();private readonly Task task;
        private readonly Dictionary<string,JsonObject> compositions=[];
        public string Url {get;}
        private const string EhrId="00000000-0000-4000-8000-000000000001";
        public int Posts,Puts;public string? LastIfMatch;public bool Conflict,Ambiguous,MissingPatient,FailAfterCommit;
        public Destination(){var probe=new TcpListener(IPAddress.Loopback,0);probe.Start();var port=((IPEndPoint)probe.LocalEndpoint).Port;probe.Stop();Url="http://127.0.0.1:"+port+"/";listener.Prefixes.Add(Url);listener.Start();task=Run();}
        private async Task Run(){while(listener.IsListening){HttpListenerContext context;try{context=await listener.GetContextAsync();}catch(HttpListenerException){break;}catch(ObjectDisposedException){break;}try{await Handle(context);}catch{context.Response.StatusCode=500;context.Response.Close();}}}
        private static async Task Respond(HttpListenerContext c,int status,JsonObject? body=null,string? etag=null){c.Response.StatusCode=status;if(etag is not null)c.Response.Headers["ETag"]=etag;if(body is not null){var bytes=Encoding.UTF8.GetBytes(body.ToJsonString());c.Response.ContentType="application/json";c.Response.ContentLength64=bytes.Length;await c.Response.OutputStream.WriteAsync(bytes);}c.Response.Close();}
        private async Task Handle(HttpListenerContext c){
            if(c.Request.Headers["Authorization"]!="Bearer synthetic-destination-token-for-functional-acceptance"){await Respond(c,401);return;}
            var path=c.Request.Url!.AbsolutePath;
            if(path=="/ehr"){await Respond(c,MissingPatient?404:200,new(){["ehr_id"]=new JsonObject{["value"]=EhrId}});return;}
            if(path.EndsWith("/ehr_status",StringComparison.Ordinal)){await Respond(c,200,new(){["subject"]=new JsonObject{["external_ref"]=new JsonObject{["namespace"]="urn:synthetic:patients",["id"]=new JsonObject{["value"]="patient-1"}}}});return;}
            JsonObject? payload=null;if(c.Request.HasEntityBody){using var reader=new StreamReader(c.Request.InputStream);payload=JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();}
            if(path=="/query/aql"){
                var parameters=payload!["query_parameters"]!;var business=parameters["source_id"]!.GetValue<string>();
                var found=compositions.Values.Where(x=>x["feeder_audit"]!["originating_system_item_ids"]!.AsArray().Any(id=>id?["type"]?.GetValue<string>()=="source-record"&&id["id"]?.GetValue<string>()==business)).ToArray();
                var rows=new JsonArray(found.Select(x=>(JsonNode)new JsonArray(x["uid"]!["value"]!.GetValue<string>())).ToArray());if(Ambiguous&&found.Length>0)rows.Add(new JsonArray(found[0]["uid"]!["value"]!.GetValue<string>()));
                await Respond(c,200,new(){["rows"]=rows});return;
            }
            if(c.Request.HttpMethod=="GET"){
                var id=Uri.UnescapeDataString(path.Split('/')[^1]);if(compositions.TryGetValue(id,out var resource))await Respond(c,200,(JsonObject)resource.DeepClone(),"\""+resource["uid"]!["value"]!.GetValue<string>()+"\"");else await Respond(c,404);return;
            }
            if(c.Request.HttpMethod=="POST"){
                Posts++;var id=payload!["uid"]!["value"]!.GetValue<string>();if(compositions.ContainsKey(id)){await Respond(c,409);return;}
                payload["uid"]=new JsonObject{["_type"]="OBJECT_VERSION_ID",["value"]=id+"::synthetic.cdr::1"};compositions[id]=(JsonObject)payload.DeepClone();
                if(FailAfterCommit){FailAfterCommit=false;await Respond(c,500);return;}await Respond(c,201,payload);return;
            }
            if(c.Request.HttpMethod=="PUT"){
                Puts++;LastIfMatch=c.Request.Headers["If-Match"];var id=path.Split('/')[^1];var existing=compositions[id];
                if(Conflict||LastIfMatch!="\""+existing["uid"]!["value"]!.GetValue<string>()+"\""){await Respond(c,412);return;}
                var version=int.Parse(existing["uid"]!["value"]!.GetValue<string>().Split("::")[2],System.Globalization.CultureInfo.InvariantCulture)+1;
                payload!["uid"]=new JsonObject{["_type"]="OBJECT_VERSION_ID",["value"]=id+"::synthetic.cdr::"+version};compositions[id]=(JsonObject)payload.DeepClone();await Respond(c,200,payload);return;
            }
            await Respond(c,400);
        }
        public async ValueTask DisposeAsync(){listener.Stop();listener.Close();await task;}
    }
}
