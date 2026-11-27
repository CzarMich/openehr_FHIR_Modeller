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
                if (path == "projects" && context.Request.Method == "GET") result = await protocol.Execute("modelling_project", "list", null, args, actor, context.RequestAborted);
                else if (path == "projects" && context.Request.Method == "POST") {
                    Data.Keys(args, "projectId", "configuration");
                    result = await protocol.Execute("modelling_project", "create", Data.Required(args, "projectId"), args["configuration"] as JsonObject ?? throw new ProcessingException("PROJECT_CONFIGURATION_REQUIRED"), actor, context.RequestAborted);
                } else if (parts.Length == 2 && parts[0] == "projects" && context.Request.Method == "GET") result = protocol.Workspace.Models.GetProject(parts[1], actor);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "reuse" && context.Request.Method == "POST") result = protocol.Workspace.Models.Reuse(parts[1], args, actor);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "models") result = await protocol.Execute("modelling_model", context.Request.Method == "GET" ? "list" : "provide", parts[1], args, actor, context.RequestAborted);
                else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "mappings") result = await protocol.Execute("modelling_mapping", context.Request.Method == "GET" ? "list" : "prepare", parts[1], args, actor, context.RequestAborted);
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
                        policy = operational.ChangePolicy(scope, args["expectedRevision"]!.GetValue<int>(), args["pseudonymisePatientIdentifiers"]!.GetValue<bool>(), args["pseudonymSystem"]?.GetValue<string>(), actor.Id);
                    }
                    result = System.Text.Json.JsonSerializer.SerializeToNode(policy, Data.Json)!.AsObject();
                } else if (parts.Length == 3 && parts[0] == "projects" && parts[2] == "source-trust" && context.Request.Method == "POST") {
                    _ = protocol.Workspace.Models.GetProject(parts[1], actor); actor.Decision(parts[1]);
                    Data.Keys(args, "sourceSystem", "destinationId", "connectionSha256", "comment");
                    using var operational = ClinicalPipeline.Open(protocol.Workspace.Configuration);
                    operational.AuthorisePatientSource(new(actor.Owner, parts[1], Data.Required(args, "sourceSystem"), Data.Required(args, "destinationId")), Data.Required(args, "connectionSha256"), actor.Id, Data.Required(args, "comment"));
                    result = new JsonObject { ["authorised"] = true, ["scope"] = "EXACT_SOURCE_CONFIGURATION", ["patientIdentityRequired"] = true };
                } else if (parts.Length == 4 && parts[0] == "projects" && parts[2] == "pending" && context.Request.Method == "POST") {
                    _ = protocol.Workspace.Models.GetProject(parts[1], actor); actor.Project(parts[1], true);
                    if (!actor.Human || !actor.Roles.Intersect(["modelling-administrator", "modelling-approver"], StringComparer.Ordinal).Any()) throw new ProcessingException("HUMAN_CLINICAL_RECOVERY_REVIEW_REQUIRED");
                    var operation = parts[3];
                    var allowed = operation == "inspect" ? new[] { "sourceSystem", "destinationId", "pendingId" }
                        : operation == "resolve-patient" ? new[] { "sourceSystem", "destinationId", "pendingId", "expectedRevision", "sourceSha256", "patientSystem", "patientValue", "comment" }
                        : operation == "resolve-relationship" ? new[] { "sourceSystem", "destinationId", "pendingId", "expectedRevision", "sourceSha256", "role", "identifierSystem", "identifierValue", "comment" }
                        : operation == "recover" ? new[] { "sourceSystem", "destinationId", "pendingId", "expectedRevision", "sourceSha256", "comment", "action" }
                        : throw new ProcessingException("PENDING_ACTION_INVALID");
                    Data.Keys(args, allowed);
                    using var operational = ClinicalPipeline.Open(protocol.Workspace.Configuration); var queue = new DependencyQueue(operational);
                    var scope = new OperationalScope(actor.Owner, parts[1], Data.Required(args, "sourceSystem"), Data.Required(args, "destinationId"));
                    var pending = queue.Inspect(scope, Data.Required(args, "pendingId"), DateTimeOffset.UtcNow);
                    if (operation == "inspect") result = new JsonObject { ["id"] = pending.Id, ["revision"] = pending.Revision, ["state"] = pending.State, ["sourceSha256"] = pending.Input.SourceSha256, ["mappingSubject"] = pending.Input.MappingSubject, ["patientIdentityPresent"] = pending.Input.PatientIdentity is not null, ["plannedOutputs"] = queue.DeliveryPlan(scope, pending.Id)?.Outputs.Length ?? 0 };
                    else {
                        var definition = protocol.Workspace.Models.GetDefinition(pending.Input.MappingSubject, actor);
                        if (definition["mappingConfirmed"]?.GetValue<bool>() != true || definition["current"]?.GetValue<bool>() != true) throw new ProcessingException("CURRENT_HUMAN_CONFIRMATION_REQUIRED");
                        var mapping = new Mapping(Data.Required(definition, "executionMapping")); var policy = mapping.ClinicalPolicy ?? throw new ProcessingException("CLINICAL_POLICY_REQUIRED");
                        if (policy.IdentityDomain != scope.SourceSystem || policy.DestinationId != scope.DestinationId) throw new ProcessingException("CLINICAL_POLICY_SCOPE_MISMATCH");
                        if (operation == "resolve-patient") {
                            var identity = new ClinicalIdentity(Data.Required(args, "patientSystem"), Data.Required(args, "patientValue"));
                            var comment = Data.Required(args, "comment"); if (string.IsNullOrWhiteSpace(comment) || comment.Length > 4000) throw new ProcessingException("IDENTITY_RESOLUTION_COMMENT_REQUIRED");
                            var dependencies = policy.References.Where(reference => reference.Role == "patient" && reference.RequireDestination).Select(reference => new EntityKey("Patient", identity.System, identity.Value)).Distinct().ToArray();
                            var after = queue.AttachVerifiedPatient(scope, pending.Id, args["expectedRevision"]!.GetValue<int>(), Data.Required(args, "sourceSha256"), identity, actor.Id, Data.Hash(Data.Canonical(args)), DateTimeOffset.UtcNow, dependencies, comment);
                            result = new JsonObject { ["id"] = after.Id, ["revision"] = after.Revision, ["state"] = after.State, ["originalSourcePreserved"] = true };
                        } else if (operation == "resolve-relationship") {
                            var role = Data.Required(args, "role");
                            var references = policy.References.Where(reference => reference.Role == role && role != "patient").ToArray();
                            if (references.Length == 0 || references.Select(reference => reference.TargetType).Distinct(StringComparer.Ordinal).Count() != 1) throw new ProcessingException("SOURCE_RELATION_POLICY_REQUIRED");
                            var sourceModel = ((JsonArray)definition["items"]!).OfType<JsonObject>().Single(item => item["pin"]?["key"]?.GetValue<string>() == mapping.SourceProfileKey);
                            var contract = new SourceContract(Data.Required(sourceModel, "content"));
                            var relation = contract.Definition.Relations.Single(item => item.Role == role);
                            var identity = new ClinicalIdentity(Data.Required(args, "identifierSystem"), Data.Required(args, "identifierValue"));
                            if (relation.System is not null && relation.System != identity.System) throw new ProcessingException("RELATIONSHIP_ASSIGNING_AUTHORITY_MISMATCH");
                            var key = new EntityKey(references[0].TargetType, identity.System, identity.Value);
                            var destination = RecoveryDestination.Resolve(protocol.Workspace.Configuration, actor.Owner, parts[1], scope.DestinationId);
                            using var client = new FhirDelivery(protocol.Workspace.Configuration, destination);
                            await client.Check(Data.Required((JsonObject)definition["projectConfiguration"]!, "fhirVersion"), context.RequestAborted);
                            var candidate = pending with { Input = pending.Input with { Dependencies = [key] } };
                            if (!await new DestinationEvidence(operational, queue, scope, client).Refresh(candidate, context.RequestAborted)) throw new ProcessingException("WAITING_DEPENDENCIES");
                            var after = queue.AttachVerifiedRelationship(scope, pending.Id, args["expectedRevision"]!.GetValue<int>(), Data.Required(args, "sourceSha256"), role, key, actor.Id, Data.Required(args, "comment"), DateTimeOffset.UtcNow);
                            result = new JsonObject { ["id"] = after.Id, ["revision"] = after.Revision, ["state"] = after.State, ["originalSourcePreserved"] = true };
                        } else {
                            var recovery = await DeliveryRecovery.Check(operational, queue, scope, protocol.Workspace.Configuration, definition, pending.Id, args["expectedRevision"]!.GetValue<int>(), Data.Required(args, "sourceSha256"), actor.Id, Data.Required(args, "comment"), Data.Required(args, "action"), context.RequestAborted);
                            result = System.Text.Json.JsonSerializer.SerializeToNode(recovery, Data.Json)!.AsObject();
                        }
                    }
                } else if (path == "execute" && context.Request.Method == "POST") {
                    Data.Keys(args, "tool", "action", "projectId", "arguments");
                    result = await protocol.Execute(Data.Required(args, "tool"), Data.Required(args, "action"), args["projectId"]?.GetValue<string>(), args["arguments"] as JsonObject ?? new JsonObject(), actor, context.RequestAborted);
                } else return Results.Json(new { error = "NOT_FOUND" }, statusCode: 404);
                return Results.Json(result);
            } catch (ProcessingException error) {
                var status = error.Code.StartsWith("INTERACTIVE_", StringComparison.Ordinal) ? 401 : error.Code.Contains("PERMISSION", StringComparison.Ordinal) || error.Code.StartsWith("HUMAN_", StringComparison.Ordinal) ? 403 : error.Code.Contains("CONFLICT", StringComparison.Ordinal) || error.Code.Contains("IMMUTABLE", StringComparison.Ordinal) ? 409 : 422;
                return Results.Json(new { error = error.Code }, statusCode: status);
            } catch { return Results.Json(new { error = "MODELLING_OPERATION_FAILED" }, statusCode: 400); }
        });
    }
}
