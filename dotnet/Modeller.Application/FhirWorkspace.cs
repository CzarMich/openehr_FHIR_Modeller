using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public sealed class FhirWorkspace(SnapshotRepository repository,StandardsGateway gateway,Action<string> write,string tenant,RemoteDefinitions remote,MappingSelections selections,ModellingIdentity actor)
{
    public const string ProjectPath="documentation/fhir-project.json";
    private static string S(JsonObject o,string key,string fallback="")=>KnowledgeCorpus.Text(o,key,fallback);
    private static JsonObject Parse(string text)=>Data.ParseStrict(Encoding.UTF8.GetBytes(text)) as JsonObject??throw new ProcessingException("FHIR_ARGUMENTS_INVALID");
    public static JsonObject Configuration(JsonObject input) {
        var o=(JsonObject)input.DeepClone();NoSecrets(o);
        foreach(var field in new[]{"name","fhirVersion","canonical","packageId","version","publisher"})if(S(o,field).Length is <1 or >1000)throw new ProcessingException("FHIR_PROJECT_FIELD_REQUIRED");
        o["fhirVersion"]=S(o,"fhirVersion") switch{"R4"=>"4.0.1","R4B"=>"4.3.0","R5"=>"5.0.0",var v=>v};
        if(S(o,"name").Length>200||!Regex.IsMatch(S(o,"fhirVersion"),"^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$"))throw new ProcessingException("FHIR_RELEASE_UNSUPPORTED");
        if(!Uri.TryCreate(S(o,"canonical"),UriKind.Absolute,out var url)||url.Scheme is not ("https" or "http")||url.UserInfo!=""||url.Query!=""||url.Fragment!="")throw new ProcessingException("FHIR_URL_INVALID");
        if(!Regex.IsMatch(S(o,"packageId"),"^[a-z][a-z0-9.-]{2,150}$")||!Regex.IsMatch(S(o,"version"),"^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"))throw new ProcessingException("FHIR_PACKAGE_ID_OR_VERSION_INVALID");
        o["canonical"]=url.ToString().TrimEnd('/');o["standard"]="FHIR";
        foreach(var key in new[]{"dependencies","sources"})o[key]??=new JsonArray();foreach(var key in new[]{"connections","repository","policy"}){if(o[key] is JsonArray {Count:0})o[key]=new JsonObject();o[key]??=new JsonObject();}
        var seen=new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var d in (o["dependencies"] as JsonArray??throw new ProcessingException("FHIR_DEPENDENCIES_INVALID")).OfType<JsonObject>()){
            var id=S(d,"id");var v=S(d,"version");if(!Regex.IsMatch(id,"^[a-z][a-z0-9.-]{2,150}$")||!Regex.IsMatch(v,"^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"))throw new ProcessingException("FHIR_EXACT_DEPENDENCY_REQUIRED");
            if(seen.TryGetValue(id,out var previous)&&previous!=v)throw new ProcessingException("FHIR_DEPENDENCY_CONFLICT");seen[id]=v;
            if(id is "hl7.fhir.r4.core" or "hl7.fhir.r4b.core" or "hl7.fhir.r5.core" &&v!=S(o,"fhirVersion"))throw new ProcessingException("FHIR_DEPENDENCY_RELEASE_MISMATCH");
        }
        o["sourceFormat"]??="fsh";if(S(o,"sourceFormat") is not ("fsh" or "json"))throw new ProcessingException("FHIR_SOURCE_FORMAT_INVALID");o["language"]??="en";o["jurisdiction"]??="";o["clinicalProjectId"]??=null;
        o["policy"]!["publication"]="manual-review-required";o["policy"]!["reuseFirst"]=true;return o;
    }
    public static void NoSecrets(JsonNode? node){if(node is JsonObject o){foreach(var(k,v)in o){if(Regex.IsMatch(k,"(?:password|secret|access.?token|api.?key|credential)",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant))throw new ProcessingException("FHIR_SECRET_FORBIDDEN");NoSecrets(v);}}else if(node is JsonArray a)foreach(var v in a)NoSecrets(v);}
    public JsonObject Project(string id){var artifact=repository.Artifact(id,ProjectPath);var config=Parse(S(artifact,"content"));config["id"]=id;return new JsonObject{["project"]=config,["revision"]=artifact["revision"]!.DeepClone(),["artifacts"]=new JsonArray(repository.Artifacts(id).OfType<JsonObject>().Where(a=>S(a,"path").StartsWith("fhir/",StringComparison.Ordinal)).Select(a=>(JsonNode)a.DeepClone()).ToArray())};}
    public async Task<JsonObject> Execute(string tool,JsonObject input,CancellationToken cancellation){
        var action=S(input,"action");var id=S(input,"projectId");
        if(tool=="fhir_project"){
            if(action=="capabilities")return await gateway.Fhir("capabilities.get",new JsonObject(),tenant,cancellation);
            if(action=="list"){var items=new JsonArray();foreach(var p in repository.List().OfType<JsonObject>()){try{items.Add(Project(S(p,"id"))["project"]!.DeepClone());}catch(ProcessingException e)when(e.Code=="ARTIFACT_NOT_FOUND"){}}return new JsonObject{["items"]=items,["total"]=items.Count,["providers"]=new JsonArray("openEHR","FHIR")};}
            if(action is "create" or "update"){
                write(id);var config=Configuration(Parse(S(input,"document","{}")));
                if(action=="create")repository.Create(id,S(config,"name"),"FHIR authoring workspace");
                else{var current=Project(id);if(S((JsonObject)current["project"]!,"fhirVersion")!=S(config,"fhirVersion")&&repository.Artifacts(id).OfType<JsonObject>().Any(a=>S(a,"path").StartsWith("fhir/",StringComparison.Ordinal)||S(a,"path").StartsWith("mappings/",StringComparison.Ordinal)))throw new ProcessingException("FHIR_RELEASE_CHANGE_REQUIRES_NEW_PROJECT");}
                repository.Save(id,ProjectPath,config.ToJsonString(),new JsonObject{["standard"]="FHIR"},input["expectedRevision"]?.GetValue<string>());
            }
            return Project(id);
        }
        var args=Parse(S(input,"arguments","{}"));NoSecrets(args);var project=(JsonObject)Project(id)["project"]!;
        var category=tool switch{"fhir_fsh_compile"=>"fsh","fhir_example_generate"=>"examples",_=>tool[5..]};if(category=="fsh")action="compile";if(category=="examples")action="generate";
        if(action is "save" or "install" or "import" or "submit" or "sync" or "build" or "publish" or "prepare-confirmation")write(id);
        if(category=="artifact"&&action is "get" or "history" or "search" or "save"){
            if(action=="search"){var query=S(args,"query");var items=new JsonArray(repository.Artifacts(id).OfType<JsonObject>().Where(a=>S(a,"path").StartsWith("fhir/",StringComparison.Ordinal)&&a.ToJsonString().Contains(query,StringComparison.OrdinalIgnoreCase)).Select(a=>(JsonNode)a.DeepClone()).ToArray());return new JsonObject{["items"]=items,["total"]=items.Count};}
            var path=ArtifactPath(Data.Required(args,"path"));
            if(action=="get")return repository.Artifact(id,path,args["revision"]?.GetValue<string>());if(action=="history")return new JsonObject{["items"]=repository.History(id,path)};
            var content=Data.Required(args,"content");var representation=S(args,"representation","authored");if(!new[]{"authored","imported","generated","example"}.Contains(representation))throw new ProcessingException("FHIR_REPRESENTATION_INVALID");
            var format=S(args,"format",Path.GetExtension(path).TrimStart('.'));if(!new[]{"json","xml","fsh","yaml","md"}.Contains(format)||format=="xml"&&representation!="imported")throw new ProcessingException("FHIR_FORMAT_UNSUPPORTED");
            JsonObject? inspection=null;if(format=="json")inspection=await gateway.Fhir("artifact.inspect",new JsonObject{["content"]=content,["project"]=project.DeepClone()},tenant,cancellation);
            var metadata=new JsonObject{["standard"]="FHIR",["representation"]=representation,["format"]=format,["fhirVersion"]=project["fhirVersion"]!.DeepClone(),["sourceClaims"]=args["provenance"]?.DeepClone()??new JsonObject(),["clinicalApproval"]=false,["inspection"]=inspection?["identity"]?.DeepClone()??new JsonObject(),["inspectionStatus"]=format=="json"?"inspected-not-validated":"not-run"};
            if(representation=="imported"&&args["expectedRevision"] is not null)throw new ProcessingException("FHIR_ORIGINAL_IMMUTABLE");return repository.Save(id,path,content,metadata,args["expectedRevision"]?.GetValue<string>());
        }
        if(category=="mapping"&&action is "get" or "list" or "save"){
            if(action=="list"){var items=new JsonArray(repository.Artifacts(id).OfType<JsonObject>().Where(a=>S(a,"path").StartsWith("mappings/",StringComparison.Ordinal)).Select(a=>(JsonNode)a.DeepClone()).ToArray());return new JsonObject{["items"]=items,["total"]=items.Count};}
            var path=S(args,"path");if(!path.StartsWith("mappings/",StringComparison.Ordinal))throw new ProcessingException("MAPPING_PATH_REQUIRED");if(action=="get")return repository.Artifact(id,path,args["revision"]?.GetValue<string>());
            var content=args["content"] is JsonObject m?m.ToJsonString():Data.Required(args,"content");return repository.Save(id,path,content,new JsonObject{["standard"]="FHIR",["clinicalApproval"]=false},args["expectedRevision"]?.GetValue<string>());
        }
        if(category=="connection"){if(action=="list"){var items=remote.Connections();return new JsonObject{["items"]=items,["total"]=items.Count};}return await remote.Connection(Data.Required(args,"id"),action,args,cancellation);}
        if(category=="mapping"&&action is "preview" or "context" or "prepare-confirmation" or "confirmation"){
            if(action=="prepare-confirmation")return selections.Prepare(id,args["modelInputs"] as JsonArray??new JsonArray());
            if(action=="confirmation"){var view=selections.Get(Data.Required(args,"subject"));if(S(view,"project")!=id)throw new ProcessingException("MAPPING_MODEL_PROJECT_MISMATCH");return view;}
            var context=selections.Context(id,args["modelInputs"] as JsonArray??new JsonArray(),args["confirmationSubject"]?.GetValue<string>());if(action=="context")return context;if(context["ready"]?.GetValue<bool>()!=true)throw new ProcessingException("MAPPING_HUMAN_CONFIRMATION_REQUIRED");
            var preview=await gateway.Fhir("mapping.preview",WithProject(args,project),tenant,cancellation);preview["modelReadiness"]=context;preview["operationalExecution"]="NOT_SUPPORTED";return preview;
        }
        if(category=="source")return await Source(action,id,args,project,cancellation);
        if(category=="ig")return await Ig(action,id,project,args,cancellation);
        if(category=="artifact"&&action=="validate"&&args["path"] is not null)args["content"]=repository.Artifact(id,ArtifactPath(Data.Required(args,"path")),args["revision"]?.GetValue<string>())["content"]!.DeepClone();
        if(category=="profile"&&action=="validate")category="artifact";
        if(category is "profile" or "mapping")args["projectArtifacts"]=new JsonArray(repository.Artifacts(id).OfType<JsonObject>().Where(a=>S(a,"path").EndsWith(".json",StringComparison.Ordinal)).Select(a=>{try{return JsonNode.Parse(S(a,"content"));}catch(System.Text.Json.JsonException){return null;}}).Where(n=>n is JsonObject).ToArray());
        args["project"]=project.DeepClone();var result=await gateway.Fhir(category+"."+action,args,tenant,cancellation);if(category!="dataset")Record(id,category+"."+action,new JsonObject{["inputHash"]=Data.Hash(Data.Canonical(args)),["resultHash"]=Data.Hash(Data.Canonical(result)),["clinicalApproval"]=false});return result;
    }
    private async Task<JsonObject> Source(string action,string id,JsonObject args,JsonObject project,CancellationToken cancellation){
        var current=Project(id);if(action=="import"&&(args["projectRevision"] is null||S(args,"projectRevision")!=S(current,"revision")))throw new ProcessingException("REVISION_CONFLICT");
        JsonObject source;if(args["connectionId"] is not null){source=await remote.Connection(Data.Required(args,"connectionId"),"read",args,cancellation);await gateway.Fhir("artifact.inspect",new JsonObject{["content"]=source["content"]!.DeepClone(),["project"]=project.DeepClone()},tenant,cancellation);if(action=="import"&&S(source,"sha256")!=S(args,"expectedSha256"))throw new ProcessingException("SOURCE_CHANGED");}
        else source=await gateway.Fhir("source."+action,WithProject(args,project),tenant,cancellation);
        if(action=="inspect")return source;
        if(S(source,"kind")=="resource"){
            var path=ArtifactPath(Data.Required(args,"path"));var saved=repository.Save(id,path,Data.Required(source,"content"),new JsonObject{["standard"]="FHIR",["representation"]="imported",["format"]="json",["provenance"]=source["provenance"]?.DeepClone(),["clinicalApproval"]=false},null);source["saved"]=saved;
        }else if(S(source,"kind")=="package"){
            var dependency=source["dependency"] as JsonObject??throw new ProcessingException("FHIR_SOURCE_PACKAGE_INVALID");var updated=(JsonObject)project.DeepClone();updated.Remove("id");var dependencies=(JsonArray)updated["dependencies"]!;var existing=dependencies.OfType<JsonObject>().FirstOrDefault(d=>S(d,"id")==S(dependency,"id"));if(existing is not null&&!JsonNode.DeepEquals(existing,dependency))throw new ProcessingException("FHIR_DEPENDENCY_CONFLICT");if(existing is null)dependencies.Add(dependency.DeepClone());var configuration=Configuration(updated);repository.Save(id,ProjectPath,configuration.ToJsonString(),new JsonObject{["standard"]="FHIR"},S(args,"projectRevision"));source["configuration"]=Project(id);
        }else throw new ProcessingException("SOURCE_RELEASE_REQUIRED");
        Record(id,"source.import",new JsonObject{["provenance"]=source["provenance"]?.DeepClone(),["kind"]=source["kind"]?.DeepClone()});return source;
    }
    private static string ArtifactPath(string path){if(!Regex.IsMatch(path,"^[A-Za-z0-9][A-Za-z0-9_./-]{0,219}$")||path.Contains("..",StringComparison.Ordinal)||path.Contains("//",StringComparison.Ordinal)||!Regex.IsMatch(path,"\\.(json|xml|fsh|yaml|md)$"))throw new ProcessingException("FHIR_ARTIFACT_PATH_INVALID");return path.StartsWith("fhir/",StringComparison.Ordinal)?path:"fhir/"+path;}
    private JsonArray Resources(string id)=>new(repository.Artifacts(id).OfType<JsonObject>().Where(a=>S(a,"path").StartsWith("fhir/",StringComparison.Ordinal)&&S(a,"path").EndsWith(".json",StringComparison.Ordinal)).Select(a=>{try{return JsonNode.Parse(S(a,"content"));}catch(System.Text.Json.JsonException){return null;}}).OfType<JsonObject>().Where(r=>r["resourceType"] is not null).Select(r=>(JsonNode)r).ToArray());
    private async Task<JsonObject> Ig(string action,string id,JsonObject project,JsonObject args,CancellationToken cancellation){
        var connectionId=project["connections"]?["ig"]?.GetValue<string>()??throw new ProcessingException("FHIR_IG_NOT_CONFIGURED");var entry=RemoteDefinitions.ConfigFile("FHIR_CONNECTIONS_FILE")[connectionId] as JsonObject??throw new ProcessingException("FHIR_CONNECTION_NOT_FOUND");if(S(entry,"type")!="ig")throw new ProcessingException("FHIR_CONNECTION_TYPE_MISMATCH");
        async Task<JsonObject> Send(string path,HttpMethod method,JsonObject? body=null){var raw=await remote.RequestConnection(entry,path,method,body,cancellation);return JsonNode.Parse(raw) switch{JsonObject o=>o,JsonArray a=>new JsonObject{["items"]=a,["total"]=a.Count},_=>throw new ProcessingException("FHIR_REMOTE_RESPONSE_INVALID")};}
        if(action=="test")return new JsonObject{["id"]=connectionId,["type"]="ig",["connected"]=true,["capabilities"]=await Send("/api/v1/admin/health",HttpMethod.Get)};
        if(action=="projects")return await Send("/api/v1/projects",HttpMethod.Get);var target=Data.Required(entry,"projectId");if(!Guid.TryParseExact(target,"D",out _))throw new ProcessingException("FHIR_REMOTE_PROJECT_REQUIRED");
        if(action=="status")return await Send("/api/v1/projects/"+target+"/ig",HttpMethod.Get);
        if(action is "build" or "publish")throw new ProcessingException("FHIR_IG_REVIEW_ON_EXISTING_SERVER_REQUIRED");
        if(action=="sync"){var sha=Data.Required(args,"commitSha");if(!Regex.IsMatch(sha,"^[a-f0-9]{40}$"))throw new ProcessingException("FHIR_GIT_EXACT_COMMIT_REQUIRED");var link=Data.Required(entry,"linkId");if(!Guid.TryParseExact(link,"D",out _))throw new ProcessingException("FHIR_REMOTE_PROJECT_REQUIRED");var result=await Send("/api/v1/projects/"+target+"/git/"+link+"/pull",HttpMethod.Post,new JsonObject{["commitSha"]=sha});Record(id,"ig.sync",new JsonObject{["destination"]=connectionId,["commitSha"]=sha,["jobId"]=result["jobId"]?.DeepClone()});result["publication"]="NOT_REQUESTED";result["distributionAuthority"]=entry["baseUrl"]!.DeepClone();return result;}
        if(action!="submit"||args["paths"] is not JsonArray{Count:>0 and <=100} paths)throw new ProcessingException("FHIR_SUBMISSION_PATHS_REQUIRED");var prepared=new List<JsonObject>();var profiles=new JsonArray(Resources(id).OfType<JsonObject>().Where(r=>S(r,"resourceType")=="StructureDefinition").Select(r=>(JsonNode)r.DeepClone()).ToArray());
        foreach(var path in paths){var artifact=repository.Artifact(id,ArtifactPath(path!.GetValue<string>()));var validation=await gateway.Fhir("artifact.validate",new JsonObject{["project"]=project.DeepClone(),["content"]=artifact["content"]!.DeepClone(),["profiles"]=profiles.DeepClone()},tenant,cancellation);Validation.RequireFhirCompleted(validation,false);if(validation["valid"]?.GetValue<bool>()!=true)throw new ProcessingException("FHIR_SUBMISSION_VALIDATION_REQUIRED");prepared.Add(artifact);}
        var receipts=new JsonArray();foreach(var artifact in prepared){var path=S(artifact,"path");var receipt=await Send("/api/v1/projects/"+target+"/artifacts/upload",HttpMethod.Post,new JsonObject{["fileName"]=System.IO.Path.GetFileName(path),["contentType"]=path.EndsWith(".xml",StringComparison.Ordinal)?"application/fhir+xml":"application/fhir+json",["content"]=artifact["content"]!.DeepClone()});receipts.Add(new JsonObject{["path"]=path,["revision"]=artifact["revision"]!.DeepClone(),["sha256"]=artifact["sha256"]!.DeepClone(),["receipt"]=receipt});Record(id,"ig.submit",new JsonObject{["destination"]=connectionId,["sourceRevision"]=artifact["revision"]!.DeepClone(),["sha256"]=artifact["sha256"]!.DeepClone(),["artifactVersionId"]=receipt["id"]?.DeepClone()});}
        return new JsonObject{["receipts"]=receipts,["publication"]="NOT_REQUESTED",["distributionAuthority"]=entry["baseUrl"]!.DeepClone()};
    }
    private void Record(string project,string action,JsonObject evidence){using var ledger=new AuditLedger(true);ledger.Append(tenant,Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)),0,new JsonObject{["project"]=project,["type"]="FHIR_OPERATION",["action"]=action,["actor"]=Imports.Actor(actor),["evidence"]=evidence});}
    private static JsonObject WithProject(JsonObject args,JsonObject project){var o=(JsonObject)args.DeepClone();o["project"]=project.DeepClone();return o;}
}
