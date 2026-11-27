using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;
public static class ModelChecks
{
    private static string S(JsonObject o,string k,string fallback="")=>KnowledgeCorpus.Text(o,k,fallback);
    public static async Task<JsonObject> Validate(JsonObject args,StandardsGateway engine,CancellationToken cancellation){
        var content=S(args,"content");var format=S(args,"format");if(Encoding.UTF8.GetByteCount(content)>2097152||string.IsNullOrWhiteSpace(content)||content.Contains('\0'))throw new ProcessingException("DOCUMENT_EMPTY_OVERSIZED_OR_INVALID_ENCODING");
        var findings=new JsonArray();var stages=new JsonArray();bool? valid=null;JsonObject? native=null;
        try{
            if(format is "xml" or "oet" or "opt"){
                var document=Imports.Xml(content);valid=true;stages.Add(Stage("parse","PASS","Secure XML well-formedness"));
                if(format!="xml"){
                    var root=document.Root?.Name.LocalName;var expected=format=="oet"?"template":"template";var structure=root==expected&&document.Descendants().Any(e=>e.Name.LocalName=="definition");if(!structure){valid=false;findings.Add(Finding("error","TEMPLATE_STRUCTURE","A template root and definition are required."));}stages.Add(Stage("structure",structure?"PASS":"FAIL","Bounded template document shape; full semantics require the native engine."));
                    if(!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPENEHR_ENGINE_URL"))){native=await engine.Native(format=="oet"?"validate/template":"validate/opt",content,null,cancellation);valid=valid==true&&native["valid"]?.GetValue<bool>()==true;}
                }
            }else if(format is "flat" or "structured"){
                var node=Data.ParseStrict(Encoding.UTF8.GetBytes(content));valid=node is JsonObject;if(valid!=true)findings.Add(Finding("error","SIMPLIFIED_OBJECT_REQUIRED","A single object is required."));stages.Add(Stage("parse","PASS","Bounded JSON with duplicate-member rejection."));stages.Add(Stage("structure",valid==true?"PASS":"FAIL","Document shape only; template-aware validation is separate."));
            }else if(format is "adl" or "aql"){
                if(!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPENEHR_ENGINE_URL"))){native=await engine.Native(format=="adl"?"validate/archetype":"validate/aql",content,null,cancellation);valid=native["valid"]?.GetValue<bool>();stages.Add(Stage("parse",valid==true?"PASS":"FAIL","Installed native grammar and explicit validation profile."));}
                else{valid=null;stages.Add(Stage("parse","NOT_EXECUTED","A qualified parser is not configured."));}
            }else throw new ProcessingException("VALIDATION_FORMAT_UNSUPPORTED");
        }catch(ProcessingException e)when(e.Code is "XML_MALFORMED_OR_UNSAFE" or "XML_TOO_COMPLEX"){valid=false;findings.Add(Finding("error",e.Code,"The document could not be safely parsed."));stages.Add(Stage("parse","FAIL","Document parse rejected."));}
        catch(System.Text.Json.JsonException){valid=false;findings.Add(Finding("error","JSON_MALFORMED","The document could not be parsed."));stages.Add(Stage("parse","FAIL","JSON grammar rejected."));}
        foreach(var name in new[]{"structure","semantics","terminology","openehr_conformance","repository_policy"})if(!stages.OfType<JsonObject>().Any(s=>S(s,"name")==name))stages.Add(Stage(name,"NOT_EXECUTED","This document check does not establish the required context or clinical meaning."));
        return new JsonObject{["format"]=format,["status"]=valid==false?"FAIL":valid is null?"INCOMPLETE":"PASS",["valid"]=valid,["content_sha256"]=Data.Hash(content),["release_eligible"]=false,["findings"]=findings,["stages"]=stages,["native"]=native,["clinical_approval"]=false,["scope"]="Deterministic bounded checks; no clinical approval or deployment qualification."};
    }
    public static JsonObject Stage(string name,string status,string reason)=>new(){["name"]=name,["status"]=status,["reason"]=reason,["qualified"]=false};
    public static JsonObject Finding(string severity,string code,string message)=>new(){["severity"]=severity,["code"]=code,["location"]="/",["message"]=message,["evidence"]=new JsonObject(),["remediation"]="Supply exact verified inputs and review the findings."};
    public static async Task<JsonObject> Quality(JsonObject args,StandardsGateway engine,CancellationToken cancellation){var result=await Validate(args,engine,cancellation);var steps=new JsonArray{new JsonObject{["name"]="model_preflight",["status"]=result["status"]!.DeepClone(),["report"]=result.DeepClone()}};foreach(var stage in (JsonArray)result["stages"]!)steps.Add(stage!.DeepClone());foreach(var name in new[]{"archetype_dependency_validation","ckm_version_validation","terminology_binding_validation","value_set_validation","terminology_version_check","opt_compilation","opt_validation","test_compositions","aql_execution","requirements_coverage"})steps.Add(Stage(name,"NOT_EXECUTED","No applicable verified context was supplied to this document-only operation."));return new JsonObject{["status"]=result["valid"]?.GetValue<bool>()==false?"FAIL":"INCOMPLETE",["release_eligible"]=false,["content_sha256"]=Data.Hash(S(args,"content")),["steps"]=steps,["findings"]=result["findings"]!.DeepClone(),["executed_at"]=DateTimeOffset.UtcNow.ToString("O")};}
    public static JsonObject Diff(string before,string after){if(before.Length>2097152||after.Length>2097152)throw new ProcessingException("DOCUMENT_LIMIT");var left=before.Split('\n');var right=after.Split('\n');var changes=new JsonArray();for(var i=0;i<Math.Max(left.Length,right.Length);i++){var a=i<left.Length?left[i]:null;var b=i<right.Length?right[i]:null;if(a!=b){if(changes.Count==1000)break;changes.Add(new JsonObject{["line"]=i+1,["before"]=a,["after"]=b});}}return new JsonObject{["before_sha256"]=Data.Hash(before),["after_sha256"]=Data.Hash(after),["changed"]=before!=after,["changes"]=changes,["truncated"]=changes.Count==1000,["scope"]="Textual comparison; no clinical equivalence is inferred."};}
    public static async Task<JsonObject> Project(SnapshotRepository repository,JsonObject args,StandardsGateway engine,CancellationToken cancellation){
        var id=Data.Required(args,"project");var path=Data.Required(args,"path");var project=repository.Project(id);var source=repository.Artifact(id,path,args["revision"]?.GetValue<string>());
        if(source["content"]?.GetValueKind()!=System.Text.Json.JsonValueKind.String)throw new ProcessingException("MODEL_TEXT_FORMAT_REQUIRED");
        var content=Data.Required(source,"content");var format=args["format"]?.GetValue<string>()??Path.GetExtension(path).TrimStart('.').ToLowerInvariant();if(format is "adls" or "adlt")format="adl";
        var report=await Quality(new JsonObject{["content"]=content,["format"]=format},engine,cancellation);var checks=new JsonArray();var findings=(JsonArray)report["findings"]!.DeepClone();
        void Check(string name,bool pass,string code){checks.Add(new JsonObject{["name"]=name,["status"]=pass?"PASS":"FAIL"});if(!pass)findings.Add(Finding("error",code,"Exact source repository evidence did not satisfy this check."));}
        Check("repository_integrity",Data.Hash(content)==S(source,"sha256"),"REPOSITORY_HASH_MISMATCH");Check("project_active",S(project,"status")=="ACTIVE","PROJECT_ARCHIVED");
        var current=repository.Artifact(id,path);Check("current_revision",S(current,"revision")==S(source,"revision")&&S(current,"sha256")==S(source,"sha256"),"REPOSITORY_REVISION_CONFLICT");
        bool Provenance(JsonNode? value,int depth=0)=>depth<=16&&(value is JsonValue v&&v.GetValueKind()==System.Text.Json.JsonValueKind.String&&!string.IsNullOrWhiteSpace(v.GetValue<string>())||value is JsonObject o&&o.Any(p=>Provenance(p.Value,depth+1))||value is JsonArray array&&array.Any(p=>Provenance(p,depth+1)));
        Check("recorded_provenance",Provenance(source["metadata"]?["provenance"]),"MISSING_PROVENANCE");
        foreach(var name in new[]{"requirements_traceability","recorded_validation_evidence","recorded_human_review","native_build_evidence","pinned_dependency_integrity","dependency_versions","rm_type_membership","duplicate_native_node_identifiers","native_path_resolution","deprecated_dependencies","external_dependency_resolution"})checks.Add(Stage(name,"NOT_EXECUTED","This exact-source check does not qualify the project evidence or its clinical meaning."));
        return new JsonObject{["status"]=findings.OfType<JsonObject>().Any(f=>S(f,"severity")=="error")?"FAIL":"INCOMPLETE",["release_eligible"]=false,["source"]=TemplateAuthoring.Reference(source),["content_sha256"]=source["sha256"]!.DeepClone(),["format"]=format,["document_validation"]=report["steps"]![0]!["report"]!.DeepClone(),["checks"]=checks,["traceability"]=null,["findings"]=findings,["model_changed"]=false,["clinical_approval"]=false,["scope"]="Exact source/document checks; model-aware project evidence stages remain explicitly unexecuted.",["executed_at"]=DateTimeOffset.UtcNow.ToString("O")};
    }
}
