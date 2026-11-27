using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class FhirTerminologyTests
{
    public static void Run(Action<bool, string> check)
    {
        JsonObject Part(string name, string type, JsonNode? value) => new() { ["name"] = name, ["value" + type] = value };
        JsonObject Parameters(params JsonNode[] items) => new() { ["resourceType"] = "Parameters", ["parameter"] = new JsonArray(items) };
        void Reject(Action action, string code) { try { action(); throw new Exception("Expected terminology failure: " + code); } catch (ProcessingException e) { check(e.Code == code, "terminology rejects " + code); } }
        var lookup = Parameters(Part("display", "String", JsonValue.Create("Synthetic")), Part("version", "String", JsonValue.Create("1")), new JsonObject { ["name"] = "designation", ["part"] = new JsonArray(Part("language", "Code", JsonValue.Create("de")), Part("value", "String", JsonValue.Create("Beispiel"))) }, new JsonObject { ["name"] = "designation", ["part"] = new JsonArray(Part("language", "Code", JsonValue.Create("en")), Part("value", "String", JsonValue.Create("Example"))) });
        var result = FhirTerminology.Parse("lookup", "CodeSystem/$lookup", new Dictionary<string, string> { ["version"] = "1" }, lookup);
        check(result["version_confirmed"]!.GetValue<bool>() && ((JsonArray)result["result"]!["designation"]!).Count == 2, "terminology repeated multilingual designations and version evidence preserved");
        Reject(() => FhirTerminology.Parse("lookup", "CodeSystem/$lookup", new Dictionary<string, string> { ["version"] = "2" }, lookup), "TERMINOLOGY_VERSION_MISMATCH");
        var duplicate = (JsonObject)lookup.DeepClone(); ((JsonArray)duplicate["parameter"]!).Add(Part("display", "String", JsonValue.Create("Ambiguous")));
        Reject(() => FhirTerminology.Parse("lookup", "CodeSystem/$lookup", new Dictionary<string, string>(), duplicate), "TERMINOLOGY_INVALID_RESPONSE");
        var negative = FhirTerminology.Parse("validate-system", "CodeSystem/$validate-code", new Dictionary<string, string>(), Parameters(Part("result", "Boolean", JsonValue.Create(false))));
        check(negative["valid"]!.GetValue<bool>() == false, "negative terminology membership is not treated as unavailable or positive");
        var missing = FhirTerminology.Parse("validate-system", "CodeSystem/$validate-code", new Dictionary<string, string> { ["version"] = "1" }, Parameters(Part("result", "Boolean", JsonValue.Create(true))));
        check(missing["version_confirmed"]!.GetValue<bool>() == false && ((JsonArray)missing["warnings"]!).Count == 1, "missing version evidence is never inferred from a successful code response");
        Reject(() => FhirTerminology.Parse("validate-system", "CodeSystem/$validate-code", new Dictionary<string, string>(), Parameters()), "TERMINOLOGY_MISSING_RESULT");
        var expansion = new JsonObject { ["resourceType"] = "ValueSet", ["url"] = "https://example.org/set", ["version"] = "1", ["expansion"] = new JsonObject { ["total"] = 2, ["offset"] = 0, ["contains"] = new JsonArray(new JsonObject { ["system"] = "https://example.org/system", ["code"] = "x" }) } };
        var query = new Dictionary<string, string> { ["url"] = "https://example.org/set", ["valueSetVersion"] = "1", ["offset"] = "0", ["count"] = "1" };
        var page = FhirTerminology.Parse("expand", "ValueSet/$expand", query, expansion);
        check(page["page"]!["complete"]!.GetValue<bool>() == false && page["page"]!["has_more"]!.GetValue<bool>(), "an expansion page is not presented as the entire value set");
        var sizeOnly = (JsonObject)expansion.DeepClone(); sizeOnly["expansion"]!["contains"] = new JsonArray();
        var sizeQuery = new Dictionary<string, string>(query) { ["count"] = "0" };
        check(FhirTerminology.Parse("expand", "ValueSet/$expand", sizeQuery, sizeOnly)["page"]!["complete"]!.GetValue<bool>() == false, "size-only expansion retains incompleteness");
        var hierarchical = (JsonObject)expansion.DeepClone(); hierarchical["expansion"]!["contains"]![0]!["contains"] = new JsonArray(new JsonObject { ["code"] = "child" });
        check(FhirTerminology.Parse("expand", "ValueSet/$expand", query, hierarchical)["page"]!["page_confirmed"]!.GetValue<bool>() == false, "hierarchical expansion cannot certify flat paging");
        var translated = Parameters(Part("result", "Boolean", JsonValue.Create(true)), new JsonObject { ["name"] = "match", ["part"] = new JsonArray(Part("equivalence", "Code", JsonValue.Create("equivalent")), Part("concept", "Coding", new JsonObject { ["system"] = "https://example.org/target", ["code"] = "y" })) });
        var translation = FhirTerminology.Parse("translate", "ConceptMap/$translate", new Dictionary<string, string> { ["conceptMapVersion"] = "1" }, translated);
        check(translation["mapping_found"]!.GetValue<bool>() && translation["requires_review"]!.GetValue<bool>() && translation["applied"]!.GetValue<bool>() == false && translation["valid"] is null && translation["version_confirmed"]!.GetValue<bool>() == false, "translation proposals remain separate from validation, version confirmation and application");
        Reject(() => FhirTerminology.Parse("translate", "ConceptMap/$translate", new Dictionary<string, string> { ["targetsystem"] = "https://example.org/another-target" }, translated), "TERMINOLOGY_INVALID_RESPONSE");
        var search = new JsonObject { ["resourceType"] = "Bundle", ["type"] = "searchset", ["total"] = 1, ["entry"] = new JsonArray(new JsonObject { ["resource"] = new JsonObject { ["resourceType"] = "ValueSet", ["url"] = "https://example.org/set", ["version"] = "1" } }), ["link"] = new JsonArray(new JsonObject { ["relation"] = "next", ["url"] = "https://unrequested.example/next" }) };
        check(FhirTerminology.Parse("search", "ValueSet", new Dictionary<string, string> { ["_count"] = "2" }, search)["complete"]!.GetValue<bool>() == false, "search next-page references are reported without being followed");
    }
}
