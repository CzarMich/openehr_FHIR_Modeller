using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Modeller.Core;
namespace Modeller.Application;

internal static class DocumentProfiles
{
    internal const string ArchetypeId="^openEHR-[A-Z_]+-[A-Z_]+\\.[a-zA-Z0-9_-]+(?:\\.[a-zA-Z0-9_-]+)*\\.v[0-9]+(?:\\.[0-9]+)*$";
    private const string Segment=@"[\p{L}\p{M}_][\p{L}\p{M}\p{N}_.-]*(?::(?:0|[1-9][0-9]{0,9}))?";
    private const string Suffix="[a-zA-Z_][a-zA-Z_0-9]*";
    private static bool Match(string text,string pattern)=>Regex.IsMatch(text,"\\A(?:"+pattern+")\\z",RegexOptions.CultureInvariant);
    private static string Escape(string key)=>key.Replace("~","~0",StringComparison.Ordinal).Replace("/","~1",StringComparison.Ordinal);
    internal static void Add(JsonArray findings,string code,string location,string message,bool warning=false){var finding=ModelChecks.Finding(warning?"warning":"error",code,message);finding["location"]=location;findings.Add(finding);}
    internal static bool Failed(JsonArray findings)=>findings.OfType<JsonObject>().Any(item=>item["severity"]?.GetValue<string>()=="error");
    internal static void Simplified(JsonNode? document,string format,JsonArray findings){
        if(document is not JsonObject{Count:>0} root){Add(findings,"SIMPLIFIED_ROOT","/","A nonempty JSON object is required.");return;}
        void Number(JsonNode? item,string at){if(item is JsonValue number&&number.TryGetValue<double>(out var value)&&!double.IsFinite(value))Add(findings,"JSON_NUMBER_RANGE",at,"The number is not a finite runtime value.");}
        void Raw(JsonNode? item,string at){if(item is JsonValue text&&text.TryGetValue<string>(out var raw)){try{item=Data.ParseStrict(Encoding.UTF8.GetBytes(raw));Add(findings,"LEGACY_STRINGIFIED_RAW",at,"Serialized raw JSON is a provider compatibility form; prefer an object and verify the target format.",true);}catch(Exception error)when(error is System.Text.Json.JsonException||error is ProcessingException{Code:"DUPLICATE_JSON_MEMBER"}){Add(findings,"RAW_JSON_INVALID",at,"Serialized raw JSON is malformed or ambiguous.");return;}}
            if(item is not JsonObject obj||obj["_type"] is not JsonValue type||!type.TryGetValue<string>(out var name)||!Match(name,"[A-Z][A-Z0-9_]{0,99}"))Add(findings,"RAW_TYPE_REQUIRED",at,"A raw object requires an explicit _type. RM properties and template compatibility are not assessed.");}
        void Key(string key,string at,bool suffix){if(Encoding.UTF8.GetByteCount(key)>300||!Match(key,Segment+(suffix?"|\\|"+Suffix:"")))Add(findings,"STRUCTURED_FIELD_IDENTIFIER",at,"Use one node identifier or a separate pipe-prefixed attribute; slash paths belong to FLAT.");}
        void Object(JsonObject obj,string at,bool context){if(obj.Count==0)Add(findings,"EMPTY_STRUCTURED_OBJECT",at,"Empty structured objects should be omitted.",true);foreach(var(key,item)in obj){var path=at+"/"+Escape(key);Key(key,path,true);
            if(key=="|raw")Raw(item,path);
            else if(key.StartsWith('|')||context&&item is not(JsonArray or JsonObject)){if(item is JsonArray or JsonObject)Add(findings,"STRUCTURED_ATTRIBUTE_VALUE",path,"Attributes require scalar or null values.");else Number(item,path);}
            else if(context&&item is JsonObject child)Object(child,path,true);
            else if(item is not JsonArray occurrences)Add(findings,"STRUCTURED_NODE_ARRAY",path,"Data nodes require arrays, including single occurrences.");
            else for(var index=0;index<occurrences.Count;index++){var occurrence=occurrences[index];var location=path+"/"+index;if(occurrence is JsonObject value)Object(value,location,context);else if(occurrence is JsonArray)Add(findings,"STRUCTURED_NESTED_ARRAY",location,"An occurrence cannot be another array.");else Number(occurrence,location);}
        }}
        foreach(var(key,item)in root){var path="/"+Escape(key);if(format=="flat"){
                if(Encoding.UTF8.GetByteCount(key)>2000||!Match(key,Segment+"(?:/"+Segment+")*(?:\\|"+Suffix+")?"))Add(findings,"FLAT_FIELD_IDENTIFIER",path,"The field identifier is outside the bounded FLAT syntax profile.");
                if(key.EndsWith("|raw",StringComparison.Ordinal))Raw(item,path);else if(item is JsonArray or JsonObject)Add(findings,"FLAT_VALUE_SHAPE",path,"Ordinary FLAT fields require scalar or null values; raw objects use |raw.");else Number(item,path);
            }else{Key(key,path,false);if(item is not JsonObject obj)Add(findings,"STRUCTURED_ROOT_VALUE",path,"Composition and ctx roots require objects.");else Object(obj,path,key=="ctx");}}
    }
    internal static void Template(XDocument document,string format,JsonArray findings){
        var root=document.Root;var namespaces=format=="oet"?new[]{"openEHR/v1/Template"}:new[]{"http://schemas.openehr.org/v1","http://schemas.openehr.org/v2"};
        if(root is null||root.Name.LocalName!="template"||!namespaces.Contains(root.Name.NamespaceName)){Add(findings,"TEMPLATE_ROOT","/1","Unexpected template root or namespace for this profile.");return;}
        XElement[] Children(XElement node,string name)=>node.Elements(node.Name.Namespace+name).ToArray();
        foreach(var name in format=="oet"?new[]{"id","name","definition"}:new[]{"template_id","definition","language","concept"}){var children=Children(root,name);if(children.Length!=1)Add(findings,"TEMPLATE_REQUIRED_ELEMENT","/1","Exactly one "+name+" element is required.");else if(new[]{"id","name","template_id","concept"}.Contains(name)&&string.IsNullOrWhiteSpace(children[0].Value))Add(findings,"TEMPLATE_EMPTY_IDENTITY","/1","The "+name+" value must not be empty.");}
        if(Children(root,"description").FirstOrDefault() is not XElement description||string.IsNullOrWhiteSpace(description.Value))Add(findings,"MISSING_DESCRIPTION","/1","Record the template purpose, intended use and clinical scope.",true);
        var definition=Children(root,"definition").FirstOrDefault();
        string? Type(XElement node,string at){var type=(string?)node.Attribute(XName.Get("type","http://www.w3.org/2001/XMLSchema-instance"))??"";var match=Regex.Match(type,"\\A(?:[A-Za-z_][A-Za-z0-9_.-]*:)?([A-Z][A-Z0-9_]*)\\z");if(!match.Success){Add(findings,"OET_RM_TYPE_MISSING_OR_INVALID",at,"A definition or placement requires a supported xsi:type.");return null;}if(type.Contains(':')&&node.GetNamespaceOfPrefix(type.Split(':')[0])!=root.Name.Namespace){Add(findings,"OET_RM_TYPE_NAMESPACE_INVALID",at,"The xsi:type prefix must resolve to the template namespace.");return null;}return match.Groups[1].Value;}
        static bool Greater(string left,string right){left=left.TrimStart('0');right=right.TrimStart('0');return left.Length==right.Length?string.CompareOrdinal(left,right)>0:left.Length>right.Length;}
        void Interval(XElement node,string at){var values=new Dictionary<string,string>();foreach(var name in new[]{"lower","upper","lower_unbounded","upper_unbounded","lower_included","upper_included"}){var parts=Children(node,name);if(parts.Length>1)Add(findings,"DUPLICATE_INTERVAL_FIELD",at,"An interval repeats a bound or flag.");if(parts.Length>0)values[name]=parts[0].Value.Trim();}
            foreach(var bound in new[]{"lower","upper"}){var unbounded=values.GetValueOrDefault(bound+"_unbounded") is "true" or "1";if(values.TryGetValue(bound,out var value)){if(!Match(value,"[0-9]+")||unbounded)Add(findings,"INVALID_INTERVAL_BOUND",at,"A bound must be nonnegative and consistent with its unbounded flag.");}else if(!unbounded)Add(findings,"MISSING_INTERVAL_BOUND",at,"Provide a bound or an explicit unbounded flag.");foreach(var flag in new[]{"_unbounded","_included"})if(values.TryGetValue(bound+flag,out var boolean)&&boolean is not("true" or "false" or "1" or "0"))Add(findings,"INVALID_INTERVAL_FLAG",at,"Interval flags require XML booleans.");}
            if(values.TryGetValue("lower",out var lower)&&values.TryGetValue("upper",out var upper)&&Match(lower,"[0-9]+")&&Match(upper,"[0-9]+")&&Greater(lower,upper))Add(findings,"REVERSED_INTERVAL",at,"The lower bound exceeds the upper bound.");}
        void Walk(XElement node,string at){if(node.Name.Namespace!=root.Name.Namespace)Add(findings,"UNASSESSED_XML_NAMESPACE",at,"This profile does not assess another namespace; validate the extension separately.",true);
            else if(format=="oet"){
                var placement=node==definition||new[]{"Content","Item","Items"}.Contains(node.Name.LocalName);var identity=(string?)node.Attribute("archetype_id");if(placement&&identity is null)Add(findings,"MISSING_ARCHETYPE_REFERENCE",at,"An OET definition or placement requires an archetype reference.");if(identity is not null&&!Regex.IsMatch(identity,ArchetypeId))Add(findings,"INVALID_ARCHETYPE_REFERENCE",at,"Unsupported archetype identifier syntax.");
                if(placement){var type=Type(node,at);if(node==definition&&type!="COMPOSITION")Add(findings,"OET_ROOT_TYPE_INVALID",at,"The root definition must be COMPOSITION.");var match=Regex.Match(identity??"","^openEHR-[A-Z_]+-([A-Z_]+)\\.");if(match.Success&&type is not null&&type!=match.Groups[1].Value)Add(findings,"OET_RM_TYPE_REFERENCE_MISMATCH",at,"The xsi:type and archetype RM class differ.");
                    if(node!=definition){var parent=node.Parent is null?null:Type(node.Parent,at);var expected=parent switch{"COMPOSITION"=>"Content","SECTION"=>"Item","OBSERVATION" or "EVALUATION" or "INSTRUCTION" or "ACTION" or "ADMIN_ENTRY" or "CLUSTER"=>"Items",_=>null};if(expected is null||node.Name.LocalName!=expected)Add(findings,"OET_PLACEMENT_KIND_INVALID",at,"The placement element does not match its parent RM type.");}}
                foreach(var bound in new[]{"min","max"})if(node.Attribute(bound) is XAttribute value&&!Match(value.Value,bound=="min"?"[0-9]+":"[0-9]+|\\*"))Add(findings,"INVALID_OCCURRENCE_BOUND",at,"Occurrences require nonnegative integers or an upper asterisk.");
                if(node.Attribute("min") is XAttribute min&&node.Attribute("max") is XAttribute max&&Match(min.Value,"[0-9]+")&&Match(max.Value,"[0-9]+")&&Greater(min.Value,max.Value))Add(findings,"REVERSED_OCCURRENCES",at,"The minimum exceeds the maximum.");
                var path=(string?)node.Attribute("path");if(node.Name.LocalName=="Rule"&&(path is null||!path.StartsWith('/'))||path?.Any(char.IsControl)==true)Add(findings,"INVALID_RULE_PATH",at,"Rules require absolute model paths without control characters.");
            }else{
                if(node.Name.LocalName=="archetype_id"&&!Regex.IsMatch(node.Value.Trim(),ArchetypeId))Add(findings,"INVALID_ARCHETYPE_REFERENCE",at,"Unsupported archetype identifier syntax.");
                if(node.Name.LocalName=="rm_type_name"&&!Match(node.Value.Trim(),"[A-Z][A-Z0-9_]{0,99}"))Add(findings,"INVALID_RM_TYPE_SYNTAX",at,"The RM type name is malformed; membership remains a separate check.");
                if(node.Name.LocalName is "occurrences" or "existence"||node.Name.LocalName=="interval"&&node.Parent?.Name.LocalName=="cardinality")Interval(node,at);
            }
            var index=0;foreach(var child in node.Elements())Walk(child,at+"/"+(++index));
        }Walk(root,"/1");
    }
}
