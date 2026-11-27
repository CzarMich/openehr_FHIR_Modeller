using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;
public static class ModelChecks
{
    private static string S(JsonObject o,string k,string fallback="")=>KnowledgeCorpus.Text(o,k,fallback);
    public static Task<JsonObject> Validate(JsonObject args,StandardsGateway engine,CancellationToken cancellation){
        cancellation.ThrowIfCancellationRequested();var content=S(args,"content");var format=S(args,"format");if(!new[]{"xml","oet","opt","adl","aql","flat","structured"}.Contains(format))throw new ProcessingException("VALIDATION_FORMAT_UNSUPPORTED");
        var findings=new JsonArray();var executed=new JsonArray();bool? parse=null;bool? structure=null;var stages=new Dictionary<string,JsonObject>();
        foreach(var(name,reason)in new[]{("parse","A qualified language parser is not configured."),("structure","No structural profile was executed."),("semantics","Model-aware validation is required."),("terminology","No pinned terminology context was supplied."),("openehr_conformance","Complete conformance requires a qualified engine and resolved dependencies."),("repository_policy","No repository revision or policy context was supplied.")})stages[name]=Stage(name,"NOT_EXECUTED",reason);
        try{
            if(Encoding.UTF8.GetByteCount(content)>2097152||string.IsNullOrWhiteSpace(content)||content.Contains('\0'))throw new ProcessingException("DOCUMENT_EMPTY_OVERSIZED_OR_INVALID_ENCODING");
            if(format is "xml" or "oet" or "opt"){
                var document=Imports.Xml(content);parse=true;executed.Add("secure_xml_parse");stages["parse"]=Stage("parse","PASS","XML well-formedness with DTDs and external entities prohibited.");
                if(format=="xml"){structure=true;foreach(var name in new[]{"structure","semantics","terminology","openehr_conformance"})stages[name]=Stage(name,"NOT_APPLICABLE","Generic XML requests well-formedness only.");}
                else{DocumentProfiles.Template(document,format,findings);structure=!DocumentProfiles.Failed(findings);executed.Add(format+"_structural_profile");}
            }else if(format is "flat" or "structured"){
                var document=Data.ParseStrict(Encoding.UTF8.GetBytes(content));parse=true;executed.Add("unambiguous_json_parse");stages["parse"]=Stage("parse","PASS","Bounded JSON grammar and duplicate-member rejection.");DocumentProfiles.Simplified(document,format,findings);structure=!DocumentProfiles.Failed(findings);executed.Add(format+"_document_shape");
            }else if(format=="adl"){
                executed.Add("adl_header_preflight");var match=Regex.Match(content,@"\A(?:\uFEFF)?(?:\s|--[^\r\n]*(?:\r?\n|$))*archetype\b(?:[ \t]*\([^\r\n()]{0,1000}\))?\s+(openEHR-[^\s;]+)(?:\s|$)");
                if(!match.Success||!Regex.IsMatch(match.Groups[1].Value,DocumentProfiles.ArchetypeId))DocumentProfiles.Add(findings,"ADL_DECLARATION_PREFLIGHT","/","No supported leading ADL declaration and archetype identifier were found.");
                DocumentProfiles.Add(findings,"ADL_GRAMMAR_NOT_EXECUTED","/","A recognised header is not an ADL parse or model validation; use the native engine with dependencies.",true);
            }
        }catch(ProcessingException error)when(error.Code is "DUPLICATE_JSON_MEMBER" or "DOCUMENT_EMPTY_OVERSIZED_OR_INVALID_ENCODING" or "XML_MALFORMED_OR_UNSAFE" or "XML_TOO_COMPLEX"){
            parse=false;DocumentProfiles.Add(findings,error.Code,"/","The document could not be parsed safely within the bounded profile.");stages["parse"]=Stage("parse","FAIL","Input safety and syntax.");
        }catch(System.Text.Json.JsonException){parse=false;DocumentProfiles.Add(findings,"JSON_MALFORMED","/","JSON is malformed or ambiguous.");stages["parse"]=Stage("parse","FAIL","Input safety and syntax.");}
        if(structure is not null&&format!="xml")stages["structure"]=Stage("structure",structure.Value?"PASS":"FAIL",format+"_bounded_document_profile");
        var errors=new JsonArray(findings.OfType<JsonObject>().Where(f=>S(f,"severity")=="error").Select(f=>(JsonNode)JsonValue.Create(S(f,"code")+": "+S(f,"message"))!).ToArray());var warnings=new JsonArray(findings.OfType<JsonObject>().Where(f=>S(f,"severity")=="warning").Select(f=>(JsonNode)JsonValue.Create(S(f,"message"))!).ToArray());
        if(format!="xml")warnings.Add("Document checks do not establish semantic validity, terminology suitability, openEHR conformance or deployability.");var failed=DocumentProfiles.Failed(findings);
        return Task.FromResult(new JsonObject{["format"]=format,["valid"]=failed?JsonValue.Create(false):format=="xml"?JsonValue.Create(true):null,["status"]=failed?"INVALID":format=="xml"?"VALIDATED":executed.Count==0?"NOT_EXECUTED":"PARTIAL",["parse_valid"]=parse,["structurally_valid"]=structure,["deterministic"]=true,["scope"]=format=="xml"?"xml_well_formedness":format+"_preflight",["validator"]="openehr-modelling-document-profiles/2",["executed_checks"]=executed,["stages"]=new JsonArray(stages.Values.Select(value=>(JsonNode)value).ToArray()),["findings"]=findings,["errors"]=errors,["warnings"]=warnings,["release_eligible"]=false,["clinical_approval"]=false,["content_sha256"]=Data.Hash(content),["validated_at"]=DateTimeOffset.UtcNow.ToString("O")});
    }
    public static JsonObject Stage(string name,string status,string reason)=>new(){["name"]=name,["status"]=status,["reason"]=reason,["qualified"]=false};
    public static JsonObject Finding(string severity,string code,string message)=>new(){["severity"]=severity,["code"]=code,["location"]="/",["message"]=message,["evidence"]=new JsonObject(),["remediation"]="Supply exact verified inputs and review the findings."};
    public static async Task<JsonObject> Quality(JsonObject args,StandardsGateway engine,CancellationToken cancellation){var result=await Validate(args,engine,cancellation);var steps=new JsonArray{new JsonObject{["name"]="model_preflight",["status"]=result["status"]!.DeepClone(),["report"]=result.DeepClone()}};foreach(var stage in (JsonArray)result["stages"]!)steps.Add(stage!.DeepClone());foreach(var name in new[]{"archetype_dependency_validation","ckm_version_validation","terminology_binding_validation","value_set_validation","terminology_version_check","opt_compilation","opt_validation","test_compositions","aql_execution","requirements_coverage"})steps.Add(Stage(name,"NOT_EXECUTED","No applicable verified context was supplied to this document-only operation."));return new JsonObject{["status"]=result["valid"]?.GetValue<bool>()==false?"FAIL":"INCOMPLETE",["release_eligible"]=false,["content_sha256"]=Data.Hash(S(args,"content")),["steps"]=steps,["findings"]=result["findings"]!.DeepClone(),["executed_at"]=DateTimeOffset.UtcNow.ToString("O")};}
    public static JsonObject Diff(string before,string after)=>XmlModelDiff.Compare(before,after);
}
