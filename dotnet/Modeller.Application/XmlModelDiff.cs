using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Modeller.Core;
namespace Modeller.Application;

internal static class XmlModelDiff
{
    private static string S(JsonObject obj,string key)=>KnowledgeCorpus.Text(obj,key);
    private static Dictionary<string,JsonObject> Projection(string content){
        var document=Imports.Xml(content);var result=new Dictionary<string,JsonObject>(StringComparer.Ordinal);
        void Walk(XElement node,string parent){var identity=((string?)node.Attribute("path")??"")+"|"+((string?)node.Attribute("archetype_id")??"");var basis=parent+"/"+node.Name.LocalName+"["+identity+"]";var key=basis;var suffix=1;while(result.ContainsKey(key))key=basis+"#"+(++suffix);
            var attributes=new JsonObject();foreach(var attribute in node.Attributes().OrderBy(a=>a.Name.ToString(),StringComparer.Ordinal)){var prefix=node.GetPrefixOfNamespace(attribute.Name.Namespace);var name=attribute.IsNamespaceDeclaration?attribute.Name.LocalName=="xmlns"?"xmlns":"xmlns:"+attribute.Name.LocalName:!string.IsNullOrEmpty(prefix)?prefix+":"+attribute.Name.LocalName:attribute.Name.LocalName;attributes[name]=attribute.Value;}
            result[key]=new JsonObject{["element"]=node.Name.LocalName,["attributes"]=attributes,["text"]=string.Concat(node.Nodes().OfType<XText>().Select(text=>text.Value)).Trim()};foreach(var child in node.Elements())Walk(child,key);
        }if(document.Root is not null)Walk(document.Root,"");return result;
    }
    private static string Dimension(string element,string field,string value){var name=(element+" "+field).ToLowerInvariant();
        if(Regex.IsMatch(name,"(^|\\s|_)(language|lang)(_|\\s|$)"))return "languages";
        if(new[]{"terminology","value_set","code_phrase","code_string"}.Any(name.Contains))return "terminology_bindings";
        if(new[]{"slot","archetype_ref","include"}.Any(name.Contains))return "slots_and_dependencies";
        if(new[]{"annotation","comment"}.Any(name.Contains))return "annotations";
        if(name.Contains("description",StringComparison.Ordinal)||new[]{"name","purpose","use","misuse","keywords"}.Contains(element.ToLowerInvariant()))return "descriptions";
        if(name.Contains("occurrence",StringComparison.Ordinal)||name.Contains("cardinality",StringComparison.Ordinal)||Regex.IsMatch(name,"(^|\\s)(min|max|lower|upper)(\\s|$)"))return "occurrences_and_cardinalities";
        if(name.Contains("unit",StringComparison.Ordinal))return "units";if(name.Contains("path",StringComparison.Ordinal))return "paths";
        if(new[]{"archetype_id","template_id","identifier"}.Any(name.Contains))return "archetype_identifiers";
        if(name.Contains("node_id",StringComparison.Ordinal)||Regex.IsMatch(value,"\\bat[0-9]{4,}\\b"))return "node_identifiers";
        if(name.Contains("rm_type",StringComparison.Ordinal)||name.Contains("xsi:type",StringComparison.Ordinal))return "rm_types";
        if(element.StartsWith("c_",StringComparison.OrdinalIgnoreCase)||name.Contains("constraint",StringComparison.Ordinal)||name.Contains("rule",StringComparison.Ordinal))return "constraints";
        return "structure_or_unclassified";
    }
    public static JsonObject Compare(string before,string after){
        if(Encoding.UTF8.GetByteCount(before)>2097152||Encoding.UTF8.GetByteCount(after)>2097152)throw new ProcessingException("DOCUMENT_LIMIT");var a=Projection(before);var b=Projection(after);var added=b.Where(p=>!a.ContainsKey(p.Key)).ToDictionary(StringComparer.Ordinal);var removed=a.Where(p=>!b.ContainsKey(p.Key)).ToDictionary(StringComparer.Ordinal);var changed=new Dictionary<string,JsonObject>(StringComparer.Ordinal);
        foreach(var(path,value)in a)if(b.TryGetValue(path,out var other)&&!JsonNode.DeepEquals(value,other))changed[path]=new JsonObject{["before"]=value.DeepClone(),["after"]=other.DeepClone()};
        var differences=new JsonArray();var complete=true;const int maximum=1000;void Add(JsonObject difference){if(differences.Count<maximum)differences.Add(difference);else complete=false;}
        Dictionary<string,List<string>> Index(Dictionary<string,JsonObject> values){var index=new Dictionary<string,List<string>>(StringComparer.Ordinal);foreach(var(path,value)in values){var attributes=(JsonObject)value["attributes"]!;var archetype=S(attributes,"archetype_id");var node=S(attributes,"node_id");if(archetype==""&&node=="")continue;var identity=Data.Canonical(new JsonArray(S(value,"element"),archetype,node));if(!index.TryGetValue(identity,out var locations))index[identity]=locations=[];locations.Add(path);}return index;}
        var newIndex=Index(added);var oldIndex=Index(removed);var movedAdded=new HashSet<string>(StringComparer.Ordinal);var movedRemoved=new HashSet<string>(StringComparer.Ordinal);
        foreach(var(identity,oldLocations)in oldIndex)if(oldLocations.Count==1&&newIndex.TryGetValue(identity,out var newLocations)&&newLocations.Count==1){var location=newLocations[0];var old=oldLocations[0];movedAdded.Add(location);movedRemoved.Add(old);Add(new JsonObject{["change"]="moved",["location"]=location,["before_location"]=old,["dimension"]="paths",["identity"]=identity,["before"]=removed[old].DeepClone(),["after"]=added[location].DeepClone()});}
        foreach(var(path,value)in added)if(!movedAdded.Contains(path))Add(new JsonObject{["change"]="added",["location"]=path,["dimension"]=Dimension(S(value,"element"),"",S(value,"text")),["before"]=null,["after"]=value.DeepClone()});
        foreach(var(path,value)in removed)if(!movedRemoved.Contains(path))Add(new JsonObject{["change"]="removed",["location"]=path,["dimension"]=Dimension(S(value,"element"),"",S(value,"text")),["before"]=value.DeepClone(),["after"]=null});
        foreach(var(path,delta)in changed){var left=(JsonObject)delta["before"]!;var right=(JsonObject)delta["after"]!;var leftAttributes=(JsonObject)left["attributes"]!;var rightAttributes=(JsonObject)right["attributes"]!;
            foreach(var field in leftAttributes.Select(p=>p.Key).Concat(rightAttributes.Select(p=>p.Key)).Distinct(StringComparer.Ordinal))if(!JsonNode.DeepEquals(leftAttributes[field],rightAttributes[field]))Add(new JsonObject{["change"]="modified",["location"]=path,["field"]=field,["dimension"]=Dimension(S(right,"element"),field,(rightAttributes[field]??leftAttributes[field])?.GetValue<string>()??""),["before"]=leftAttributes[field]?.DeepClone(),["after"]=rightAttributes[field]?.DeepClone()});
            if(S(left,"text")!=S(right,"text"))Add(new JsonObject{["change"]="modified",["location"]=path,["field"]="text",["dimension"]=Dimension(S(right,"element"),"text",S(right,"text")),["before"]=left["text"]!.DeepClone(),["after"]=right["text"]!.DeepClone()});
        }
        JsonObject Limited(Dictionary<string,JsonObject> values){if(values.Count>maximum)complete=false;return new JsonObject(values.Take(maximum).Select(p=>new KeyValuePair<string,JsonNode?>(p.Key,p.Value.DeepClone())));}
        var additions=Limited(added);var removals=Limited(removed);var modifications=Limited(changed);
        return new JsonObject{["scope"]="bounded_xml_semantic_projection",["status"]="PARTIAL",["before_sha256"]=Data.Hash(before),["after_sha256"]=Data.Hash(after),["added"]=additions,["removed"]=removals,["changed"]=modifications,["semantic_differences"]=differences,["truncated"]=!complete,["complete"]=complete,["limit"]=maximum,["limitations"]=new JsonArray("Explicit XML projection only; inherited constraints, dependencies and full semantic equivalence are unresolved.","Ambiguous moves remain separate additions/removals. At most 1000 entries per returned map and semantic difference list; narrow inputs if truncated.")};
    }
}
