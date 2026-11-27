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
        var file=Data.Required(args,"filename");if(file.Length>128||file is "." or ".."||file.Any(c=>char.IsControl(c)||c is '/' or '\\' or '%'))throw new ProcessingException("IMPORT_FILENAME_OR_ID_INVALID");var bytes=Decode(Data.Required(args,"contentBase64"));string? text=null;try{text=new UTF8Encoding(false,true).GetString(bytes);if(text.Contains('\0'))text=null;}catch(DecoderFallbackException){}
        var type="UNKNOWN";var format="binary";var findings=new JsonArray();
        if(bytes.Length>=4&&bytes[0]==80&&bytes[1]==75){type="MODEL_PACKAGE";format="zip";findings.Add("Archives are preserved without extraction.");}
        else if(text is not null){
            var value=text.TrimStart('\uFEFF',' ','\t','\r','\n');
            if(value.StartsWith('<')){format="xml";try{var xml=Xml(text);var name=xml.Root?.Name.LocalName;type=name=="template"?(xml.Descendants().Any(e=>e.Name.LocalName=="template_id")?"OPT":"OET_TEMPLATE"):name=="archetype"?"ADL_ARCHETYPE":"OTHER";}catch(ProcessingException){findings.Add("XML_MALFORMED_OR_UNSAFE");}}
            else if(value.StartsWith('{')||value.StartsWith('[')){format="json";try{var json=Data.ParseStrict(bytes);if(json is JsonObject o){type=o["_type"]?.GetValue<string>()=="COMPOSITION"?"CANONICAL_COMPOSITION":o["tree"] is not null&&o["templateId"] is not null?"WEB_TEMPLATE":o["archetype_id"] is not null?"DESIGNER_AUTHORING_JSON":o["resourceType"]?.GetValue<string>() is "CodeSystem" or "ValueSet" or "ConceptMap"?"TERMINOLOGY_ARTEFACT":o.Any(p=>p.Key.Contains('|')||p.Key.Contains('/'))?"FLAT_COMPOSITION":"OTHER";}else type="OTHER";}catch(System.Text.Json.JsonException){findings.Add("JSON_MALFORMED");}}
            else{format="text";if(Regex.IsMatch(value,"^(?:--[^\\n]*\\n|\\s)*archetype\\b"))type="ADL_ARCHETYPE";else if(Regex.IsMatch(value,"^(?:--[^\\n]*\\n|\\s)*template\\b"))type="ADL_TEMPLATE";else type="OTHER";}
        }
        var declared=S(args,"declaredType","UNKNOWN");var mismatch=declared!="UNKNOWN"&&declared!="OTHER"&&declared!=type;
        return new JsonObject{["schema_version"]=1,["filename"]=file,["source_sha256"]=Convert.ToHexStringLower(SHA256.HashData(bytes)),["size_bytes"]=bytes.Length,["declared_type"]=declared,["detected_type"]=type,["format"]=format,["type_match"]=!mismatch,["findings"]=findings,["clinical_approval"]=false,["validation_status"]="NOT_EXECUTED",["scope"]="Type inspection only; not conformance, clinical approval or a patient-data detector."};
    }
    public static JsonObject Import(SnapshotRepository repository,JsonObject args,ModellingIdentity actor){
        var project=Data.Required(args,"project");var inspection=Inspect(args);var claims=args["sourceClaims"] as JsonObject??new JsonObject();FhirWorkspace.NoSecrets(claims);
        var identity=new JsonObject{["schema_version"]=1,["project"]=project,["filename"]=args["filename"]!.DeepClone(),["sha256"]=inspection["source_sha256"]!.DeepClone(),["declared_type"]=S(args,"declaredType","UNKNOWN"),["claims"]=claims.DeepClone(),["requester"]=new JsonObject{["id"]=actor.Id,["tenant"]=actor.Tenant}};
        var subject=Data.Hash("model-import/1\n"+Data.Canonical(identity));var path="originals/"+subject+"/"+S(args,"filename");using var ledger=new AuditLedger();var events=ledger.Events(actor.Tenant,subject);
        if(events.Count==0){try{ledger.Append(actor.Tenant,subject,0,new JsonObject{["type"]="MODEL_IMPORT_REQUESTED",["project"]=project,["identity"]=identity,["actor"]=Actor(actor),["path"]=path,["inspection"]=inspection,["claim_assurance"]="CALLER_DECLARED",["source_system_verified"]=false});}catch(ProcessingException e)when(e.Code=="GOVERNANCE_REVISION_CONFLICT"){}events=ledger.Events(actor.Tenant,subject);}
        if(S((JsonObject)events[0]!,"type")!="MODEL_IMPORT_REQUESTED"||Data.Canonical(events[0]!["identity"])!=Data.Canonical(identity))throw new ProcessingException("IMPORT_IDENTITY_CONFLICT");
        if(events.Count==1){JsonObject original;try{original=repository.Original(project,S(args,"filename"),Decode(S(args,"contentBase64")),new JsonObject{["kind"]="original_source",["import_subject"]=subject},subject);}catch(ProcessingException e)when(e.Code=="IMPORT_ORIGINAL_EXISTS"){original=repository.Artifact(project,path);}if(S(original,"sha256")!=inspection["source_sha256"]!.GetValue<string>())throw new ProcessingException("IMPORT_ORIGINAL_INTEGRITY_FAILED");try{ledger.Append(actor.Tenant,subject,1,new JsonObject{["type"]="MODEL_IMPORT_STORED",["project"]=project,["actor"]=Actor(actor),["source"]=new JsonObject{["project"]=project,["path"]=path,["revision"]=original["revision"]!.DeepClone(),["sha256"]=original["sha256"]!.DeepClone()},["size_bytes"]=original["size_bytes"]!.DeepClone(),["clinical_approval"]=false});}catch(ProcessingException e)when(e.Code=="GOVERNANCE_REVISION_CONFLICT"){} }
        return Provenance(repository,project,subject,actor);
    }
    public static JsonObject Actor(ModellingIdentity actor)=>new(){["id"]=actor.Id,["tenant"]=actor.Tenant,["roles"]=new JsonArray((actor.Roles??[]).Select(r=>(JsonNode)JsonValue.Create(r)!).ToArray()),["method"]=actor.Method,["human"]=actor.Human};
    public static JsonObject Provenance(SnapshotRepository repository,string project,string subject,ModellingIdentity actor){repository.Project(project);using var ledger=new AuditLedger();var events=ledger.Events(actor.Tenant,subject);if(events.Count<1||S((JsonObject)events[0]!,"type")!="MODEL_IMPORT_REQUESTED"||S((JsonObject)events[0]!,"project")!=project)throw new ProcessingException("IMPORT_NOT_FOUND");var intent=(JsonObject)events[0]!;var source=events.Count==2?events[1]!["source"] as JsonObject:null;var intact=false;if(source is not null){var artifact=repository.Artifact(project,S(source,"path"),S(source,"revision"));var bytes=artifact["content_encoding"]?.GetValue<string>()=="base64"?Convert.FromBase64String(S(artifact,"content_base64")):Encoding.UTF8.GetBytes(S(artifact,"content"));intact=Convert.ToHexStringLower(SHA256.HashData(bytes))==S(source,"sha256");}return new JsonObject{["subject"]=subject,["project"]=project,["state"]=source is null?"PENDING":"STORED",["source"]=source?.DeepClone(),["inspection"]=intent["inspection"]?.DeepClone(),["claims"]=intent["identity"]?["claims"]?.DeepClone(),["claim_assurance"]="CALLER_DECLARED",["source_system_verified"]=false,["integrity"]=intact?"PASS":"NOT_VERIFIED",["events"]=events,["clinical_approval"]=false};}
}
