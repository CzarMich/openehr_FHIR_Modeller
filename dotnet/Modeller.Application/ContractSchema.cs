using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public static class ContractSchema
{
    public static void Validate(JsonNode? value,JsonObject schema) {
        var type=value switch {null=>"null",JsonObject=>"object",JsonArray=>"array",JsonValue v when v.TryGetValue<bool>(out _)=>"boolean",JsonValue v when v.TryGetValue<string>(out _)=>"string",_=>"number"};
        bool Accept(string t)=>t==type||t=="integer"&&type=="number"&&decimal.TryParse(value!.ToJsonString(),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var n)&&decimal.Truncate(n)==n;
        if(schema["type"] is JsonValue st&&!Accept(st.GetValue<string>())||schema["type"] is JsonArray types&&!types.Any(t=>Accept(t!.GetValue<string>())))throw new ProcessingException("INVALID_INPUT");
        if(schema["enum"] is JsonArray choices&&!choices.Any(c=>JsonNode.DeepEquals(c,value)))throw new ProcessingException("INVALID_INPUT");
        if(value is JsonObject obj){
            foreach(var required in (schema["required"] as JsonArray??[]))if(!obj.ContainsKey(required!.GetValue<string>()))throw new ProcessingException("INVALID_INPUT");
            var properties=schema["properties"] as JsonObject??new JsonObject();
            foreach(var (name,child) in obj){if(properties[name] is JsonObject property)Validate(child,property);else if(schema["additionalProperties"] is JsonObject extra)Validate(child,extra);else if(schema["additionalProperties"] is JsonValue a&&a.TryGetValue<bool>(out var allowed)&&!allowed)throw new ProcessingException("INVALID_INPUT");}
        }
        if(value is JsonArray array){Bounds(array.Count,schema,"minItems","maxItems");if(schema["uniqueItems"]?.GetValue<bool>()==true&&array.Select(Data.Canonical).Distinct(StringComparer.Ordinal).Count()!=array.Count)throw new ProcessingException("INVALID_INPUT");if(schema["items"] is JsonObject item)foreach(var child in array)Validate(child,item);}
        if(type=="string"){var text=value!.GetValue<string>();Bounds(text.EnumerateRunes().Count(),schema,"minLength","maxLength");if(schema["pattern"] is JsonValue pattern&&!Regex.IsMatch(text,pattern.GetValue<string>(),RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(200)))throw new ProcessingException("INVALID_INPUT");}
        if(type=="number"&&decimal.TryParse(value!.ToJsonString(),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out var number))Bounds(number,schema,"minimum","maximum");
    }
    private static void Bounds(decimal n,JsonObject schema,string min,string max){if(schema[min] is JsonValue a&&n<decimal.Parse(a.ToJsonString(),System.Globalization.CultureInfo.InvariantCulture)||schema[max] is JsonValue b&&n>decimal.Parse(b.ToJsonString(),System.Globalization.CultureInfo.InvariantCulture))throw new ProcessingException("INVALID_INPUT");}
    public static JsonObject Defaults(JsonObject input,JsonObject schema){var output=(JsonObject)input.DeepClone();foreach(var (k,v) in schema["properties"] as JsonObject??new JsonObject())if(!output.ContainsKey(k)&&v is JsonObject property&&property.ContainsKey("default"))output[k]=property["default"]?.DeepClone();return output;}
}
