using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Database;

public sealed record SourceAuthentication(string Mode,string? Token=null,string? User=null,string? Password=null,string? ClientId=null,string? ClientSecret=null,string? TokenEndpoint=null,string[]? Scopes=null,string? PrivateKeyPem=null,string? KeyId=null,string Algorithm="RS384")
{public override string ToString()=>"SourceAuthentication [credentials redacted]";}
public sealed record ApiSourceProfile(string Connector,string BaseUrl,string[] ReadPaths,SourceAuthentication Authentication,string Tenant,string[] Projects,string? FhirVersion=null,JsonObject? Analytics=null,string RecordsPointer="/items",string? NextPointer="/next")
{
    public override string ToString()=>"ApiSourceProfile [credentials redacted]";
    public static ApiSourceProfile Load(string directory,string id,string tenant,string project){
        var node=Data.ParseStrict(File.ReadAllBytes(VendorProfile.ProfileFile(directory,id))) as JsonObject??throw new ProcessingException("SOURCE_PROFILE_INVALID");
        Data.Keys(node,"connector","baseUrl","readPaths","authentication","tenant","projects","fhirVersion","analytics","recordsPointer","nextPointer");
        var profile=node.Deserialize<ApiSourceProfile>(Data.Json)??throw new ProcessingException("SOURCE_PROFILE_INVALID");_=profile.Root();
        if(profile.Tenant!=tenant||!profile.Projects.Contains(project,StringComparer.Ordinal))throw new ProcessingException("SOURCE_PROFILE_ACCESS_DENIED");return profile;
    }
    public Uri Root(bool test=false){
        if(Connector is not("epic-fhir" or "fhir-api" or "sap-bw" or "clinical-rest-api")||ReadPaths is null||ReadPaths.Length is <1 or >64||Projects is null||Projects.Length is <1 or >100||Authentication is null)throw new ProcessingException("SOURCE_API_PROFILE_INVALID");
        var root=UriFor(BaseUrl,test);if(root.Query.Length>0||root.Fragment.Length>0)throw new ProcessingException("SOURCE_API_BASE_INVALID");
        if(Connector is "epic-fhir" or "fhir-api" && FhirVersion is not("4.0.1" or "4.3.0" or "5.0.0"))throw new ProcessingException("SOURCE_FHIR_RELEASE_REQUIRED");
        if(Connector=="sap-bw"&&(Analytics is null||new[]{"grain","dimensions","measures","units","filters"}.Any(key=>!Analytics.ContainsKey(key))))throw new ProcessingException("SOURCE_BW_SEMANTICS_REQUIRED");
        var auth=Authentication;
        if(auth.Mode is not("bearer" or "basic" or "oauth-client-secret" or "smart-private-key-jwt"))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
        if(auth.Mode=="bearer"&&(string.IsNullOrWhiteSpace(auth.Token)||auth.Token.Length>16384||auth.Token.Any(char.IsControl)))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
        if(auth.Mode=="basic"&&(string.IsNullOrWhiteSpace(auth.User)||auth.User.Contains(':')||string.IsNullOrEmpty(auth.Password)))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
        if(auth.Mode is "oauth-client-secret" or "smart-private-key-jwt"){
            if(string.IsNullOrWhiteSpace(auth.ClientId)||auth.TokenEndpoint is null||auth.Scopes is null||auth.Scopes.Length is <1 or >64||auth.Scopes.Any(scope=>string.IsNullOrWhiteSpace(scope)||scope.Any(char.IsWhiteSpace)))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
            _=UriFor(auth.TokenEndpoint,test);
            if(Connector is "epic-fhir" or "fhir-api" && auth.Scopes.Any(scope=>!Regex.IsMatch(scope,"^system/[A-Za-z*][A-Za-z0-9*]*(?:\\.read|\\.r|\\.s|\\.rs)$")))throw new ProcessingException("SOURCE_WRITE_SCOPE_DENIED");
            if(auth.Mode=="oauth-client-secret"&&string.IsNullOrWhiteSpace(auth.ClientSecret))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
            if(auth.Mode=="smart-private-key-jwt")_=ApiSource.Assertion(auth,auth.TokenEndpoint);
        }
        foreach(var path in ReadPaths)ValidatePath(path);
        return new Uri(root.AbsoluteUri.TrimEnd('/')+'/');
    }
    public static Uri UriFor(string value,bool test=false){
        if(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.UserInfo.Length>0||uri.Fragment.Length>0||uri.Host.Equals("169.254.169.254",StringComparison.Ordinal)||uri.Host.Equals("metadata.google.internal",StringComparison.OrdinalIgnoreCase)||uri.Scheme!="https"&&!(test&&Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT")=="Development"&&uri.Scheme=="http"&&IPAddress.TryParse(uri.Host,out var ip)&&IPAddress.IsLoopback(ip)))throw new ProcessingException("SOURCE_API_HTTPS_REQUIRED");return uri;
    }
    public static void ValidatePath(string path){
        var decoded=Uri.UnescapeDataString(path??"");
        if(string.IsNullOrWhiteSpace(path)||path.Length>4096||path.StartsWith('/')||decoded.Split('?',2)[0].Split('/').Any(part=>part is "." or ".."||part.Contains('\\')||part.Contains(':'))||path.Any(char.IsControl)||path.Contains('#'))throw new ProcessingException("SOURCE_READ_PATH_INVALID");
        if(decoded.Contains("$export",StringComparison.OrdinalIgnoreCase)||decoded.Contains("$import",StringComparison.OrdinalIgnoreCase))throw new ProcessingException("SOURCE_STATEFUL_OPERATION_DENIED");
    }
}
public sealed record PrivateApiRead(JsonArray Records,JsonArray Provenance,Dictionary<string,byte[]> OriginalPages);
public sealed class ApiSource:IDisposable
{
    private readonly ApiSourceProfile profile;private readonly Uri root;private readonly HttpClient client;private readonly bool test;
    private string? token;private DateTimeOffset expires;
    public ApiSource(ApiSourceProfile profile,bool test=false){this.profile=profile;root=profile.Root(test);this.test=test;client=Network.Client(TimeSpan.FromSeconds(45));}
    public void Dispose()=>client.Dispose();
    private async Task<string> Bearer(CancellationToken ct){
        var auth=profile.Authentication;if(auth.Mode=="bearer"){
            if(string.IsNullOrWhiteSpace(auth.Token)||auth.Token.Any(char.IsControl)||auth.Token.Length>16384)throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");return auth.Token;
        }
        if(token is not null&&expires>DateTimeOffset.UtcNow.AddSeconds(30))return token;
        if(auth.Mode is not("oauth-client-secret" or "smart-private-key-jwt")||string.IsNullOrWhiteSpace(auth.ClientId)||auth.TokenEndpoint is null||auth.Scopes is null||auth.Scopes.Length is <1 or >64)throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
        if(profile.Connector is "epic-fhir" or "fhir-api" && auth.Scopes.Any(scope=>!Regex.IsMatch(scope,"^system/[A-Za-z*][A-Za-z0-9*]*(?:\\.read|\\.r|\\.s|\\.rs)$")))throw new ProcessingException("SOURCE_WRITE_SCOPE_DENIED");
        var endpoint=ApiSourceProfile.UriFor(auth.TokenEndpoint,test);var fields=new Dictionary<string,string>{{"grant_type","client_credentials"},{"client_id",auth.ClientId},{"scope",string.Join(' ',auth.Scopes)}};
        using var request=new HttpRequestMessage(HttpMethod.Post,endpoint);
        if(auth.Mode=="oauth-client-secret"){
            if(string.IsNullOrEmpty(auth.ClientSecret))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");fields["client_secret"]=auth.ClientSecret;
        }else{
            fields["client_assertion_type"]="urn:ietf:params:oauth:client-assertion-type:jwt-bearer";fields["client_assertion"]=Assertion(auth,endpoint.AbsoluteUri);
        }
        request.Content=new FormUrlEncodedContent(fields);using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
        if(response.StatusCode!=HttpStatusCode.OK)throw new ProcessingException("SOURCE_TOKEN_UNAVAILABLE");
        var result=await Network.Object(response,ct,65536);
        if(result["token_type"]?.GetValue<string>().Equals("Bearer",StringComparison.OrdinalIgnoreCase)!=true||result["access_token"]?.GetValue<string>() is not string access||access.Length is <1 or >16384||access.Any(char.IsControl))throw new ProcessingException("SOURCE_TOKEN_INVALID");
        if(result["scope"] is JsonValue granted&&profile.Connector is "epic-fhir" or "fhir-api"&&granted.GetValue<string>().Split(' ',StringSplitOptions.RemoveEmptyEntries).Any(scope=>!Regex.IsMatch(scope,"^system/[A-Za-z*][A-Za-z0-9*]*(?:\\.read|\\.r|\\.s|\\.rs)$")))throw new ProcessingException("SOURCE_WRITE_SCOPE_DENIED");
        var lifetime=result["expires_in"]?.GetValue<int>()??300;if(lifetime is <30 or >86400)throw new ProcessingException("SOURCE_TOKEN_INVALID");token=access;expires=DateTimeOffset.UtcNow.AddSeconds(lifetime);return token;
    }
    public static string Assertion(SourceAuthentication auth,string audience){
        if(auth.Algorithm is not("RS384" or "RS256")||auth.PrivateKeyPem is null||auth.PrivateKeyPem.Length>16384||string.IsNullOrWhiteSpace(auth.KeyId))throw new ProcessingException("SOURCE_SMART_KEY_REQUIRED");
        using var key=RSA.Create();key.ImportFromPem(auth.PrivateKeyPem);if(key.KeySize<2048)throw new ProcessingException("SOURCE_SMART_KEY_INVALID");
        string Encode(byte[] bytes)=>Convert.ToBase64String(bytes).TrimEnd('=').Replace('+','-').Replace('/','_');
        var now=DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header=Encode(JsonSerializer.SerializeToUtf8Bytes(new{alg=auth.Algorithm,typ="JWT",kid=auth.KeyId}));
        var payload=Encode(JsonSerializer.SerializeToUtf8Bytes(new{iss=auth.ClientId,sub=auth.ClientId,aud=audience,iat=now,exp=now+240,jti=Guid.NewGuid().ToString("N")}));var input=header+'.'+payload;
        return input+'.'+Encode(key.SignData(Encoding.ASCII.GetBytes(input),auth.Algorithm=="RS384"?HashAlgorithmName.SHA384:HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1));
    }
    private static JsonNode? Pointer(JsonNode? node,string path){
        if(path=="")return node;if(!path.StartsWith('/')||path.Length>1024)throw new ProcessingException("SOURCE_RESPONSE_POINTER_INVALID");
        foreach(var raw in path[1..].Split('/')){
            for(var i=0;i<raw.Length;i++)if(raw[i]=='~'&&(i+1>=raw.Length||raw[++i] is not('0' or '1')))throw new ProcessingException("SOURCE_RESPONSE_POINTER_INVALID");
            var part=raw.Replace("~1","/",StringComparison.Ordinal).Replace("~0","~",StringComparison.Ordinal);
            node=node is JsonObject obj?obj[part]:node is JsonArray array&&int.TryParse(part,out var index)&&index>=0&&index<array.Count?array[index]:null;
        }return node;
    }
    private Uri Next(string value,Uri current){
        if(value.Length>8192||value.Any(char.IsControl))throw new ProcessingException("SOURCE_PAGE_LINK_INVALID");
        var next=new Uri(current,value);
        if(next.Scheme!=root.Scheme||next.Authority!=root.Authority||!next.AbsolutePath.StartsWith(root.AbsolutePath,StringComparison.Ordinal)||next.UserInfo.Length>0||next.Fragment.Length>0)throw new ProcessingException("SOURCE_PAGE_ORIGIN_DENIED");
        var relative=Uri.UnescapeDataString(root.MakeRelativeUri(next).ToString());ApiSourceProfile.ValidatePath(relative);
        var approvedPaths=profile.ReadPaths.Select(path=>new Uri(root,path).AbsolutePath).ToArray();
        if(!approvedPaths.Contains(next.AbsolutePath,StringComparer.Ordinal) && !(profile.Connector is "epic-fhir" or "fhir-api" && next.AbsolutePath==root.AbsolutePath && next.Query.Contains("_getpages=",StringComparison.Ordinal)))throw new ProcessingException("SOURCE_PAGE_PATH_DENIED");
        return next;
    }
    private async Task<(byte[] Bytes,string MediaType)> Get(Uri uri,CancellationToken ct){
        for(var attempt=0;;attempt++){
            using var request=new HttpRequestMessage(HttpMethod.Get,uri);request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(uri.AbsolutePath.EndsWith("/$metadata",StringComparison.Ordinal)?"application/xml":profile.Connector is "epic-fhir" or "fhir-api"?"application/fhir+json":"application/json"));
            if(profile.Authentication.Mode=="basic"){
                if(profile.Authentication.User is null||profile.Authentication.Password is null||profile.Authentication.User.Contains(':'))throw new ProcessingException("SOURCE_AUTHENTICATION_INVALID");
                request.Headers.Authorization=new AuthenticationHeaderValue("Basic",Convert.ToBase64String(Encoding.UTF8.GetBytes(profile.Authentication.User+':'+profile.Authentication.Password)));
            }else request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",await Bearer(ct));
            using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,ct);
            if((int)response.StatusCode is 429 or 503 && attempt<2){var seconds=Math.Clamp(response.Headers.RetryAfter?.Delta?.TotalSeconds??1,1,10);await Task.Delay(TimeSpan.FromSeconds(seconds),ct);continue;}
            if(response.StatusCode!=HttpStatusCode.OK)throw new ProcessingException((int)response.StatusCode is 401 or 403?"SOURCE_AUTHENTICATION_REJECTED":"SOURCE_READ_UNAVAILABLE");
            if(response.Content.Headers.ContentLength>16*1048576)throw new ProcessingException("SOURCE_PAGE_LIMIT");
            await using var stream=await response.Content.ReadAsStreamAsync(ct);using var data=new MemoryStream();var buffer=new byte[16384];int n;
            while((n=await stream.ReadAsync(buffer,ct))>0){if(data.Length+n>16*1048576)throw new ProcessingException("SOURCE_PAGE_LIMIT");data.Write(buffer,0,n);}return(data.ToArray(),response.Content.Headers.ContentType?.MediaType??"");
        }
    }
    public async Task<JsonObject> Discover(CancellationToken ct){
        if(profile.Connector is "epic-fhir" or "fhir-api"){
            var page=await Get(new Uri(root,"metadata"),ct);var capability=Data.ParseStrict(page.Bytes) as JsonObject??throw new ProcessingException("SOURCE_FHIR_CAPABILITY_REQUIRED");
            if(capability["resourceType"]?.GetValue<string>()!="CapabilityStatement"||capability["fhirVersion"]?.GetValue<string>()!=profile.FhirVersion)throw new ProcessingException("SOURCE_FHIR_RELEASE_MISMATCH");
            return new(){["connector"]=profile.Connector,["fhirVersion"]=profile.FhirVersion,["capabilitySha256"]=Convert.ToHexStringLower(SHA256.HashData(page.Bytes)),["rest"]=capability["rest"]?.DeepClone(),["metadataOnly"]=true,["readOnly"]=true};
        }
        if(profile.Connector=="sap-bw"){
            var page=await Get(new Uri(root,"$metadata"),ct);var document=System.Xml.Linq.XDocument.Load(System.Xml.XmlReader.Create(new MemoryStream(page.Bytes),new(){DtdProcessing=System.Xml.DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=16*1048576}));
            var edm=document.Descendants().Where(element=>element.Name.LocalName is "EntityType" or "EntitySet").Take(501).ToArray();if(edm.Length>500)throw new ProcessingException("SOURCE_METADATA_LIMIT");
            return new(){["connector"]=profile.Connector,["metadataSha256"]=Convert.ToHexStringLower(SHA256.HashData(page.Bytes)),["entities"]=new JsonArray(edm.Select(element=>(JsonNode)new JsonObject{["kind"]=element.Name.LocalName,["name"]=(string?)element.Attribute("Name"),["definition"]=element.ToString(System.Xml.Linq.SaveOptions.DisableFormatting)}).ToArray()),["analytics"]=profile.Analytics?.DeepClone(),["metadataOnly"]=true,["readOnly"]=true};
        }
        return new(){["connector"]=profile.Connector,["readPaths"]=JsonSerializer.SerializeToNode(profile.ReadPaths.Select(path=>path.Split('?',2)[0]).Distinct()),["metadataOnly"]=true,["readOnly"]=true,["semantics"]="USER_SUPPLIED_READ_CONTRACT"};
    }
    public async Task<PrivateApiRead> Read(string path,CancellationToken ct){
        ApiSourceProfile.ValidatePath(path);if(!profile.ReadPaths.Contains(path,StringComparer.Ordinal))throw new ProcessingException("SOURCE_READ_PATH_NOT_APPROVED");
        if(profile.Connector is "epic-fhir" or "fhir-api")await Discover(ct);
        var uri=new Uri(root,path);var visited=new HashSet<string>(StringComparer.Ordinal);var records=new JsonArray();var provenance=new JsonArray();var originals=new Dictionary<string,byte[]>();long bytes=0;int? expectedTotal=null;var matchCount=0;var seenResources=new HashSet<string>(StringComparer.Ordinal);
        for(var pageNumber=0;;pageNumber++){
            if(pageNumber>=1000||!visited.Add(uri.AbsoluteUri))throw new ProcessingException("SOURCE_PAGINATION_INCOMPLETE");
            var page=await Get(uri,ct);bytes+=page.Bytes.Length;if(bytes>256*1048576)throw new ProcessingException("SOURCE_SNAPSHOT_LIMIT");
            var hash=Convert.ToHexStringLower(SHA256.HashData(page.Bytes));originals.TryAdd(hash,page.Bytes);var rawDocument=Data.ParseStrict(page.Bytes);var document=rawDocument as JsonObject??new JsonObject();string? next=null;JsonArray items;
            if(profile.Connector is "epic-fhir" or "fhir-api"){
                if(document["resourceType"]?.GetValue<string>()!="Bundle"||document["type"]?.GetValue<string>()!="searchset")throw new ProcessingException("SOURCE_FHIR_SEARCHSET_REQUIRED");
                if(document["total"] is JsonValue total){var value=total.GetValue<int>();if(value<0||expectedTotal is not null&&expectedTotal!=value)throw new ProcessingException("SOURCE_SNAPSHOT_DRIFT");expectedTotal=value;}
                var entries=document["entry"] as JsonArray??new();items=new();
                foreach(var entry in entries){if(entry?["resource"] is not JsonObject resource||resource["resourceType"]?.GetValue<string>() is null||resource["resourceType"]?.GetValue<string>()=="OperationOutcome")throw new ProcessingException("SOURCE_FHIR_ENTRY_INVALID");var resourceId=resource["id"]?.GetValue<string>()??throw new ProcessingException("SOURCE_FHIR_ID_REQUIRED");var identity=resource["resourceType"]!.GetValue<string>()+"/"+resourceId+"/"+(resource["meta"]?["versionId"]?.GetValue<string>()??"");if(!seenResources.Add(identity))throw new ProcessingException("SOURCE_FHIR_PAGE_DUPLICATE");if(entry?["search"]?["mode"]?.GetValue<string>()!="include")matchCount++;items.Add(resource.DeepClone());}
                var links=(document["link"] as JsonArray??new()).Where(link=>link?["relation"]?.GetValue<string>()=="next").ToArray();if(links.Length>1)throw new ProcessingException("SOURCE_PAGE_LINK_AMBIGUOUS");next=links.SingleOrDefault()?["url"]?.GetValue<string>();
            }else if(profile.Connector=="sap-bw"){
                // OData v2 and v4; originals retain annotations, keys, units and analytic metadata.
                items=(document["value"] as JsonArray??document["d"]?["results"] as JsonArray)??throw new ProcessingException("SOURCE_ODATA_RESULTS_REQUIRED");
                next=document["@odata.nextLink"]?.GetValue<string>()??document["d"]?["__next"]?.GetValue<string>();
            }else{
                items=Pointer(rawDocument,profile.RecordsPointer) as JsonArray??throw new ProcessingException("SOURCE_REST_ITEMS_REQUIRED");next=profile.NextPointer is null?null:Pointer(rawDocument,profile.NextPointer)?.GetValue<string>();
            }
            foreach(var item in items){if(item is not JsonObject)throw new ProcessingException("SOURCE_RECORD_OBJECT_REQUIRED");if(records.Count>=10000)throw new ProcessingException("SOURCE_SNAPSHOT_RECORD_LIMIT");records.Add(item.DeepClone());}
            provenance.Add(new JsonObject{["page"]=pageNumber,["sha256"]=hash,["count"]=items.Count,["retrievedAt"]=DateTimeOffset.UtcNow.ToString("O")});
            if(next is null)break;uri=Next(next,uri);
        }
        if(expectedTotal is not null&&matchCount!=expectedTotal)throw new ProcessingException("SOURCE_PAGINATION_INCOMPLETE");
        return new(records,provenance,originals);
    }
}
