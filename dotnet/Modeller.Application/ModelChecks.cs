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
}
