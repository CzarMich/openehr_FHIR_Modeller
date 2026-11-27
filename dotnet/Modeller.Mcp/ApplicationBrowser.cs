using Modeller.Application;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Mcp;

public static class ApplicationBrowser
{
    public static void MapApplication(this WebApplication app,ModellingApplication application){
        app.MapMethods("/api/v1/{**route}",["GET","POST","PUT","DELETE"],async(HttpContext context)=>{
            try{
                var path=context.Request.Path.Value??"";var cancellation=context.RequestAborted;var review=path.StartsWith("/api/v1/reviews",StringComparison.Ordinal);var cdr=path.StartsWith("/api/v1/cdr/",StringComparison.Ordinal);var actor=review||cdr?await BrowserAssertion.Verify(context,cdr?"cdr":"review",cancellation):ApplicationAuthentication.Current(context);var input=await BrowserAssertion.Input(context,cancellation);
                if(review)return await Reviews(context,application,actor,input,cancellation);
                if(cdr)return await Cdr(context,actor,input,cancellation);
                return Models(context,application,actor,input);
            }catch(OperationCanceledException){return Results.StatusCode(499);}catch(Exception e){var code=e is ProcessingException p?p.Code:e is System.Text.Json.JsonException or InvalidOperationException?"INVALID_REQUEST":"OPERATION_FAILED";var status=code.Contains("AUTHENTICATION",StringComparison.Ordinal)?401:code.Contains("PERMISSION",StringComparison.Ordinal)||code.Contains("HUMAN",StringComparison.Ordinal)||code is "WRITES_DISABLED" or "GOVERNANCE_ROLE_REQUIRED" or "GOVERNANCE_VALIDATION_REQUIRED" or "GOVERNANCE_VALIDATION_CONFIRMATION_REQUIRED" or "GOVERNANCE_INVALID_TRANSITION" or "GOVERNANCE_MODELLER_REQUIRED"?403:code.EndsWith("_NOT_FOUND",StringComparison.Ordinal)||code=="NOT_FOUND"?404:code.Contains("CONFLICT",StringComparison.Ordinal)||code.EndsWith("_CHANGED",StringComparison.Ordinal)?409:code.Contains("NOT_CONFIGURED",StringComparison.Ordinal)||code.Contains("UNAVAILABLE",StringComparison.Ordinal)?503:code=="JSON_REQUIRED"?415:code=="REQUEST_BODY_LIMIT"?413:code=="OPERATION_FAILED"?500:400;return Results.Json(new{error=new{code}},statusCode:status);}
        });
    }
    private static Dictionary<string,string> Query(HttpContext context,params string[] allowed){var result=new Dictionary<string,string>(StringComparer.Ordinal);foreach(var(k,v)in context.Request.Query){if(!allowed.Contains(k)||v.Count!=1)throw new ProcessingException("INVALID_MODEL_API_QUERY");result[k]=v.ToString();}return result;}
    private static string Value(Dictionary<string,string> input,string key)=>input.GetValueOrDefault(key)??throw new ProcessingException("INVALID_MODEL_API_QUERY");
    private static IResult Models(HttpContext context,ModellingApplication app,ModellingIdentity actor,JsonObject input){
        var path=context.Request.Path.Value??"";var method=context.Request.Method;var repository=app.Repository(actor);
        if(path=="/api/v1/projects"){
            Query(context);if(method=="GET"){var projects=new JsonArray(repository.List().OfType<JsonObject>().Where(p=>actor.CanReadProject(Data.Required(p,"id"))).Select(p=>(JsonNode)p.DeepClone()).ToArray());return Results.Json(new JsonObject{["projects"]=projects,["capabilities"]=RepositoryOperations.Capabilities(repository is GitRepository?"git":repository is SharePointRepository?"sharepoint":"filesystem")});}
            if(method!="POST")return Results.StatusCode(405);Data.Keys(input,"id","name","description");actor.Create(Data.Required(input,"id"));return Results.Json(new JsonObject{["project"]=repository.Create(Data.Required(input,"id"),Data.Required(input,"name"),KnowledgeCorpus.Text(input,"description"))},statusCode:201);
        }
        var match=Regex.Match(path,"^/api/v1/projects/([A-Za-z0-9_-]{1,64})(/archive)?$");if(match.Success){Query(context);var id=match.Groups[1].Value;actor.Read(id);if(!match.Groups[2].Success&&method=="GET")return Results.Json(new JsonObject{["project"]=repository.Project(id),["artifacts"]=repository.Artifacts(id)});if(match.Groups[2].Success&&method=="POST"){Data.Keys(input,"expectedRevision");actor.Write(id);return Results.Json(new JsonObject{["project"]=repository.Archive(id,Data.Required(input,"expectedRevision"))});}return Results.StatusCode(405);}
        if(path is "/api/v1/artifacts" or "/api/v1/artifact-history"){
            var query=Query(context,path=="/api/v1/artifacts"?["project","path","revision"]:["project","path"]);var project=Value(query,"project");actor.Read(project);var artifactPath=Value(query,"path");
            if(path=="/api/v1/artifact-history")return method=="GET"?Results.Json(new JsonObject{["versions"]=repository.History(project,artifactPath)}):Results.StatusCode(405);
            if(method=="GET")return Results.Json(repository.Artifact(project,artifactPath,query.GetValueOrDefault("revision")));
            if(method!="PUT")return Results.StatusCode(405);Data.Keys(input,"content","metadata","expectedRevision");actor.Write(project);return Results.Json(repository.Save(project,artifactPath,input["content"]?.GetValue<string>()??throw new ProcessingException("MODEL_CONTENT_REQUIRED"),input["metadata"] as JsonObject??new JsonObject(),input["expectedRevision"]?.GetValue<string>()));
        }throw new ProcessingException("NOT_FOUND");
    }
    private static async Task<IResult> Reviews(HttpContext context,ModellingApplication app,ModellingIdentity actor,JsonObject input,CancellationToken cancellation){
        var repository=app.Repository(actor);using var engine=new StandardsGateway();var service=new ReviewGovernance(repository,actor,engine);var path=context.Request.Path.Value??"";
        if(path=="/api/v1/reviews"&&context.Request.Method=="GET"){var q=Query(context,"project","count","offset");var args=new JsonObject{["project"]=Value(q,"project"),["count"]=int.Parse(q.GetValueOrDefault("count","25"),System.Globalization.CultureInfo.InvariantCulture),["offset"]=int.Parse(q.GetValueOrDefault("offset","0"),System.Globalization.CultureInfo.InvariantCulture)};return Results.Json(await service.Execute("governance_list",args,cancellation));}
        Query(context);var confirmation=Regex.Match(path,"^/api/v1/reviews/confirmations/([a-f0-9]{64})$");if(confirmation.Success){var selections=new MappingSelections(repository,app.Repository(actor,true),actor);if(context.Request.Method=="GET")return Results.Json(selections.Get(confirmation.Groups[1].Value));if(context.Request.Method!="POST")return Results.StatusCode(405);Data.Keys(input,"decision","expectedSequence","comment");return Results.Json(selections.Decide(confirmation.Groups[1].Value,input["expectedSequence"]!.GetValue<int>(),Data.Required(input,"decision"),Data.Required(input,"comment")));}
        var match=Regex.Match(path,"^/api/v1/reviews/([a-f0-9]{64})(/transitions)?$");if(!match.Success)throw new ProcessingException("NOT_FOUND");var subject=match.Groups[1].Value;if(context.Request.Method=="GET"&&!match.Groups[2].Success){using var ledger=new AuditLedger();return Results.Json(service.View(ledger,subject,true));}if(context.Request.Method!="POST"||!match.Groups[2].Success)return Results.StatusCode(405);Data.Keys(input,"state","expectedSequence","comment","validationDigest");return Results.Json(service.HumanTransition(subject,input["expectedSequence"]!.GetValue<int>(),Data.Required(input,"state"),Data.Required(input,"comment"),input["validationDigest"]?.GetValue<string>()));
    }
    private static async Task<IResult> Cdr(HttpContext context,ModellingIdentity actor,JsonObject input,CancellationToken cancellation){
        if(context.Request.Method!="POST"||context.Request.QueryString.HasValue)return Results.StatusCode(405);var operation=context.Request.Path.Value!["/api/v1/cdr/".Length..];using var engine=new StandardsGateway();var service=new CdrWorkspace(engine,actor);JsonNode result;
        switch(operation){
            case "connections":Data.Keys(input);result=new JsonObject{["items"]=service.Connections()};break;
            case "connection-save":Data.Keys(input,"connection");result=service.SaveConnection(input["connection"] as JsonObject??throw new ProcessingException("CDR_INVALID_CONNECTION"));break;
            case "connection-delete":Data.Keys(input,"id");result=service.DeleteConnection(Data.Required(input,"id"));break;
            case "connection-test":case "capabilities":Data.Keys(input,"id");result=await service.Execute(operation=="connection-test"?"cdr_connection_test":"cdr_capabilities",new JsonObject{["connection_id"]=Data.Required(input,"id")},cancellation);break;
            case "templates":Data.Keys(input,"id","identifier");result=await service.Templates(Data.Required(input,"id"),input["identifier"]?.GetValue<string>(),cancellation);break;
            case "execute":case "execute-metadata":Data.Keys(input,"id","query","parameters","fetch","offset","job");var request=(JsonObject)input.DeepClone();request["connection_id"]=Data.Required(input,"id");if(input["job"] is not null)request["job_id"]=input["job"]!.DeepClone();result=await service.Query(request,cancellation);if(operation=="execute-metadata"){var metadata=new JsonObject();foreach(var key in new[]{"job_id","connection_id","duration_ms","count","fetch","offset","has_more","results_persisted","results_sent_to_ai"})metadata[key]=result[key]?.DeepClone();result=metadata;}break;
            case "cancel":Data.Keys(input,"job");result=service.Cancel(Data.Required(input,"job"));break;
            case "history":case "history-clear":Data.Keys(input,"connection_id");result=operation=="history"?service.History(input["connection_id"]?.GetValue<string>()):service.ClearHistory(input["connection_id"]?.GetValue<string>());break;
            case "saved":Data.Keys(input,"connection_id");result=service.Saved(null,input["connection_id"]?.GetValue<string>());break;
            case "saved-get":Data.Keys(input,"id","connection_id");result=service.Saved(Data.Required(input,"id"),input["connection_id"]?.GetValue<string>());break;
            case "saved-save":Data.Keys(input,"id","connection_id","name","query");result=service.SaveQuery(input);break;
            case "saved-delete":Data.Keys(input,"id","connection_id");result=service.DeleteQuery(Data.Required(input,"id"),input["connection_id"]?.GetValue<string>());break;
            case "validate":Data.Keys(input,"query","templates");result=await engine.Native("validate/aql",Data.Required(input,"query"),input["templates"] as JsonArray,cancellation);break;
            case "explain":Data.Keys(input,"query","templates");result=await service.Execute("aql_explain",input,cancellation);break;
            case "generate":Data.Keys(input,"content","format","paths","dependencies");result=await service.Execute("model_generate_aql",input,cancellation);break;
            case "inspect":Data.Keys(input,"content","format","dependencies");result=await engine.Native(KnowledgeCorpus.Text(input,"format") is "opt14" or "opt2"?"inspect/opt":"inspect/archetype",Data.Required(input,"content"),input["dependencies"] as JsonArray,cancellation);break;
            case "compile":Data.Keys(input,"content","dependencies");result=await engine.Native("compile/template",Data.Required(input,"content"),input["dependencies"] as JsonArray,cancellation);break;
            default:throw new ProcessingException("CDR_UNKNOWN_OPERATION");
        }return Results.Json(result);
    }
}
