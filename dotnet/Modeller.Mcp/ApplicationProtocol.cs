using Modeller.Application;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Modeller.Core;
namespace Modeller.Mcp;

public sealed class ApplicationProtocol
{
    private readonly Dictionary<string,JsonObject> tools;
    private readonly JsonObject contract;
    private readonly ModellingApplication application;
    private readonly KnowledgeCorpus corpus;
    private readonly GuideRepository guides;
    private readonly Func<ModellingIdentity> identity;
    public ApplicationProtocol(string resourceRoot,GuideRepository guides,Func<ModellingIdentity> identity){this.guides=guides;this.identity=identity;application=new ModellingApplication(resourceRoot);corpus=new KnowledgeCorpus(resourceRoot);contract=JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"contracts","modelling-baseline.json"))) as JsonObject??throw new InvalidOperationException("Modelling contracts required.");foreach(var descriptor in JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"contracts","database-discovery.json")))!.AsArray())((JsonArray)contract["tools"]!).Add(descriptor!.DeepClone());tools=((JsonArray)contract["tools"]!).OfType<JsonObject>().ToDictionary(t=>Data.Required(t,"name"),StringComparer.Ordinal);}
    public IList<Tool> Tools=>tools.Values.Select(t=>JsonSerializer.Deserialize<Tool>(t.ToJsonString())!).ToList();
    public IList<Resource> Resources=>((JsonArray)contract["resources"]!).Select(r=>JsonSerializer.Deserialize<Resource>(r!.ToJsonString())!).ToList();
    public IList<ResourceTemplate> Templates=>((JsonArray)contract["resourceTemplates"]!).Select(r=>JsonSerializer.Deserialize<ResourceTemplate>(r!.ToJsonString())!).ToList();
    public IList<Prompt> Prompts=>((JsonArray)contract["prompts"]!).Select(p=>JsonSerializer.Deserialize<Prompt>(p!.ToJsonString())!).ToList();
    public async ValueTask<CallToolResult> Call(string name,IDictionary<string,JsonElement>? input,CancellationToken cancellation){
        if(!tools.TryGetValue(name,out var tool))throw new McpProtocolException("Unknown modelling tool.",McpErrorCode.InvalidParams);var args=JsonSerializer.SerializeToNode(input??new Dictionary<string,JsonElement>()) as JsonObject??new JsonObject();
        var schema=(JsonObject)tool["inputSchema"]!;try{ContractSchema.Validate(args,schema);args=ContractSchema.Defaults(args,schema);}catch(ProcessingException){throw new McpProtocolException("Input does not meet the published tool schema.",McpErrorCode.InvalidParams);}
        var wrapped=tool["outputSchema"]?["properties"]?["success"] is not null;
        try{
            if(name=="guide_get")return new CallToolResult{Content=[new EmbeddedResourceBlock{Resource=guides.Get(KnowledgeCorpus.Text(args,"uri"),args["category"]?.GetValue<string>(),KnowledgeCorpus.Text(args,"name"))}]};
            var result=await application.Execute(name,args,identity(),cancellation);
            if(name.EndsWith("_get",StringComparison.Ordinal)&&result is JsonObject text&&text["type"]?.GetValue<string>()=="text")return new CallToolResult{Content=[new TextContentBlock{Text=KnowledgeCorpus.Text(text,"text")}]};
            if(name=="examples_get"&&result is JsonObject resource)return new CallToolResult{Content=[new EmbeddedResourceBlock{Resource=JsonSerializer.Deserialize<TextResourceContents>(resource.ToJsonString())!}]};
            var output=wrapped?new JsonObject{["success"]=true,["result"]=result,["error"]=null}:result;
            if(tool["outputSchema"] is JsonObject outputSchema)ContractSchema.Validate(output,outputSchema);
            return new CallToolResult{StructuredContent=JsonSerializer.SerializeToElement(output),Content=[new TextContentBlock{Text=output.ToJsonString()}]};
        }catch(OperationCanceledException){throw;}
        catch(Exception error){var code=error is ProcessingException p?p.Code:error is GuideLookupException?"GUIDE_NOT_FOUND":"OPERATION_FAILED";var safe=System.Text.RegularExpressions.Regex.IsMatch(code,"^[A-Z][A-Z0-9_]{2,80}$")?code:"OPERATION_FAILED";var envelope=new JsonObject{["success"]=false,["result"]=null,["error"]=new JsonObject{["code"]=safe,["message"]=safe=="CDR_BROWSER_ONLY"?"Patient query execution, history and saved query content are available only in the authenticated browser workspace.":safe=="REVISION_CONFLICT"?"The artefact changed. Retrieve its current revision before retrying.":safe=="MAPPING_HUMAN_CONFIRMATION_REQUIRED"?"The user must confirm the exact supplied models before mapping.":"The operation could not be completed. Check its fixed error code, inputs and configured dependencies.",["retryable"]=safe is "OPERATION_FAILED" or "ENGINE_UNAVAILABLE"}};return new CallToolResult{IsError=true,StructuredContent=wrapped?JsonSerializer.SerializeToElement(envelope):null,Content=[new TextContentBlock{Text=envelope.ToJsonString()}]};}
    }
    public TextResourceContents Resource(string uri)=>JsonSerializer.Deserialize<TextResourceContents>(corpus.Resource(uri).ToJsonString())!;
    public GetPromptResult Prompt(string name,IDictionary<string,JsonElement>? input){var descriptor=((JsonArray)contract["prompts"]!).OfType<JsonObject>().SingleOrDefault(p=>KnowledgeCorpus.Text(p,"name")==name)??throw new McpProtocolException("Unknown prompt.",McpErrorCode.InvalidParams);var args=JsonSerializer.SerializeToNode(input??new Dictionary<string,JsonElement>()) as JsonObject??new JsonObject();try{return JsonSerializer.Deserialize<GetPromptResult>(new JsonObject{["description"]=descriptor["description"]?.DeepClone(),["messages"]=corpus.Prompt(name,args,descriptor)}.ToJsonString())!;}catch(ProcessingException){throw new McpProtocolException("Invalid prompt arguments.",McpErrorCode.InvalidParams);}}
}
public static class ApplicationProtocolBuilder
{
    public static IMcpServerBuilder AddApplication(this IMcpServerBuilder builder,ApplicationProtocol app)=>builder
        .WithListToolsHandler((_,_)=>ValueTask.FromResult(new ListToolsResult{Tools=app.Tools}))
        .WithCallToolHandler((request,cancellation)=>app.Call(request.Params?.Name??"",request.Params?.Arguments,cancellation))
        .WithListResourcesHandler((_,_)=>ValueTask.FromResult(new ListResourcesResult{Resources=app.Resources}))
        .WithListResourceTemplatesHandler((_,_)=>ValueTask.FromResult(new ListResourceTemplatesResult{ResourceTemplates=app.Templates}))
        .WithReadResourceHandler((request,_)=>{try{return ValueTask.FromResult(new ReadResourceResult{Contents=[app.Resource(request.Params?.Uri??"")]});}catch(ProcessingException){throw new McpProtocolException("Resource not found.",McpErrorCode.InvalidParams);}})
        .WithListPromptsHandler((_,_)=>ValueTask.FromResult(new ListPromptsResult{Prompts=app.Prompts}))
        .WithGetPromptHandler((request,_)=>ValueTask.FromResult(app.Prompt(request.Params?.Name??"",request.Params?.Arguments)));
}
