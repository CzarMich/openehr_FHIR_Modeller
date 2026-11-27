using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public sealed partial class RemoteDefinitions:IDisposable
{
    private readonly HttpClient http=Network.Client(TimeSpan.FromSeconds(60));
    public void Dispose()=>http.Dispose();
    private static string S(JsonObject o,string k,string fallback="")=>KnowledgeCorpus.Text(o,k,fallback);
    public static JsonObject EnvironmentObject(string name){var raw=Environment.GetEnvironmentVariable(name);if(string.IsNullOrEmpty(raw))return new JsonObject();if(raw.Length>65536)throw new ProcessingException("CONNECTION_CONFIGURATION_INVALID");return JsonNode.Parse(raw) as JsonObject??throw new ProcessingException("CONNECTION_CONFIGURATION_INVALID");}
    public static JsonObject ConfigFile(string name){var path=Environment.GetEnvironmentVariable(name);if(string.IsNullOrEmpty(path))return new JsonObject();if(!Path.IsPathFullyQualified(path)||new FileInfo(path).Length>65536)throw new ProcessingException("CONNECTION_CONFIGURATION_INVALID");return Data.ParseStrict(File.ReadAllBytes(path)) as JsonObject??throw new ProcessingException("CONNECTION_CONFIGURATION_INVALID");}
    private static Uri Target(string root,string path,string allowedHosts="",bool allowHttp=false){
        if(!Uri.TryCreate(root.TrimEnd('/')+"/",UriKind.Absolute,out var uri)||uri.UserInfo!=""||uri.Query!=""||uri.Fragment!=""||uri.Scheme!="https"&&!(allowHttp&&uri.Scheme=="http")||allowedHosts!=""&&!allowedHosts.Split(',',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries).Contains(uri.Host,StringComparer.OrdinalIgnoreCase))throw new ProcessingException("CONNECTION_URL_DENIED");
        if(path.Contains("..",StringComparison.Ordinal)||path.Contains('#')||path.StartsWith("//",StringComparison.Ordinal)||path.Contains('\\')||path.Any(char.IsControl))throw new ProcessingException("CONNECTION_PATH_INVALID");var target=new Uri(uri,path.TrimStart('/'));if(target.Authority!=uri.Authority||!target.AbsolutePath.StartsWith(uri.AbsolutePath,StringComparison.Ordinal))throw new ProcessingException("CONNECTION_PATH_INVALID");return target;
    }
    public async Task<(string Body,int? Total)> Send(string root,string path,HttpMethod method,JsonNode? body,Dictionary<string,string>? headers,CancellationToken cancellation,string allowedHosts="",bool allowHttp=false,string accept="application/json"){
        using var request=new HttpRequestMessage(method,Target(root,path,allowedHosts,allowHttp));request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(accept));
        foreach(var (k,v) in headers??[]){if(k.Equals("Host",StringComparison.OrdinalIgnoreCase)||k.Equals("Cookie",StringComparison.OrdinalIgnoreCase)&&v.Any(c=>c<' '||c=='\u007f')||v.Any(c=>c is '\r' or '\n'))throw new ProcessingException("CONNECTION_HEADER_INVALID");request.Headers.TryAddWithoutValidation(k,v);}
        if(body is not null)request.Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);if(!response.IsSuccessStatusCode)throw new ProcessingException((int)response.StatusCode is 401 or 403?"CONNECTION_PERMISSION_DENIED":"CONNECTION_REQUEST_FAILED");
        if(response.Content.Headers.ContentLength>8388608)throw new ProcessingException("UPSTREAM_RESPONSE_LIMIT");await using var stream=await response.Content.ReadAsStreamAsync(cancellation);using var output=new MemoryStream();var buffer=new byte[16384];int n;while((n=await stream.ReadAsync(buffer,cancellation))>0){if(output.Length+n>8388608)throw new ProcessingException("UPSTREAM_RESPONSE_LIMIT");output.Write(buffer,0,n);}int? total=null;if(response.Headers.TryGetValues("X-Total-Count",out var counts)&&int.TryParse(counts.SingleOrDefault(),out var count)&&count>=0)total=count;return(new UTF8Encoding(false,true).GetString(output.ToArray()),total);
    }
    public JsonArray Connections(){var entries=ConfigFile("FHIR_CONNECTIONS_FILE");return new JsonArray(entries.Select(p=>{var e=p.Value as JsonObject??throw new ProcessingException("FHIR_CONNECTION_CONFIGURATION_INVALID");var summary=new JsonObject{["id"]=p.Key,["managedBy"]="deployment",["hasCredentials"]=e["credentialFile"] is not null||e["loginFile"] is not null};foreach(var key in new[]{"type","name","baseUrl","projectId","linkId","repository","branch","rootPath","environment"})if(e[key] is not null)summary[key]=e[key]!.DeepClone();return(JsonNode)summary;}).ToArray());}
    public async Task<JsonObject> Connection(string id,string action,JsonObject args,CancellationToken cancellation){
        var entries=ConfigFile("FHIR_CONNECTIONS_FILE");var entry=entries[id] as JsonObject??throw new ProcessingException("FHIR_CONNECTION_NOT_FOUND");var type=S(entry,"type");if(action=="get")return (JsonObject)Connections().OfType<JsonObject>().Single(e=>S(e,"id")==id).DeepClone();
        var path="/metadata";var method=HttpMethod.Get;JsonNode? body=null;
        if(action is "search" or "read"){
            var resource=S(args,"resourceType");if(!new[]{"StructureDefinition","ValueSet","CodeSystem","ConceptMap","ImplementationGuide","SearchParameter","OperationDefinition","CapabilityStatement","StructureMap","NamingSystem"}.Contains(resource))throw new ProcessingException("FHIR_DEFINITION_TYPE_REQUIRED");path="/"+resource;
            if(action=="read"){var resourceId=S(args,"resourceId");if(!Regex.IsMatch(resourceId,"^[A-Za-z0-9.-]{1,64}$"))throw new ProcessingException("FHIR_DEFINITION_ID_INVALID");path+="/"+resourceId;}
            else{path+="?_count=50";foreach(var key in new[]{"url","version","name"})if(args[key] is not null){var value=S(args,key);if(value.Length>1000||value.Any(char.IsControl))throw new ProcessingException("FHIR_DEFINITION_QUERY_INVALID");path+="&"+key+"="+Uri.EscapeDataString(value);}}
        }else if(action=="validate"){
            if(args["synthetic"]?.GetValue<bool>()!=true)throw new ProcessingException("SYNTHETIC_INPUT_REQUIRED");var metadata=await Connection(id,"metadata",new JsonObject(),cancellation);if(!metadata.ToJsonString().Contains("\"validate\"",StringComparison.Ordinal))throw new ProcessingException("FHIR_RUNTIME_VALIDATE_NOT_ADVERTISED");path="/$validate";method=HttpMethod.Post;body=args["content"]??throw new ProcessingException("FHIR_RESOURCE_REQUIRED");
        }else if(action is not ("test" or "metadata"))throw new ProcessingException("FHIR_CONNECTION_OPERATION_INVALID");
        if(type is not ("runtime" or "terminology"))throw new ProcessingException("FHIR_DEFINITION_CONNECTION_REQUIRED");
        var result=await RequestConnection(entry,path,method,body,cancellation);var o=JsonNode.Parse(result) as JsonObject??throw new ProcessingException("FHIR_REMOTE_RESPONSE_INVALID");
        if(action is "test" or "metadata"){if(S(o,"resourceType")!="CapabilityStatement")throw new ProcessingException("FHIR_CAPABILITY_STATEMENT_REQUIRED");return action=="metadata"?o:new JsonObject{["id"]=id,["type"]=type,["connected"]=true,["capabilities"]=o,["timestamp"]=DateTimeOffset.UtcNow.ToString("O")};}
        if(action=="read")return new JsonObject{["kind"]="resource",["resource"]=o,["content"]=result,["sha256"]=Data.Hash(result),["provenance"]=new JsonObject{["connectionId"]=id,["sha256"]=Data.Hash(result),["retrievedAt"]=DateTimeOffset.UtcNow.ToString("O"),["clinicalApproval"]=false}};
        return o;
    }
    public async Task<string> RequestConnection(JsonObject entry,string path,HttpMethod method,JsonNode? body,CancellationToken cancellation){
        var headers=new Dictionary<string,string>();if(entry["credentialFile"] is not null)headers["Authorization"]="Bearer "+Network.Key(S(entry,"credentialFile"));
        if(entry["loginFile"] is not null){var file=S(entry,"loginFile");if(!Path.IsPathFullyQualified(file)||new FileInfo(file).Length>8192)throw new ProcessingException("FHIR_CREDENTIAL_UNAVAILABLE");var login=JsonNode.Parse(File.ReadAllText(file)) as JsonObject??throw new ProcessingException("FHIR_CREDENTIAL_INVALID");var reply=await Send(S(entry,"baseUrl"),"/api/v1/auth/login",HttpMethod.Post,login,null,cancellation,Environment.GetEnvironmentVariable("FHIR_ALLOWED_HOSTS")??"",Environment.GetEnvironmentVariable("FHIR_ALLOW_HTTP")=="true");var token=JsonNode.Parse(reply.Body)?["access_token"]?.GetValue<string>()??JsonNode.Parse(reply.Body)?["token"]?.GetValue<string>()??throw new ProcessingException("FHIR_LOGIN_FAILED");headers["Authorization"]="Bearer "+token;}
        return(await Send(S(entry,"baseUrl"),path,method,body,headers,cancellation,Environment.GetEnvironmentVariable("FHIR_ALLOWED_HOSTS")??"",Environment.GetEnvironmentVariable("FHIR_ALLOW_HTTP")=="true")).Body;
    }
}
