using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public sealed partial class RemoteDefinitions
{
    private static JsonObject CkmSources(){var sources=EnvironmentObject("CKM_SOURCES");var name=Environment.GetEnvironmentVariable("CKM_DEFAULT_SOURCE")??"default";if(!sources.ContainsKey(name))sources[name]=Environment.GetEnvironmentVariable("CKM_API_BASE_URL")??"https://ckm.openehr.org/ckm/rest/";return sources;}
    public async Task<JsonNode> Ckm(string tool,JsonObject args,CancellationToken cancellation){
        var sources=CkmSources();if(tool=="ckm_sources")return new JsonObject{["sources"]=sources,["default"]=Environment.GetEnvironmentVariable("CKM_DEFAULT_SOURCE")??"default"};
        if(tool=="ckm_federated_search")return await CkmFederation(sources,args,cancellation);
        var source=S(args,"ckm",Environment.GetEnvironmentVariable("CKM_DEFAULT_SOURCE")??"default");var root=sources[source]?.GetValue<string>()??throw new ProcessingException("CKM_SOURCE_NOT_FOUND");var headers=new Dictionary<string,string>();
        if(EnvironmentObject("CKM_AUTH")[source] is JsonObject auth){var secret=S(auth,"secret");if(auth["secret_file"] is not null){var file=S(auth,"secret_file");if(!Path.IsPathFullyQualified(file)||new FileInfo(file).Length>32768)throw new ProcessingException("CKM_CREDENTIAL_INVALID");secret=File.ReadAllText(file).Trim();}if(secret.Length is 0 or >32768||secret.Any(c=>c<' '||c=='\u007f'))throw new ProcessingException("CKM_CREDENTIAL_INVALID");switch(S(auth,"method")){case "bearer":headers["Authorization"]="Bearer "+secret;break;case "basic":headers["Authorization"]="Basic "+Convert.ToBase64String(Encoding.UTF8.GetBytes(S(auth,"username")+":"+secret));break;case "api_key":var header=S(auth,"header");if(!Regex.IsMatch(header,"^[A-Za-z][A-Za-z0-9-]{0,99}$")||new[]{"host","cookie","authorization","origin","forwarded","content-length"}.Contains(header.ToLowerInvariant()))throw new ProcessingException("CKM_AUTH_HEADER_INVALID");headers[header]=secret;break;case "session":headers["JSESSIONID"]=secret;break;default:throw new ProcessingException("CKM_AUTH_METHOD_INVALID");}}
        var archetype=tool.Contains("archetype",StringComparison.Ordinal);var kind=archetype?"archetypes":"templates";
        if(tool.EndsWith("_get",StringComparison.Ordinal)){
            var identifier=Data.Required(args,"identifier").Trim();if(!Regex.IsMatch(identifier,"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")||identifier.Contains("..",StringComparison.Ordinal))throw new ProcessingException("CKM_IDENTIFIER_INVALID");
            if(archetype&&identifier.StartsWith("openEHR-",StringComparison.Ordinal)){var resolved=await Send(root,"v1/archetypes/citeable-identifier/"+Uri.EscapeDataString(identifier),HttpMethod.Get,null,headers,cancellation,accept:"text/plain");identifier=resolved.Body.Trim().Trim('"','\'');}
            if(archetype&&!Regex.IsMatch(identifier,"^[0-9]+(?:\\.[0-9]+)*$"))throw new ProcessingException("CKM_CID_REQUIRED");var format=S(args,"format",archetype?"adl":"oet");
            if(!(archetype?new[]{"adl","xml","mindmap"}:new[]{"oet","opt"}).Contains(format))throw new ProcessingException("CKM_FORMAT_INVALID");
            var response=await Send(root,"v1/"+kind+"/"+Uri.EscapeDataString(identifier)+"/"+format,HttpMethod.Get,null,headers,cancellation,accept:format=="adl"?"text/plain":"application/xml");return new JsonObject{["type"]="text",["text"]=response.Body.Trim()};
        }
        var query=Data.Required(args,"keyword");var maximum=Math.Clamp(KnowledgeCorpus.Number(args,"maxResults",20),1,50);var fetch=Math.Clamp(maximum*3,30,60);var all=args["requireAllSearchWords"]?.GetValue<bool>()??true;
        var reply=await Send(root,"v1/"+kind+"?search-text="+Uri.EscapeDataString(query)+"&size="+fetch+"&offset=0"+(!archetype?"&template-type=NORMAL":"")+"&restrict-search-to-main-data=true&require-all-search-words="+(all?"true":"false")+"&sort-key=RELEVANCE",HttpMethod.Get,null,headers,cancellation);
        JsonNode? data;try{data=Data.ParseStrict(Encoding.UTF8.GetBytes(reply.Body));}catch(System.Text.Json.JsonException){throw new ProcessingException("CKM_RESPONSE_INVALID");}
        if(data is not JsonArray rows||rows.Any(row=>row is not JsonObject))throw new ProcessingException("CKM_RESPONSE_INVALID");var output=new List<JsonObject>();var rm=S(args,"rmClass").Trim().ToUpperInvariant();if(rm!=""&&!Regex.IsMatch(rm,"^[A-Z][A-Z0-9_]*$"))throw new ProcessingException("CKM_RM_CLASS_INVALID");
        foreach(var row in rows.OfType<JsonObject>()){
            if(rm!=""&&!Regex.IsMatch(Scalar(row,"resourceMainId")??"","^openEHR-[^-]+-"+Regex.Escape(rm)+"\\.",RegexOptions.IgnoreCase))continue;
            var item=new JsonObject{["cid"]=Scalar(row,"cid")??"",["score"]=CkmScore(row,query,archetype)};
            foreach(var (name,field)in new[]{("name","resourceMainDisplayName"),("projectName","projectName"),("status","status"),("creationTime","creationTime"),("modificationTime",row["modificationTime"] is null?"creationTime":"modificationTime"),(archetype?"revision":"version",archetype?"revision":"versionAsset")})if(Scalar(row,field) is string value)item[name]=value;
            if(archetype&&Scalar(row,"resourceMainId") is string identity)item["archetypeId"]=identity;output.Add(item);
        }
        return new JsonObject{["items"]=new JsonArray(output.OrderByDescending(x=>x["score"]!.GetValue<int>()).Take(maximum).Select(x=>(JsonNode)x).ToArray()),["total"]=rm!=""?output.Count:Math.Max(reply.Total??output.Count,output.Count)};
    }
    private async Task<JsonObject> CkmFederation(JsonObject sources,JsonObject args,CancellationToken cancellation){
        var kind=Data.Required(args,"kind");var keyword=Data.Required(args,"keyword");var maximum=KnowledgeCorpus.Number(args,"maxResults",20);var selection=args["sources"] as JsonArray??[];
        if(!new[]{"archetype","template"}.Contains(kind)||keyword.Length>1000||keyword.EnumerateRunes().Count()>500||keyword.Any(char.IsControl)||string.IsNullOrWhiteSpace(keyword)||maximum is <1 or >50||selection.Count>8)throw new ProcessingException("INVALID_CKM_FEDERATED_QUERY");
        var ids=selection.Count==0?sources.Select(p=>p.Key).ToArray():selection.Select(p=>p is JsonValue value&&value.TryGetValue<string>(out var id)?id:throw new ProcessingException("CKM_SOURCE_UNKNOWN")).ToArray();
        if(ids.Length is <1 or >8||ids.Distinct(StringComparer.Ordinal).Count()!=ids.Length||ids.Any(id=>!sources.ContainsKey(id)))throw new ProcessingException("CKM_SOURCE_UNKNOWN");
        var budget=int.TryParse(Environment.GetEnvironmentVariable("CKM_FEDERATION_TIMEOUT"),out var seconds)?Math.Clamp(seconds,1,60):30;using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellation);deadline.CancelAfter(TimeSpan.FromSeconds(budget));
        var items=new List<JsonObject>();var reports=new JsonArray();var truncated=false;var passed=0;
        foreach(var id in ids){
            var report=new JsonObject{["source"]=id,["status"]="NOT_EXECUTED",["reported_total"]=null,["returned"]=0,["error"]="FEDERATION_TIME_BUDGET"};reports.Add(report);cancellation.ThrowIfCancellationRequested();if(deadline.IsCancellationRequested)continue;
            try{var a=new JsonObject{["keyword"]=keyword,["maxResults"]=maximum,["ckm"]=id};var found=await Ckm("ckm_"+kind+"_search",a,deadline.Token);var rows=(JsonArray)found["items"]!;var total=found["total"]!.GetValue<int>();report["status"]="PASS";report["reported_total"]=total;report["returned"]=rows.Count;report["error"]=null;passed++;truncated|=total>rows.Count;
                foreach(var item in rows.OfType<JsonObject>()){var copy=(JsonObject)item.DeepClone();copy["source"]=id;copy["source_url"]=sources[id]!.DeepClone();copy["kind"]=kind;items.Add(copy);}
            }catch(Exception error)when(error is ProcessingException or HttpRequestException or TaskCanceledException or System.Text.Json.JsonException){cancellation.ThrowIfCancellationRequested();report["status"]="FAILED";report["error"]="CKM_SOURCE_UNAVAILABLE";}
        }
        return new JsonObject{["items"]=new JsonArray(items.OrderByDescending(x=>x["score"]!.GetValue<int>()).ThenBy(x=>S(x,"source"),StringComparer.Ordinal).ThenBy(x=>S(x,"cid"),StringComparer.Ordinal).ThenBy(x=>S(x,"revision",S(x,"version")),StringComparer.Ordinal).ThenBy(x=>S(x,"archetypeId"),StringComparer.Ordinal).ThenBy(x=>S(x,"name"),StringComparer.Ordinal).Take(maximum).Select(x=>(JsonNode)x).ToArray()),["total"]=items.Count,["total_scope"]="Retrieved per-source candidates before the final limit; not a global CKM match count.",["status"]=passed==ids.Length?"COMPLETE":passed==0?"UNAVAILABLE":"PARTIAL",["all_sources_responded"]=passed==ids.Length,["truncated"]=truncated||items.Count>maximum,["source_results"]=reports,["ranking"]="Lexical/status score, then source name, CID, revision and model/name identity.",["scope"]="Configured-source discovery windows; duplicate identifiers retain separate provenance. Retrieval never substitutes another source."};
    }
    private static string? Scalar(JsonObject row,string key)=>row[key] is JsonValue value?value.TryGetValue<string>(out var text)?text:value.ToJsonString():null;
    public static int CkmScore(JsonObject row,string query,bool archetype){
        var name=Scalar(row,"resourceMainDisplayName")??"";var identity=Scalar(row,"resourceMainId")??"";var project=Scalar(row,"projectName")??"";var status=(Scalar(row,"status")??"").ToUpperInvariant();var tokens=query.Trim().Split(' ',StringSplitOptions.RemoveEmptyEntries);var score=0;var matched=0;
        static int Field(string token,string text,int weight)=>Regex.IsMatch(text,"\\b"+Regex.Escape(token)+"\\b",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant)?weight:text.Contains(token,StringComparison.OrdinalIgnoreCase)?weight/2:0;
        foreach(var token in tokens){var value=Field(token,name,50)+Field(token,project,25)+(archetype?Field(token,identity,100):0);score+=value;if(value>0)matched++;}if(tokens.Length>0&&matched==tokens.Length)score+=80;
        static string Normalize(string text){var value=Regex.Replace(text.Trim().ToLowerInvariant(),"\\s+"," ");return value=="soep"?"soap":value;}
        var concept=identity.Split('.').ElementAtOrDefault(1)?.Replace('_',' ')??"";if(Normalize(query)!=""&&(Normalize(query)==Normalize(name)||archetype&&Normalize(query)==Normalize(concept)))score+=120;
        if(new[]{"common resources","structural archetypes"}.Contains(project.ToLowerInvariant()))score+=10;score+=status switch{"PUBLISHED"=>75,"TEAMREVIEW"=>25,"DRAFT" or "REVIEWSUSPENDED"=>-25,"INITIAL"=>-75,_=>0};
        if(status is "DRAFT" or "REVIEWSUSPENDED" or "INITIAL"){
            static int Years(string? text){if(text is null)return 0;DateTimeOffset date;if(long.TryParse(text,out var epoch)){try{date=DateTimeOffset.FromUnixTimeSeconds(epoch>2000000000?epoch/1000:epoch);}catch(ArgumentOutOfRangeException){return 0;}}else if(!DateTimeOffset.TryParse(text,CultureInfo.InvariantCulture,DateTimeStyles.AssumeUniversal,out date))return 0;var now=DateTimeOffset.UtcNow;if(date>now)return 0;var years=now.Year-date.Year;if(date.AddYears(years)>now)years--;return Math.Max(0,years);}
            score-=5*Years(Scalar(row,"modificationTime")??Scalar(row,"creationTime"))+Years(Scalar(row,"creationTime"));
        }return score;
    }
}
