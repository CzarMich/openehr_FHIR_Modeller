using System.Text.Json.Nodes;
using Modeller.Core;

static class MappingReuseTests
{
    public static void Run(ModelStore store, ModelActor actor, JsonObject model, JsonObject originalMapping, Action<bool, string> check)
    {
        var mapping = (JsonObject)originalMapping.DeepClone(); mapping["name"] = "reusable-synthetic-lab";
        var context = new JsonObject { ["sourceSystem"] = "synthetic-lab-source", ["sourceSemanticsVersion"] = "dictionary-1", ["purpose"] = "Synthetic laboratory observation transformation", ["terminologyPins"] = new JsonArray() };
        var request = new JsonObject { ["modelKeys"] = new JsonArray(model["key"]!.DeepClone()), ["executionMapping"] = mapping.ToJsonString(), ["reuseContext"] = context.DeepClone() };
        var definition = store.Prepare("synthetic", request, ModelActor.Service); var subject = definition["subject"]!.GetValue<string>();
        JsonObject Query() => new() { ["context"] = context.DeepClone(), ["sourceSchemaSha256"] = mapping["sourceSchemaSha256"]!.DeepClone(), ["requirements"] = mapping["requirements"]!.DeepClone(), ["modelKeys"] = request["modelKeys"]!.DeepClone(), ["direction"] = mapping["direction"]!.DeepClone() };
        JsonObject Find(JsonObject? query = null) => store.Reuse("synthetic", query ?? Query(), ModelActor.Service);
        var pending = Find();
        check(((JsonArray)pending["items"]!).Count == 1 && pending["items"]![0]!["eligibleForReuse"]!.GetValue<bool>() == false, "existing exact-context draft is found without inventing approval");
        store.Decide(subject, 0, "CONFIRMED", "Inspected the actual model, rules and declared reuse context", actor);
        var confirmed = Find();
        check(confirmed["providerCalls"]!.GetValue<int>() == 0 && confirmed["automaticExecution"]!.GetValue<bool>() == false && confirmed["clinicalApproval"]!.GetValue<bool>() == false && confirmed["items"]![0]!["eligibleForReuse"]!.GetValue<bool>(), "exact approved work can be reused without a model-provider call or implicit delivery");
        check(store.Prepare("synthetic", request, ModelActor.Service)["subject"]!.GetValue<string>() == subject, "re-providing unchanged work preserves the exact confirmed mapping identity");
        var labels = Query(); labels["requirements"]![0]!["id"] = "DIFFERENT-LABEL";
        check(((JsonArray)Find(labels)["items"]!).Count == 1, "requirement labels alone do not require regeneration when original text and basis are unchanged");
        foreach (var field in new[] { "sourceSystem", "sourceSemanticsVersion", "purpose" }) {
            var changed = Query(); changed["context"]![field] = "different-synthetic-context";
            check(((JsonArray)Find(changed)["items"]!).Count == 0, "reuse invalidated by changed " + field);
        }
        var narrative = Query(); narrative["requirements"]![0]!["originalText"] = "A different original user instruction";
        check(((JsonArray)Find(narrative)["items"]!).Count == 0, "changed user narrative cannot silently inherit previous rules or confirmation");
        var schema = Query(); schema["sourceSchemaSha256"] = new string('0', 64);
        check(((JsonArray)Find(schema)["items"]!).Count == 0, "changed source schema invalidates reuse");
        var terms = Query(); terms["context"]!["terminologyPins"] = new JsonArray(new JsonObject { ["canonical"] = "https://example.invalid/valueset", ["version"] = "1", ["sha256"] = new string('1', 64) });
        check(((JsonArray)Find(terms)["items"]!).Count == 0, "changed terminology snapshots invalidate reuse");
        var profileInput = new JsonObject { ["id"] = "another-profile", ["standard"] = "FHIR", ["version"] = "1.0.0", ["origin"] = "externally-provided", ["content"] = "{\"resourceType\":\"StructureDefinition\",\"url\":\"https://example.invalid/another-profile\",\"version\":\"1.0.0\",\"type\":\"Observation\",\"fhirVersion\":\"4.0.1\"}", ["provenance"] = new JsonObject { ["source"] = "Synthetic fixture" } };
        var another = store.ProvideModel("synthetic", profileInput, actor); var target = Query(); target["modelKeys"] = new JsonArray(another["key"]!.DeepClone());
        check(((JsonArray)Find(target)["items"]!).Count == 0, "different provided FHIR model cannot reuse the old approval");
        store.Decide(subject, 1, "REVOKED", "Withdraw reuse confirmation", actor);
        check(Find()["items"]![0]!["eligibleForReuse"]!.GetValue<bool>() == false, "revocation is checked live rather than cached as approval");
        var restricted = new ModelActor("other", new string('d', 64), true, ["modelling-modeller"], ["project:elsewhere:read"]);
        try { store.Reuse("synthetic", Query(), restricted); throw new Exception("Reuse bypassed project rights"); }
        catch (ProcessingException error) { check(error.Code == "PROJECT_PERMISSION_REQUIRED", "reuse retains current project access checks"); }
    }
}
