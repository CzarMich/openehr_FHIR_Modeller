using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Modeller.Core;
namespace Modeller.Application;

public sealed class KnowledgeCorpus
{
    private readonly string root;
    public KnowledgeCorpus(string root){this.root=Path.GetFullPath(root);SnapshotRepository.Safe(this.root);}
    public static string Text(JsonObject o,string name,string fallback="")=>o[name]?.GetValue<string>()??fallback;
    public static int Number(JsonObject o,string name,int fallback)=>o[name]?.GetValue<int>()??fallback;
    public JsonObject Resource(string uri){
        string file,mime;
        if(uri=="openehr://terminology")return new JsonObject{["uri"]=uri,["mimeType"]="application/json",["text"]=File.ReadAllText(Path.Combine(root,"terminology","openehr_terminology.json"))};
        var match=Regex.Match(uri,"^openehr://(guides|examples|spec/type)/([A-Za-z0-9_-]+)/([A-Za-z0-9_.-]+)$");
        if(!match.Success||match.Groups[3].Value.Contains("..",StringComparison.Ordinal))throw new ProcessingException("RESOURCE_NOT_FOUND");
        var group=match.Groups[1].Value;var category=match.Groups[2].Value;var name=match.Groups[3].Value;
        if(group=="spec/type"){file=Path.Combine(root,"bmm",category,name+".bmm.json");mime="application/json";}
        else{file=Path.Combine(root,group,category,name+(category=="archetypes"&&group=="examples"?".adl":".md"));mime=file.EndsWith(".adl",StringComparison.Ordinal)?"text/plain":"text/markdown";}
        SnapshotRepository.Safe(file);if(!File.Exists(file)||new FileInfo(file).Length>4194304)throw new ProcessingException("RESOURCE_NOT_FOUND");
        return new JsonObject{["uri"]=uri,["mimeType"]=mime,["text"]=new System.Text.UTF8Encoding(false,true).GetString(File.ReadAllBytes(file))};
    }
    public JsonObject Search(string name,JsonObject args){
        var bmm=name=="type_specification_search";var examples=name=="examples_search";
        var query=Text(args,bmm?"namePattern":"query");var category=Text(args,examples?"kind":"category");
        var tokens=Regex.Matches(query.ToLowerInvariant(),"[\\p{L}\\p{N}_]+").Select(m=>m.Value).Distinct().ToArray();
        var files=Directory.EnumerateFiles(Path.Combine(root,bmm?"bmm":examples?"examples":"guides"),"*",SearchOption.AllDirectories).Where(f=>(bmm?f.EndsWith(".bmm.json",StringComparison.Ordinal):f.EndsWith(".md",StringComparison.Ordinal)||f.EndsWith(".adl",StringComparison.Ordinal))&&!Path.GetFileName(f).StartsWith('_')&&Path.GetFileName(f)!="README.md");
        var results=new List<(int Score,JsonObject Item)>();
        foreach(var file in files){SnapshotRepository.Safe(file);var cat=Path.GetFileName(Path.GetDirectoryName(file))!;if(category!=""&&category!=cat)continue;var id=Path.GetFileName(file).Replace(bmm?".bmm.json":Path.GetExtension(file),"",StringComparison.Ordinal);var content=File.ReadAllText(file);
            if(bmm){if(query.Length<3)throw new ProcessingException("INVALID_INPUT");if(!Regex.IsMatch(id,"^"+Regex.Escape(query).Replace("\\*",".*",StringComparison.Ordinal)+"$",RegexOptions.IgnoreCase|RegexOptions.CultureInvariant,TimeSpan.FromMilliseconds(100))||!content.Contains(Text(args,"keyword"),StringComparison.OrdinalIgnoreCase))continue;var definition=JsonNode.Parse(content) as JsonObject??throw new ProcessingException("TYPE_INVALID");results.Add((1,new JsonObject{["name"]=id,["documentation"]=Text(definition,"documentation"),["package"]=Text(definition,"package"),["specUrl"]=Text(definition,"specUrl"),["component"]=cat,["resourceUri"]="openehr://spec/type/"+cat+"/"+id}));continue;}
            var title=Regex.Match(content,"^# +(.+)$",RegexOptions.Multiline).Groups[1].Value;if(title=="")title=id;
            var lower=content.ToLowerInvariant();var score=tokens.Sum(t=>(title.Contains(t,StringComparison.OrdinalIgnoreCase)?4:0)+(cat.Contains(t,StringComparison.OrdinalIgnoreCase)?3:0)+Math.Min(lower.Split(t,StringSplitOptions.None).Length-1,6));
            if(tokens.Length>0&&score==0)continue;
            var chars=Number(args,"snippetChars",220);var pos=query==""?-1:content.IndexOf(query,StringComparison.OrdinalIgnoreCase);var start=Math.Max(0,pos-chars/2);var snippet=new string(content.Skip(start).Take(chars).ToArray()).Trim();
            var item=new JsonObject{["title"]=title,[examples?"kind":"category"]=cat,["name"]=id,["resourceUri"]="openehr://"+(examples?"examples":"guides")+"/"+cat+"/"+id,["snippet"]=snippet,["score"]=score};
            results.Add((score+(Text(args,"taskType")!=""&&title.Contains(Text(args,"taskType"),StringComparison.OrdinalIgnoreCase)?2:0),item));
        }
        return new JsonObject{["items"]=new JsonArray(results.OrderByDescending(x=>x.Score).ThenBy(x=>Text(x.Item,"resourceUri"),StringComparer.Ordinal).Take(bmm?int.MaxValue:Number(args,"maxResults",10)).Select(x=>(JsonNode)x.Item).ToArray()),["total"]=results.Count};
    }
    public JsonObject Type(JsonObject args){var type=Text(args,"name");if(!Regex.IsMatch(type,"^[A-Za-z0-9_]{1,120}$"))throw new ProcessingException("INVALID_INPUT");var component=Text(args,"component");var files=Directory.EnumerateFiles(Path.Combine(root,"bmm"),type+".bmm.json",SearchOption.AllDirectories).Where(f=>component==""||Path.GetFileName(Path.GetDirectoryName(f))==component).Order(StringComparer.Ordinal).ToArray();if(files.Length==0)throw new ProcessingException("TYPE_NOT_FOUND");SnapshotRepository.Safe(files[0]);var result=JsonNode.Parse(File.ReadAllText(files[0])) as JsonObject??throw new ProcessingException("TYPE_INVALID");result["resourceUri"]="openehr://spec/type/"+Path.GetFileName(Path.GetDirectoryName(files[0]))+"/"+type;return result;}
    public JsonObject Idioms(string pattern){
        var resource=Resource("openehr://guides/archetypes/adl-idioms-cheatsheet");var text=Text(resource,"text");var matches=Regex.Matches(text,"^#{2,3} +(.+)$",RegexOptions.Multiline);var items=new List<(int Score,JsonObject Item)>();
        for(var i=0;i<matches.Count;i++){var begin=matches[i].Index+matches[i].Length;var end=i+1<matches.Count?matches[i+1].Index:text.Length;var body=text[begin..end].Trim();var title=matches[i].Groups[1].Value;var tokens=Regex.Matches(pattern.ToLowerInvariant(),"[\\p{L}\\p{N}_]+").Select(m=>m.Value);var score=tokens.Sum(t=>(title.Contains(t,StringComparison.OrdinalIgnoreCase)?4:0)+Math.Min(body.Split(t,StringSplitOptions.None).Length-1,6));if(score==0)continue;items.Add((score,new JsonObject{["title"]="ADL idioms cheatsheet",["snippet"]=body[..Math.Min(body.Length,220)],["resourceUri"]=Text(resource,"uri"),["section"]=title}));}
        return new JsonObject{["items"]=new JsonArray(items.OrderByDescending(i=>i.Score).ThenBy(i=>Text(i.Item,"section"),StringComparer.Ordinal).Take(5).Select(i=>(JsonNode)i.Item).ToArray()),["total"]=items.Count};
    }
    private XDocument TerminologyXml(){using var reader=XmlReader.Create(Path.Combine(root,"terminology","openehr_terminology.xml"),new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=4194304});return XDocument.Load(reader);}
    public JsonObject Terminology(){var x=TerminologyXml();return new JsonObject{["groups"]=new JsonArray(x.Descendants("group").Select(g=>(JsonNode)new JsonObject{["id"]=(string?)g.Attribute("openehr_id"),["name"]=(string?)g.Attribute("name"),["concepts"]=new JsonArray(g.Elements("concept").Select(c=>(JsonNode)new JsonObject{["id"]=(string?)c.Attribute("id"),["rubric"]=(string?)c.Attribute("rubric")}).ToArray())}).ToArray())};}
    public JsonObject Resolve(JsonObject args){var x=TerminologyXml();var input=Text(args,"input").Trim();var group=Text(args,"groupId");var matches=x.Descendants("group").Where(g=>group==""||(string?)g.Attribute("openehr_id")==group).SelectMany(g=>g.Elements("concept").Where(c=>(string?)c.Attribute("id")==input||string.Equals((string?)c.Attribute("rubric"),input,StringComparison.OrdinalIgnoreCase)).Select(c=>new JsonObject{["id"]=(string?)c.Attribute("id"),["rubric"]=(string?)c.Attribute("rubric"),["groupId"]=(string?)g.Attribute("openehr_id"),["groupName"]=(string?)g.Attribute("name")})).ToArray();return matches.FirstOrDefault()??throw new ProcessingException("TERMINOLOGY_NOT_FOUND");}
    public JsonArray Prompt(string name,JsonObject args,JsonObject contract){
        if(!Regex.IsMatch(name,"^[a-z_]+$"))throw new ProcessingException("PROMPT_NOT_FOUND");
        var parameters=(contract["arguments"] as JsonArray??[]).OfType<JsonObject>().ToArray();if(args.Any(p=>!parameters.Any(a=>Text(a,"name")==p.Key)))throw new ProcessingException("INVALID_PROMPT_ARGUMENTS");
        foreach(var p in parameters){var key=Text(p,"name");if(args[key] is not null&&args[key]!.GetValueKind() is not (System.Text.Json.JsonValueKind.String or System.Text.Json.JsonValueKind.Number))throw new ProcessingException("INVALID_PROMPT_ARGUMENTS");if(p["required"]?.GetValue<bool>()==true&&string.IsNullOrWhiteSpace(args[key]?.ToString()))throw new ProcessingException("PROMPT_ARGUMENT_REQUIRED");}
        foreach(var p in args)if(p.Value?.ToString().Length>2097152)throw new ProcessingException("PROMPT_ARGUMENT_LIMIT");
        if(Text(args,"adl_version") is not("" or "1.4" or "2")||Text(args,"format_variant") is not("" or "flat" or "structured")||Text(args,"translation_intent") is not("" or "add-new-language" or "improve-existing-translation" or "correct-terminology-phrasing"))throw new ProcessingException("INVALID_PROMPT_ARGUMENTS");
        if(Text(args,"task_type")=="specialise"&&name!="design_or_review_archetype")throw new ProcessingException("INVALID_PROMPT_ARGUMENTS");
        var task=Text(args,"task_type");if(task!=""&&!new[]{"design","review","specialise"}.Contains(task))throw new ProcessingException("INVALID_PROMPT_ARGUMENTS");
        if(task=="review"&&!args.Any(p=>p.Key.StartsWith("existing_",StringComparison.Ordinal)&&!string.IsNullOrWhiteSpace(p.Value?.ToString())))throw new ProcessingException("PROMPT_ARGUMENT_REQUIRED");
        if(task=="specialise"&&string.IsNullOrWhiteSpace(Text(args,"parent_archetype")))throw new ProcessingException("PROMPT_ARGUMENT_REQUIRED");
        var policy=File.ReadAllText(Path.Combine(root,"prompts","shared","policy.md"));var body=File.ReadAllText(Path.Combine(root,"prompts",name+".md"));var messages=new JsonArray();
        foreach(var source in new[]{policy,body}){
            var matches=Regex.Matches(source,"^## Role: (user|assistant)\\s*$",RegexOptions.Multiline);if(matches.Count==0)throw new ProcessingException("PROMPT_TEMPLATE_INVALID");
            for(var i=0;i<matches.Count;i++){var begin=matches[i].Index+matches[i].Length;var end=i+1<matches.Count?matches[i+1].Index:source.Length;var text=source[begin..end].Trim();text=Regex.Replace(text,"\\{\\{([a-z0-9_]+)\\}\\}",m=>args[m.Groups[1].Value]?.ToString()??"");messages.Add(new JsonObject{["role"]=matches[i].Groups[1].Value,["content"]=new JsonObject{["type"]="text",["text"]=text}});}
        }
        return messages;
    }
}
