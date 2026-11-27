using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace Modeller.Core;

/** Shared C# entrypoints for MCP and the authenticated browser adapter. */
public sealed class Workspace(ModelStore models, Configuration configuration)
{
    public ModelStore Models => models;
    public Configuration Configuration => configuration;
    public async Task<JsonObject> Execute(string tool, string action, string? projectId, JsonObject arguments, ModelActor actor, CancellationToken cancellation) {
        if (tool == "modelling_project") {
            if (action == "list") return new JsonObject { ["items"] = models.Projects(actor) };
            if (projectId is null) throw new ProcessingException("PROJECT_REQUIRED");
            return action switch { "get" => models.GetProject(projectId, actor), "create" => models.CreateProject(projectId, arguments, actor), _ => throw new ProcessingException("ACTION_UNSUPPORTED") };
        }
        if (tool == "modelling_model") {
            if (action == "get") return models.GetModel(Data.Required(arguments, "key"), actor);
            if (projectId is null) throw new ProcessingException("PROJECT_REQUIRED");
            return action switch { "list" => new JsonObject { ["items"] = models.Models(projectId, actor) }, "provide" => models.ProvideModel(projectId, arguments, actor), _ => throw new ProcessingException("ACTION_UNSUPPORTED") };
        }
        if (tool == "modelling_mapping") {
            if (action == "help") { Data.Keys(arguments); return MappingHelp.Document(); }
            if (action == "get") return models.GetDefinition(Data.Required(arguments, "subject"), actor);
            if (projectId is null) throw new ProcessingException("PROJECT_REQUIRED");
            if (action == "list") return new JsonObject { ["items"] = models.Definitions(projectId, actor) };
            if (action == "reuse") return models.Reuse(projectId, arguments, actor);
            if (action == "prepare") return models.Prepare(projectId, arguments, actor);
            if (action == "preview") {
                Data.Keys(arguments, "subject", "synthetic", "records");
                if (arguments["synthetic"]?.GetValue<bool>() != true || arguments["records"] is not JsonArray records || records.Count is < 1 or > 100 || records.ToJsonString().Length > 262144 || records.Any(r => r is not JsonObject)) throw new ProcessingException("SYNTHETIC_PREVIEW_REQUIRED");
                var definition = models.GetDefinition(Data.Required(arguments, "subject"), actor);
                if (definition["project"]?.GetValue<string>() != projectId || definition["mappingConfirmed"]?.GetValue<bool>() != true) throw new ProcessingException("CURRENT_HUMAN_CONFIRMATION_REQUIRED");
                var mapping = new Mapping(Data.Required(definition, "executionMapping")); mapping.VerifyExamples();
                var input = records.OfType<JsonObject>().ToList(); mapping.VerifySource(input);
                var outputs = new JsonArray(); var rejected = new JsonArray();
                foreach (var group in mapping.Group(input)) {
                    try {
                        foreach (var value in mapping.Transform(group.Record)) outputs.Add(new JsonObject { ["output"] = value.Output, ["composition"] = value.Composition?.DeepClone(), ["provenance"] = System.Text.Json.JsonSerializer.SerializeToNode(value.Provenance), ["unmapped"] = System.Text.Json.JsonSerializer.SerializeToNode(value.Unmapped), ["validation"] = "NOT_EXECUTED" });
                    } catch (ProcessingException error) when (error.Code.StartsWith("RECORD_", StringComparison.Ordinal)) { rejected.Add(new JsonObject { ["sourceCount"] = group.SourceCount, ["code"] = error.Code }); }
                }
                return new JsonObject { ["synthetic"] = true, ["clinicalApproval"] = false, ["emitted"] = 0, ["validation"] = "NOT_EXECUTED", ["outputs"] = outputs, ["rejected"] = rejected };
            }
            throw new ProcessingException("ACTION_UNSUPPORTED");
        }
        if (tool == "source_inspect") {
            Data.Keys(arguments, "synthetic", "format", "content");
            var content = Data.Required(arguments, "content");
            if (arguments["synthetic"]?.GetValue<bool>() != true || Encoding.UTF8.GetByteCount(content) > 262144) throw new ProcessingException("SYNTHETIC_INSPECTION_REQUIRED");
            var records = Sources.Parse(Encoding.UTF8.GetBytes(content), Data.Required(arguments, "format"));
            if (records.Count > 100) throw new ProcessingException("SYNTHETIC_RECORD_LIMIT");
            return System.Text.Json.JsonSerializer.SerializeToNode(Sources.Describe(records), Data.Json) as JsonObject ?? throw new ProcessingException("INSPECTION_FAILED");
        }
        if (tool == "modelling_engine") {
            if (projectId is null) throw new ProcessingException("PROJECT_REQUIRED");
            var project = models.GetProject(projectId, actor);
            Data.Keys(arguments, "operation", "parameters", "synthetic");
            var operation = Data.Required(arguments, "operation"); var parameters = arguments["parameters"] as JsonObject ?? throw new ProcessingException("ENGINE_PARAMETERS_REQUIRED");
            using var http = Network.Client(TimeSpan.FromSeconds(650));
            if (action == "fhir") {
                var allowed = new[] { "capabilities.get", "source.inspect", "package.search", "package.get", "package.install", "package.dependencies", "package.artifacts", "package.resolve", "artifact.inspect", "artifact.diff", "artifact.validate", "profile.discover", "profile.generate", "fsh.compile", "fhirpath.validate", "fhirpath.evaluate", "examples.generate" };
                if (!allowed.Contains(operation, StringComparer.Ordinal)) throw new ProcessingException("ENGINE_OPERATION_UNSUPPORTED");
                if (operation is "artifact.validate" or "fhirpath.evaluate" && arguments["synthetic"]?.GetValue<bool>() != true) throw new ProcessingException("SYNTHETIC_ENGINE_INPUT_REQUIRED");
                parameters["project"] = project;
                using var request = new HttpRequestMessage(HttpMethod.Post, configuration.FhirUrl.TrimEnd('/') + "/execute") { Content = JsonContent.Create(new { operation, parameters, tenant = "dotnet-modelling" }) };
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Network.Key(configuration.FhirKeyFile));
                using var response = await Network.Compute(http, request, cancellation);
                if (!response.IsSuccessStatusCode) throw new ProcessingException("FHIR_ENGINE_UNAVAILABLE");
                return await Network.Object(response, cancellation, 12 * 1048576);
            }
            if (action == "openehr") {
                if (!new[] { "validate/archetype", "validate/template", "validate/opt", "compile/template", "inspect/archetype", "inspect/opt", "validate/aql", "validate/composition" }.Contains(operation, StringComparer.Ordinal)) throw new ProcessingException("ENGINE_OPERATION_UNSUPPORTED");
                if (operation == "validate/composition" && arguments["synthetic"]?.GetValue<bool>() != true) throw new ProcessingException("SYNTHETIC_ENGINE_INPUT_REQUIRED");
                Data.Keys(parameters, "content", "dependencies");
                using var request = new HttpRequestMessage(HttpMethod.Post, configuration.NativeUrl.TrimEnd('/') + "/v1/" + operation) { Content = JsonContent.Create(parameters) };
                request.Headers.Add("X-Engine-Key", Network.Key(configuration.NativeKeyFile));
                using var response = await Network.Compute(http, request, cancellation);
                if (!response.IsSuccessStatusCode) throw new ProcessingException("OPENEHR_ENGINE_UNAVAILABLE");
                return Network.NativeData(await Network.Object(response, cancellation, 12 * 1048576));
            }
        }
        throw new ProcessingException("TOOL_UNSUPPORTED");
    }
}
