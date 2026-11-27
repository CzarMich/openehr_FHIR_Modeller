using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Extensions;
using Modeller.Core;
using Modeller.Operational;

namespace Modeller.Mcp;

public static class WorkspaceHttp
{
    public static void MapWorkspace(this WebApplication app, WorkspaceProtocol protocol, HumanProof proof)
    {
        app.MapMethods("/api/v1/integration/{**path}", ["GET", "POST"], async (HttpContext context, string path) => {
            try {
                if (context.Request.QueryString.HasValue) return Results.Json(new { error = "QUERY_UNSUPPORTED" }, statusCode: 400);
                var body = "";
                if (context.Request.Method == "POST") {
                    if (!context.Request.HasJsonContentType()) return Results.Json(new { error = "JSON_REQUIRED" }, statusCode: 415);
                    using var reader = new StreamReader(context.Request.Body, new UTF8Encoding(false, true)); body = await reader.ReadToEndAsync(context.RequestAborted);
                    if (Encoding.UTF8.GetByteCount(body) > 8 * 1048576) return Results.Json(new { error = "REQUEST_LIMIT" }, statusCode: 413);
                }
                var authorization = context.Request.Headers.Authorization.ToString();
                if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal)) return Results.Json(new { error = "INTERACTIVE_ASSERTION_REQUIRED" }, statusCode: 401);
                var actor = proof.Verify(authorization[7..], context.Request.Method, context.Request.GetEncodedPathAndQuery(), body, context.Request.Method == "GET" || System.Text.RegularExpressions.Regex.IsMatch(path, "^projects/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}/reuse$") ? 3600 : 600);
                JsonObject args = body.Length == 0 ? new JsonObject() : Data.ParseStrict(Encoding.UTF8.GetBytes(body)) as JsonObject ?? throw new ProcessingException("ARGUMENTS_OBJECT_REQUIRED");
                JsonObject result;
                var parts = path.Split('/');
                if (path == "projects" && context.Request.Method == "GET") result = await protocol.Workspace.Execute("modelling_project", "list", null, args, actor, context.RequestAborted);
                else if (path == "projects" && context.Request.Method == "POST") {
                    Data.Keys(args, "projectId", "configuration");
                    result = await protocol.Workspace.Execute("modelling_project", "create", Data.Required(args, "projectId"), args["configuration"] as JsonObject ?? throw new ProcessingException("PROJECT_CONFIGURATION_REQUIRED"), actor, context.RequestAborted);
                } else if (parts.Length == 2 && parts[0] == "projects" && context.Request.Method == "GET") result = protocol.Workspace.Models.GetProject(parts[1], actor);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "reuse" && context.Request.Method == "POST") result = protocol.Workspace.Models.Reuse(parts[1], args, actor);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "models") result = await protocol.Workspace.Execute("modelling_model", context.Request.Method == "GET" ? "list" : "provide", parts[1], args, actor, context.RequestAborted);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "mappings") result = await protocol.Workspace.Execute("modelling_mapping", context.Request.Method == "GET" ? "list" : "prepare", parts[1], args, actor, context.RequestAborted);
                else if (parts.Length == 2 && parts[0] == "mappings" && context.Request.Method == "GET") result = protocol.Workspace.Models.GetDefinition(parts[1], actor);
                else if (parts.Length == 3 && parts[0] == "mappings" && parts[2] == "decisions" && context.Request.Method == "POST") {
                    Data.Keys(args, "decision", "expectedSequence", "comment");
                    result = protocol.Workspace.Models.Decide(parts[1], args["expectedSequence"]!.GetValue<int>(), Data.Required(args, "decision"), Data.Required(args, "comment"), actor);
                } else if (parts.Length == 5 && parts[0] == "projects" && parts[2] == "destinations" && parts[4] == "privacy") {
                    _ = protocol.Workspace.Models.GetProject(parts[1], actor);
                    if (!System.Text.RegularExpressions.Regex.IsMatch(parts[3], "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")) throw new ProcessingException("DESTINATION_IDENTIFIER_REQUIRED");
                    using var operational = ClinicalPipeline.Open(protocol.Workspace.Configuration);
                    var scope = new OperationalScope(actor.Owner, parts[1], "destination-policy", parts[3]);
                    DestinationPrivacyPolicy policy;
                    if (context.Request.Method == "GET") policy = operational.Policy(scope);
                    else {
                        actor.Decision(parts[1]);
                        Data.Keys(args, "expectedRevision", "pseudonymisePatientIdentifiers", "pseudonymSystem");
                        policy = operational.ChangePolicy(scope, args["expectedRevision"]!.GetValue<int>(), args["pseudonymisePatientIdentifiers"]!.GetValue<bool>(), args["pseudonymSystem"]?.GetValue<string>());
                    }
                    result = System.Text.Json.JsonSerializer.SerializeToNode(policy, Data.Json)!.AsObject();
                } else if (path == "execute" && context.Request.Method == "POST") {
                    Data.Keys(args, "tool", "action", "projectId", "arguments");
                    result = await protocol.Workspace.Execute(Data.Required(args, "tool"), Data.Required(args, "action"), args["projectId"]?.GetValue<string>(), args["arguments"] as JsonObject ?? new JsonObject(), actor, context.RequestAborted);
                } else return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
                return Results.Json(result);
            } catch (ProcessingException error) {
                var status = error.Code.StartsWith("INTERACTIVE_", StringComparison.Ordinal) ? 401 : error.Code.Contains("PERMISSION", StringComparison.Ordinal) || error.Code.StartsWith("HUMAN_", StringComparison.Ordinal) ? 403 : error.Code.Contains("CONFLICT", StringComparison.Ordinal) || error.Code.Contains("IMMUTABLE", StringComparison.Ordinal) ? 409 : 422;
                return Results.Json(new { error = error.Code }, statusCode: status);
            } catch { return Results.Json(new { error = "MODELLING_OPERATION_FAILED" }, statusCode: 400); }
        });
    }
}
