using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Modeller.Core;
namespace Modeller.Application;

public static class Imports
{
    private static string S(JsonObject o,string k,string fallback="")=>KnowledgeCorpus.Text(o,k,fallback);
    private static byte[] Decode(string text){byte[] bytes;try{bytes=Convert.FromBase64String(text);}catch(FormatException){throw new ProcessingException("IMPORT_BASE64_INVALID");}if(bytes.Length is <1 or >2097152||Convert.ToBase64String(bytes)!=text)throw new ProcessingException("IMPORT_BASE64_INVALID");return bytes;}
    public static XDocument Xml(string content){if(content.Length is <1 or >2097152||content.Contains('\0'))throw new ProcessingException("XML_EMPTY_OVERSIZED_OR_UNSAFE");using var reader=XmlReader.Create(new StringReader(content),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=2097152});try{var doc=XDocument.Load(reader);if(doc.Descendants().Take(20001).Count()>20000)throw new ProcessingException("XML_TOO_COMPLEX");return doc;}catch(XmlException){throw new ProcessingException("XML_MALFORMED_OR_UNSAFE");}}
    public static JsonObject Inspect(JsonObject args){
        var file=Data.Required(args,"filename");if(file.Length is <1 or >128||file is "." or ".."||file.Any(c=>char.IsControl(c)||c is '/' or '\\' or '%'))throw new ProcessingException("IMPORT_FILENAME_OR_ID_INVALID");
        var declared=S(args,"declaredType","UNKNOWN");if(!new[]{"ADL_ARCHETYPE","ADL_TEMPLATE","OET_TEMPLATE","OPT","WEB_TEMPLATE","DESIGNER_AUTHORING_JSON","CANONICAL_COMPOSITION","FLAT_COMPOSITION","STRUCTURED_COMPOSITION","TERMINOLOGY_ARTEFACT","MODEL_PACKAGE","OTHER","UNKNOWN"}.Contains(declared,StringComparer.Ordinal))throw new ProcessingException("IMPORT_ARTIFACT_TYPE_INVALID");
        var bytes=Decode(Data.Required(args,"contentBase64"));var findings=new JsonArray();var hint=file.EndsWith(".t.json",StringComparison.OrdinalIgnoreCase)?"DESIGNER_AUTHORING_JSON":null;
        var result=new JsonObject{["schema_version"]=1,["inspector"]="model-artifact-types/1",["source_sha256"]=Convert.ToHexStringLower(SHA256.HashData(bytes)),["detected_type"]="UNKNOWN",["declared_type"]=declared,["effective_type"]=declared,["classification_basis"]=declared=="UNKNOWN"?"UNKNOWN":"CALLER_DECLARED",["format"]="opaque",["syntax"]="NOT_EXECUTED",["identifier"]=null,["finding_codes"]=findings,["conformance"]="NOT_EXECUTED",["source_system_verified"]=false,["filename_hint"]=hint};
        string text;try{text=new UTF8Encoding(false,true).GetString(bytes);if(text.Contains('\0'))throw new DecoderFallbackException();}catch(DecoderFallbackException){findings.Add("NON_UTF8_OR_BINARY_SOURCE_PRESERVED");return result;}
        var content=text.TrimStart('\uFEFF');var value=content.TrimStart();
        try{
            if(value.StartsWith('<')){result["format"]="xml";var xml=Xml(content);result["syntax"]="PASS";if(xml.Root?.Name==XName.Get("template","openEHR/v1/Template")){result["detected_type"]="OET_TEMPLATE";result["format"]="oet";}else if(xml.Root?.Name==XName.Get("template","http://schemas.openehr.org/v1")){result["detected_type"]="OPT";result["format"]="opt14_xml";}}
            else if(value.StartsWith('{')||value.StartsWith('[')){result["format"]="json";var json=Data.ParseStrict(Encoding.UTF8.GetBytes(content));result["syntax"]="PASS";if(json is JsonObject o&&hint!="DESIGNER_AUTHORING_JSON"&&declared!="DESIGNER_AUTHORING_JSON"){
                if(o["_type"]?.GetValue<string>()=="COMPOSITION"){result["detected_type"]="CANONICAL_COMPOSITION";result["format"]="canonical_json";}
                else if(o["resourceType"]?.GetValue<string>() is "CodeSystem" or "ValueSet" or "ConceptMap"){result["detected_type"]="TERMINOLOGY_ARTEFACT";result["format"]="fhir_terminology_json";}
                else if(o["templateId"]?.GetValueKind()==System.Text.Json.JsonValueKind.String&&o["tree"] is JsonObject tree&&tree["rmType"]?.GetValue<string>()=="COMPOSITION"){result["detected_type"]="WEB_TEMPLATE";result["format"]="web_template_json";}
            }}else{
                var header=Regex.Match(content,@"\A(?:\s|--[^\r\n]*(?:\r?\n|$))*(archetype|template|operational_template)\b(?:[ \t]*\(([^\r\n()]{0,1000})\))?\s+(openEHR-[^\s;]+)(?:\s|$)");
                if(header.Success&&Regex.IsMatch(header.Groups[3].Value,@"^openEHR-[A-Z_]+-[A-Z_]+\.[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.v[0-9]+(?:\.[0-9]+)*$")){
                    var kind=header.Groups[1].Value;result["detected_type"]=kind=="archetype"?"ADL_ARCHETYPE":kind=="template"?"ADL_TEMPLATE":"OPT";result["format"]="adl_unspecified";var version=Regex.Match(header.Groups[2].Value,@"(?:^|;)\s*adl_version\s*=\s*(1\.4|2\.0(?:\.6)?)\s*(?:;|$)");if(version.Success)result["format"]=version.Groups[1].Value=="1.4"?"adl14":kind=="archetype"?"adl2":kind=="template"?"adlt2":"opt2_adl";result["identifier"]=header.Groups[3].Value;findings.Add("ADL_HEADER_RECOGNIZED_GRAMMAR_NOT_EXECUTED");
                }
            }
        }catch(Exception e)when(e is ProcessingException or System.Text.Json.JsonException or InvalidOperationException){result["syntax"]="FAIL";findings.Add("SOURCE_SYNTAX_UNSAFE_OR_INVALID");}
        var detected=S(result,"detected_type");if(detected!="UNKNOWN"){result["effective_type"]=detected;result["classification_basis"]="CONTENT_MARKERS";if(declared!="UNKNOWN"&&declared!=detected)findings.Add("DECLARED_TYPE_CONFLICT");}else findings.Add("SOURCE_TYPE_UNVERIFIED");return result;
    }
    public static JsonObject Import(SnapshotRepository repository,JsonObject args,ModellingIdentity actor){
        var project=Data.Required(args,"project");var inspection=Inspect(args);var claims=Claims(args["sourceClaims"] as JsonObject??new JsonObject());
        var identity=new JsonObject{["schema_version"]=1,["project"]=project,["filename"]=args["filename"]!.DeepClone(),["sha256"]=inspection["source_sha256"]!.DeepClone(),["declared_type"]=S(args,"declaredType","UNKNOWN"),["claims"]=claims.DeepClone(),["requester"]=new JsonObject{["id"]=actor.Id,["tenant"]=actor.Tenant}};
        var subject=Data.Hash("model-import/1\n"+HistoricJson.Encode(identity));var path="originals/"+subject+"/"+S(args,"filename");using var ledger=new AuditLedger();var events=ledger.Events(actor.Tenant,subject);
        if(events.Count==0){try{ledger.Append(actor.Tenant,subject,0,new JsonObject{["type"]="MODEL_IMPORT_REQUESTED",["project"]=project,["identity"]=identity,["actor"]=Actor(actor),["path"]=path,["inspection"]=inspection,["claim_assurance"]="CALLER_DECLARED",["source_system_verified"]=false});}catch(ProcessingException e)when(e.Code=="GOVERNANCE_REVISION_CONFLICT"){}events=ledger.Events(actor.Tenant,subject);}
        if(S((JsonObject)events[0]!,"type")!="MODEL_IMPORT_REQUESTED"||Data.Canonical(events[0]!["identity"])!=Data.Canonical(identity))throw new ProcessingException("IMPORT_IDENTITY_CONFLICT");
        if(events.Count==1){JsonObject original;try{original=repository.Original(project,S(args,"filename"),Decode(S(args,"contentBase64")),new JsonObject{["kind"]="original_source",["import_subject"]=subject},subject);}catch(ProcessingException e)when(e.Code=="IMPORT_ORIGINAL_EXISTS"){original=repository.Artifact(project,path);}if(S(original,"sha256")!=inspection["source_sha256"]!.GetValue<string>())throw new ProcessingException("IMPORT_ORIGINAL_INTEGRITY_FAILED");try{ledger.Append(actor.Tenant,subject,1,new JsonObject{["type"]="MODEL_IMPORT_STORED",["project"]=project,["actor"]=Actor(actor),["source"]=new JsonObject{["project"]=project,["path"]=path,["revision"]=original["revision"]!.DeepClone(),["sha256"]=original["sha256"]!.DeepClone()},["size_bytes"]=original["size_bytes"]!.DeepClone(),["clinical_approval"]=false});}catch(ProcessingException e)when(e.Code=="GOVERNANCE_REVISION_CONFLICT"){} }
        return Provenance(repository,project,subject,actor);
    }
    private static JsonObject Claims(JsonObject supplied){
        var allowed=new[]{"source_system","tool_version","external_identifier","external_revision","external_status","exported_at","licence","copyright"};
        if(supplied.Any(p=>!allowed.Contains(p.Key,StringComparer.Ordinal)||p.Value?.GetValueKind()!=System.Text.Json.JsonValueKind.String||p.Value.GetValue<string>().Length is <1 or >1000||p.Value.GetValue<string>().Any(char.IsControl)))throw new ProcessingException("IMPORT_SOURCE_CLAIMS_INVALID");
        if(supplied["exported_at"] is JsonValue date&&(!Regex.IsMatch(date.GetValue<string>(),@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$")||!DateTimeOffset.TryParse(date.GetValue<string>(),System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out _)))throw new ProcessingException("IMPORT_SOURCE_CLAIMS_INVALID");
        var claims=(JsonObject)supplied.DeepClone();claims.TryAdd("source_system","UNKNOWN");var sorted=new JsonObject();foreach(var pair in claims.OrderBy(p=>p.Key,StringComparer.Ordinal))sorted[pair.Key]=pair.Value?.DeepClone();return sorted;
    }
    public static JsonObject Actor(ModellingIdentity actor)=>new(){["id"]=actor.Id,["tenant"]=actor.Tenant,["roles"]=new JsonArray((actor.Roles??[]).Select(r=>(JsonNode)JsonValue.Create(r)!).ToArray()),["method"]=actor.Method,["human"]=actor.Human};
    public static JsonObject Provenance(SnapshotRepository repository,string project,string subject,ModellingIdentity actor){
        repository.Project(project);using var ledger=new AuditLedger();var events=ledger.Events(actor.Tenant,subject);
        if(events.Count<1||S((JsonObject)events[0]!,"type")!="MODEL_IMPORT_REQUESTED"||S((JsonObject)events[0]!,"project")!=project)throw new ProcessingException("IMPORT_NOT_FOUND");
        if(events.Count>2||events.Count==2&&S((JsonObject)events[1]!,"type")!="MODEL_IMPORT_STORED")throw new ProcessingException("IMPORT_AUDIT_INTEGRITY_FAILED");
        var intent=(JsonObject)events[0]!;var receipt=events.Count==2?(JsonObject)events[1]!:null;var source=receipt?["source"] as JsonObject;var integrity="NOT_STORED";
        if(source is not null){foreach(var artifact in new[]{repository.Artifact(project,S(source,"path"),S(source,"revision")),repository.Artifact(project,S(source,"path"))}){
            var bytes=artifact["content_encoding"]?.GetValue<string>()=="base64"?Convert.FromBase64String(S(artifact,"content_base64")):Encoding.UTF8.GetBytes(S(artifact,"content"));
            if(S(artifact,"status")=="DELETED"||S(artifact,"revision")!=S(source,"revision")||Convert.ToHexStringLower(SHA256.HashData(bytes))!=S(source,"sha256"))throw new ProcessingException("IMPORT_ORIGINAL_INTEGRITY_FAILED");
        }integrity="VERIFIED";}
        return new JsonObject{["schema_version"]=1,["import_id"]=subject,["status"]=receipt is null?"STORAGE_PENDING":"STORED_UNREVIEWED",["original"]=source?.DeepClone()??new JsonObject{["project"]=project,["path"]=intent["path"]?.DeepClone(),["sha256"]=intent["identity"]?["sha256"]?.DeepClone()},["source_claims"]=intent["identity"]?["claims"]?.DeepClone(),["claim_assurance"]="CALLER_DECLARED",["source_system_verified"]=false,["importing_actor"]=intent["actor"]?.DeepClone(),["requested_at"]=intent["timestamp"]?.DeepClone(),["stored_at"]=receipt?["timestamp"]?.DeepClone(),["inspection"]=intent["inspection"]?.DeepClone(),["original_integrity"]=integrity,["clinical_approval"]=false,["validation"]="NOT_EXECUTED",["events"]=events};
    }
}
