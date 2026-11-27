using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;
using Modeller.Core;
using Modeller.Operational;

namespace Modeller.Mcp;

public sealed class WorkspaceProtocol(Workspace workspace, bool allowDraftWrites)
{
    public Workspace Workspace => workspace;
    private static readonly Dictionary<string, string[]> Actions = new(StringComparer.Ordinal) {
        ["modelling_project"] = ["list", "get", "create"],
        ["modelling_model"] = ["list", "get", "provide"],
        ["modelling_mapping"] = ["help", "list", "get", "reuse", "prepare", "preview"],
        ["source_inspect"] = ["inspect"], ["modelling_engine"] = ["fhir", "openehr"]
    };
    public static bool Mutation(string tool, string action, JsonObject args) => action is "create" or "provide" or "prepare" || tool == "modelling_engine" && args["operation"]?.GetValue<string>() == "package.install";
    public IList<Tool> Tools => Actions.Select(entry => {
        var description = entry.Key switch {
            "modelling_project" => "Create/list/read immutable C# modelling projects with an exact FHIR release and dependencies. arguments is JSON configuration for create. No clinical database writes.",
            "modelling_model" => "Provide/list/read actual FHIR StructureDefinitions, openEHR template XML or versioned source-contract JSON in the C# workspace. provide requires id, standard, exact version, origin, content and provenance. Parsed models are not clinically approved.",
            "modelling_mapping" => "Call help for the version-2 format and executable synthetic example. Before generating, call reuse with context, sourceSchemaSha256, requirements, modelKeys and direction to find existing exact-context work without provider calls. Optional reuseContext on prepare pins sourceSystem, sourceSemanticsVersion, purpose and terminologyPins (canonical/version/sha256). Reuse cannot create approval. Prepare/list/read versioned narrative-guided executable mappings; preview is synthetic only. prepare needs modelKeys and executionMapping JSON string. A human confirms exact models/rules in the browser; agents cannot approve. Source-to-FHIR, source-to-openEHR, openEHR-to-FHIR and FHIR-to-openEHR are independent one-stage mappings. The retired combined source-to-fhir value requires a newly confirmed version. Private execution also requires an exact source-contract model and clinicalPolicy; retrieve mapping help.",
            "source_inspect" => "Inspect bounded synthetic CSV, custom/FHIR/openEHR JSON, XML or HL7 v2/v3/CDA content using the C# parser. arguments requires synthetic:true, format and content. Returns structure and unresolved meanings without record samples. A synthetic marker does not detect PHI; never supply patient records.",
            _ => "Use the configured private FHIR or openEHR compiler/validator. arguments contains fixed operation and parameters; patient-data operations and database writes are unavailable. Validation/FHIRPath instance inputs require synthetic:true. Reports retain their actual scope and do not grant approval."
        };
        var schema = new JsonObject { ["type"] = "object", ["additionalProperties"] = false, ["required"] = new JsonArray("action"), ["properties"] = new JsonObject {
            ["action"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray(entry.Value.Select(v => (JsonNode)JsonValue.Create(v)!).ToArray()) },
            ["projectId"] = new JsonObject { ["type"] = "string", ["maxLength"] = 64 }, ["arguments"] = new JsonObject { ["type"] = "string", ["maxLength"] = 4194304 }
        } };
        return JsonSerializer.Deserialize<Tool>(new JsonObject { ["name"] = entry.Key, ["description"] = description, ["inputSchema"] = schema,
            ["annotations"] = new JsonObject { ["readOnlyHint"] = entry.Key == "source_inspect", ["destructiveHint"] = false, ["openWorldHint"] = entry.Key == "modelling_engine" },
            ["outputSchema"] = JsonNode.Parse("{\"type\":\"object\",\"required\":[\"success\",\"result\",\"error\"],\"additionalProperties\":false,\"properties\":{\"success\":{\"type\":\"boolean\"},\"result\":{\"type\":[\"object\",\"null\"]},\"error\":{\"type\":[\"string\",\"null\"]}}}")
        }.ToJsonString())!;
    }).ToList();
    public Task<JsonObject> Execute(string name, string action, string? project, JsonObject args, ModelActor actor, CancellationToken cancellation) {
        if (name == "source_inspect" && args["format"]?.GetValue<string>() is "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda") {
            Data.Keys(args, "synthetic", "format", "content");
            var content = System.Text.Encoding.UTF8.GetBytes(Data.Required(args, "content"));
            if (args["synthetic"]?.GetValue<bool>() != true || content.Length > 262144) throw new ProcessingException("SYNTHETIC_INSPECTION_REQUIRED");
            return Task.FromResult(ClinicalMessages.Describe(content, Data.Required(args, "format")));
        }
        return workspace.Execute(name, action, project, args, actor, cancellation);
    }
    public async ValueTask<CallToolResult> Call(string name, IDictionary<string, JsonElement>? input, CancellationToken cancellation) {
        JsonObject envelope;
        try {
            if (!Actions.TryGetValue(name, out var actions) || input is null || input.Keys.Any(k => k is not ("action" or "projectId" or "arguments"))) throw new ProcessingException("TOOL_INPUT_INVALID");
            if (!input.TryGetValue("action", out var value) || value.ValueKind != JsonValueKind.String || !actions.Contains(value.GetString(), StringComparer.Ordinal)) throw new ProcessingException("ACTION_UNSUPPORTED");
            if (input.Any(p => p.Value.ValueKind != JsonValueKind.String)) throw new ProcessingException("TOOL_INPUT_INVALID");
            var action = value.GetString()!;
            var project = input.TryGetValue("projectId", out value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            var text = input.TryGetValue("arguments", out value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : "{}";
            if (text.Length > 4194304 || Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(text)) is not JsonObject args) throw new ProcessingException("ARGUMENTS_OBJECT_REQUIRED");
            if (Mutation(name, action, args) && !allowDraftWrites) throw new ProcessingException("DRAFT_WRITES_DISABLED");
            var result = await Execute(name, action, project, args, ModelActor.Service, cancellation);
            envelope = new JsonObject { ["success"] = true, ["result"] = result, ["error"] = null };
        } catch (ProcessingException error) { envelope = new JsonObject { ["success"] = false, ["result"] = null, ["error"] = error.Code }; }
        catch { envelope = new JsonObject { ["success"] = false, ["result"] = null, ["error"] = "MODELLING_OPERATION_FAILED" }; }
        return new CallToolResult { IsError = envelope["success"]?.GetValue<bool>() != true, StructuredContent = JsonSerializer.SerializeToElement(envelope), Content = [new TextContentBlock { Text = envelope.ToJsonString() }] };
    }
}
