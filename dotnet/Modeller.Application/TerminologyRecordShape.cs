using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Application;
public sealed partial class TerminologyWorkspace
{
    private static void RecordShape(JsonObject data){
        void Text(JsonObject obj,string key,int limit,bool required=false){if(obj[key] is null&&!required)return;if(obj[key] is not JsonValue value||!value.TryGetValue<string>(out var text)||text.Length==0||Encoding.UTF8.GetByteCount(text)>limit||text.Any(c=>c=='\u007f'||c<' '&&c is not('\t' or '\r' or '\n')))throw new ProcessingException("INVALID_TERMINOLOGY_TEXT");}
        IEnumerable<JsonObject> Objects(JsonObject obj,string key,int limit){if(obj[key] is null)return [];if(obj[key] is not JsonArray array||array.Count>limit||array.Any(item=>item is not JsonObject))throw new ProcessingException("INVALID_TERMINOLOGY_LIST");return array.OfType<JsonObject>();}
        void Coding(JsonNode? node){if(node is not JsonObject coding)throw new ProcessingException("INVALID_TERMINOLOGY_CODING");Data.Keys(coding,"system","version","code","display");Canonical(Data.Required(coding,"system"));Text(coding,"code",500,true);Text(coding,"version",200);Text(coding,"display",2000);}
        Text(data,"version",200,true);Text(data,"name",200,true);Text(data,"description",10000);Text(data,"language",100);foreach(var _ in Objects(data,"dependencies",500)){}
        if(data["case_sensitive"] is not null&&(data["case_sensitive"] is not JsonValue boolean||!boolean.TryGetValue<bool>(out _)))throw new ProcessingException("INVALID_CODE_SYSTEM_SEMANTICS");
        foreach(var concept in Objects(data,"concepts",5000)){
            Text(concept,"code",500,true);Text(concept,"display",2000,true);Text(concept,"version",200);Text(concept,"definition",10000);
            foreach(var designation in Objects(concept,"designation",100)){Data.Keys(designation,"language","value","use");Text(designation,"language",100,true);Text(designation,"value",2000,true);if(designation["use"] is not null)Coding(designation["use"]);}
            if(concept["parents"] is not null){if(concept["parents"] is not JsonArray{Count:<=50} parents||parents.Any(parent=>parent is not JsonValue value||!value.TryGetValue<string>(out var text)||text.Length==0||Encoding.UTF8.GetByteCount(text)>500))throw new ProcessingException("INVALID_CONCEPT_PARENTS");}
        }
        foreach(var mapping in Objects(data,"mappings",5000)){Coding(mapping["source"]);if(S(mapping,"relationship")!="unmatched"||mapping["target"] is not null)Coding(mapping["target"]);Text(mapping,"comment",10000);foreach(var condition in Objects(mapping,"conditions",100)){Data.Keys(condition,"property","value");Text(condition,"property",500,true);Text(condition,"value",2000,true);}}
    }
}
