using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
namespace Modeller.Core;

public sealed partial class ModelStore
{
    private JsonObject ReuseContext(JsonObject input, string schemaHash, JsonArray requirements)
    {
        Data.Keys(input, "sourceSystem", "sourceSemanticsVersion", "purpose", "terminologyPins");
        if (!Regex.IsMatch(schemaHash, "^[a-f0-9]{64}$")) throw new ProcessingException("REUSE_SCHEMA_HASH_REQUIRED");
        foreach (var key in new[] { "sourceSystem", "sourceSemanticsVersion", "purpose" }) {
            var value = Data.Required(input, key);
            if (string.IsNullOrWhiteSpace(value) || value.Length > (key == "purpose" ? 500 : 100) || value.Any(char.IsControl)) throw new ProcessingException("REUSE_CONTEXT_REQUIRED");
        }
        if (requirements.Count is < 1 or > 100 || requirements.ToJsonString().Length > 65536) throw new ProcessingException("REUSE_REQUIREMENTS_REQUIRED");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in requirements) {
            var requirement = item as JsonObject ?? throw new ProcessingException("REUSE_REQUIREMENTS_REQUIRED");
            Data.Keys(requirement, "id", "originalText", "basis");
            if (!ids.Add(Data.Required(requirement, "id")) || string.IsNullOrWhiteSpace(Data.Required(requirement, "originalText")) || requirement["basis"]?.GetValue<string>() is not ("user-instruction" or "declared-fact" or "inferred-proposal")) throw new ProcessingException("REUSE_REQUIREMENTS_REQUIRED");
        }
        var pins = input["terminologyPins"] as JsonArray ?? throw new ProcessingException("REUSE_TERMINOLOGY_PINS_REQUIRED");
        if (pins.Count > 100) throw new ProcessingException("REUSE_TERMINOLOGY_PIN_LIMIT");
        var canonicalPins = new SortedDictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var item in pins) {
            var pin = item as JsonObject ?? throw new ProcessingException("REUSE_TERMINOLOGY_PIN_INVALID");
            Data.Keys(pin, "canonical", "version", "sha256");
            var canonical = Data.Required(pin, "canonical"); Canonical(canonical);
            var version = Data.Required(pin, "version");
            if (version.Length > 100 || string.IsNullOrWhiteSpace(version) || version.Any(char.IsControl) || !Regex.IsMatch(Data.Required(pin, "sha256"), "^[a-f0-9]{64}$") || !canonicalPins.TryAdd(canonical + "\n" + version, (JsonObject)pin.DeepClone())) throw new ProcessingException("REUSE_TERMINOLOGY_PIN_INVALID");
        }
        return new JsonObject {
            ["schemaVersion"] = 1, ["sourceSystem"] = input["sourceSystem"]!.DeepClone(), ["sourceSemanticsVersion"] = input["sourceSemanticsVersion"]!.DeepClone(), ["purpose"] = input["purpose"]!.DeepClone(),
            ["sourceSchemaSha256"] = schemaHash, ["requirementsSha256"] = Data.Hash(Data.Canonical(new JsonArray(requirements.OfType<JsonObject>().Select(requirement => (JsonNode)new JsonObject { ["originalText"] = requirement["originalText"]!.DeepClone(), ["basis"] = requirement["basis"]!.DeepClone() }).ToArray()))), ["runtimeSha256"] = runtimeFingerprint.Value,
            ["terminologyPins"] = new JsonArray(canonicalPins.Values.Select(pin => (JsonNode)pin).ToArray())
        };
    }
    /// <summary>Find existing exact-context work without a provider call or a new approval.</summary>
    public JsonObject Reuse(string projectId, JsonObject input, ModelActor actor)
    {
        _ = GetProject(projectId, actor);
        Data.Keys(input, "context", "sourceSchemaSha256", "requirements", "modelKeys", "direction", "count");
        var context = ReuseContext(input["context"] as JsonObject ?? throw new ProcessingException("REUSE_CONTEXT_REQUIRED"), Data.Required(input, "sourceSchemaSha256"), input["requirements"] as JsonArray ?? throw new ProcessingException("REUSE_REQUIREMENTS_REQUIRED"));
        var selected = input["modelKeys"] as JsonArray ?? throw new ProcessingException("MODELS_REQUIRED");
        if (selected.Count is < 1 or > 20 || selected.Any(item => item?.GetValueKind() != System.Text.Json.JsonValueKind.String)) throw new ProcessingException("MODELS_REQUIRED");
        var keys = selected.Select(item => item!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray();
        if (keys.Distinct(StringComparer.Ordinal).Count() != keys.Length) throw new ProcessingException("DUPLICATE_MODEL");
        foreach (var key in keys) if (GetModel(key, actor)["projectId"]?.GetValue<string>() != projectId) throw new ProcessingException("MODEL_PROJECT_MISMATCH");
        var direction = Data.Required(input, "direction");
        if (direction is not ("source-direct-to-fhir" or "fhir-to-openehr" or "source-to-openehr" or "openehr-to-fhir")) throw new ProcessingException("MAPPING_SCOPE_REQUIRED");
        var limit = input["count"]?.GetValue<int>() ?? 10;
        if (limit is < 1 or > 50) throw new ProcessingException("REUSE_COUNT_INVALID");
        var expected = Data.Canonical(context); var selectedKeys = Data.Canonical(new JsonArray(keys.Select(key => (JsonNode)JsonValue.Create(key)!).ToArray()));
        var items = new JsonArray(); long bytes = 0; var complete = true; var scanned = 0;
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "definitions"), "*.json").Order(StringComparer.Ordinal)) {
            if (++scanned > 2000 || (bytes += new FileInfo(file).Length) > 16 * 1048576 || items.Count >= limit) { complete = false; break; }
            var definition = Read("definitions", Path.GetFileNameWithoutExtension(file));
            if (definition["project"]?.GetValue<string>() != projectId || definition["direction"]?.GetValue<string>() != direction || Data.Canonical(definition["reuseContext"]) != expected || Data.Canonical(definition["modelKeys"]) != selectedKeys) continue;
            // Verify exact models, immutable identity and the current protected decision chain on every match.
            var view = GetDefinition(Data.Required(definition, "subject"), actor);
            var mapping = new Mapping(Data.Required(view, "executionMapping"));
            if (view["mappingConfirmed"]?.GetValue<bool>() == true) mapping.VerifyExamples();
            var specification = Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(Data.Required(view, "executionMapping"))) as JsonObject ?? throw new ProcessingException("MAPPING_INVALID");
            var confirmed = view["mappingConfirmed"]?.GetValue<bool>() == true;
            items.Add(new JsonObject { ["subject"] = view["subject"]!.DeepClone(), ["name"] = specification["name"]!.DeepClone(), ["version"] = specification["version"]!.DeepClone(), ["mappingSha256"] = view["mappingSha256"]!.DeepClone(), ["state"] = view["state"]!.DeepClone(), ["sequence"] = view["sequence"]!.DeepClone(), ["eligibleForReuse"] = confirmed, ["reason"] = confirmed ? "EXACT_CONTEXT_AND_CURRENT_HUMAN_CONFIRMATION" : "CURRENT_HUMAN_CONFIRMATION_REQUIRED" });
        }
        return new JsonObject { ["items"] = items, ["complete"] = complete, ["contextSha256"] = Data.Hash(expected), ["providerCalls"] = 0, ["automaticExecution"] = false, ["clinicalApproval"] = false, ["scope"] = "Same authorised project, declared source semantics/purpose, exact schema, models, requirements, terminology pins and runtime. Existing confirmation is rechecked; normal source validation and delivery authorisation still apply." };
    }
}
