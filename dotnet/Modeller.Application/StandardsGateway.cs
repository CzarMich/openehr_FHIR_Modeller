using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public sealed class StandardsGateway:IDisposable
{
    private readonly HttpClient http=Network.Client(TimeSpan.FromSeconds(650));
    public void Dispose()=>http.Dispose();
    public async Task<JsonObject> Native(string operation,string content,JsonArray? dependencies,CancellationToken cancellation) {
        if(string.IsNullOrWhiteSpace(content)||System.Text.Encoding.UTF8.GetByteCount(content)>2097152||content.Contains('\0'))throw new ProcessingException("ENGINE_INVALID_DOCUMENT");
        var items=new JsonArray();var ids=new HashSet<string>(StringComparer.Ordinal);
        foreach(var d in (dependencies??[]).OfType<JsonObject>().OrderBy(d=>d["identifier"]!.GetValue<string>(),StringComparer.Ordinal)){
            var id=Data.Required(d,"identifier");var text=Data.Required(d,"content");if(!Regex.IsMatch(id,"^[A-Za-z0-9][A-Za-z0-9_.:-]{1,299}$")||!ids.Add(id)||text.Length>2097152)throw new ProcessingException("ENGINE_INVALID_DEPENDENCY");
            items.Add(new JsonObject{["identifier"]=id,["content"]=text,["sha256"]=Data.Hash(text)});
        }
        var url=Environment.GetEnvironmentVariable("OPENEHR_ENGINE_URL");if(string.IsNullOrEmpty(url))throw new ProcessingException("ENGINE_NOT_CONFIGURED");
        using var request=new HttpRequestMessage(HttpMethod.Post,url.TrimEnd('/')+"/v1/"+operation){Content=JsonContent.Create(new{content,dependencies=items})};
        request.Headers.Add("X-Engine-Key",Network.Key(Environment.GetEnvironmentVariable("OPENEHR_ENGINE_KEY_FILE")??""));
        using var response=await Network.Compute(http,request,cancellation);if(!response.IsSuccessStatusCode)throw new ProcessingException("ENGINE_UNAVAILABLE");
        var result=Network.NativeData(await Network.Object(response,cancellation));
        if(result["operation"]?.GetValue<string>()!=operation||result["content_sha256"]?.GetValue<string>()!=Data.Hash(content)||result["clinical_approval"]?.GetValue<bool>()!=false||result["valid"] is not JsonValue||result["findings"] is not JsonArray)throw new ProcessingException("ENGINE_RESPONSE_INVALID");
        foreach(var field in new[]{"output","web_template"})if(result[field] is JsonObject output&&output["sha256"]?.GetValue<string>()!=Data.Hash(Data.Required(output,"content")))throw new ProcessingException("ENGINE_OUTPUT_HASH_MISMATCH");
        if(result["dependencies"] is JsonArray manifest&&result["valid"]?.GetValue<bool>()==true&&Data.Canonical(new JsonArray(manifest.OfType<JsonObject>().OrderBy(d=>d["identifier"]!.GetValue<string>(),StringComparer.Ordinal).Select(d=>(JsonNode)new JsonObject{["identifier"]=d["identifier"]!.DeepClone(),["sha256"]=d["sha256"]!.DeepClone()}).ToArray()))!=Data.Canonical(new JsonArray(items.OfType<JsonObject>().Select(d=>(JsonNode)new JsonObject{["identifier"]=d["identifier"]!.DeepClone(),["sha256"]=d["sha256"]!.DeepClone()}).ToArray())))throw new ProcessingException("ENGINE_DEPENDENCY_MANIFEST_INVALID");
        return result;
    }
    public async Task<JsonObject> Fhir(string operation,JsonObject parameters,string tenant,CancellationToken cancellation){
        var url=Environment.GetEnvironmentVariable("FHIR_ENGINE_URL");if(string.IsNullOrEmpty(url))throw new ProcessingException("FHIR_ENGINE_NOT_CONFIGURED");
        using var request=new HttpRequestMessage(HttpMethod.Post,url.TrimEnd('/')+"/execute"){Content=JsonContent.Create(new{operation,parameters,tenant})};request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",Network.Key(Environment.GetEnvironmentVariable("FHIR_ENGINE_KEY_FILE")??""));
        using var response=await Network.Compute(http,request,cancellation);var result=await Network.Object(response,cancellation);if(!response.IsSuccessStatusCode){var code=result["error"]?["code"]?.GetValue<string>();throw new ProcessingException(code is not null&&Regex.IsMatch(code,"^[A-Z][A-Z0-9_]{2,80}$")?code:"FHIR_ENGINE_UNAVAILABLE");}return result;
    }
}
