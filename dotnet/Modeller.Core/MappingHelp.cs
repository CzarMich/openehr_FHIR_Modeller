using System.Text.Json.Nodes;
namespace Modeller.Core;
public static class MappingHelp
{
    public static JsonObject Document() {
        using var stream = typeof(MappingHelp).Assembly.GetManifestResourceStream("Modeller.Core.mapping-v2.example.json") ?? throw new ProcessingException("MAPPING_HELP_UNAVAILABLE");
        using var reader = new StreamReader(stream);
        return new JsonObject {
            ["schemaVersion"] = 2, ["kind"] = "executable-synthetic-example-and-guidance",
            ["example"] = JsonNode.Parse(reader.ReadToEnd()),
            ["operations"] = new JsonArray("copy", "number", "translate", "constant", "datetime-utc", "identifier", "reference"),
            ["directions"] = new JsonObject { ["source-direct-to-fhir"] = "One stage; select actual FHIR SDs", ["source-to-fhir"] = "Two stages; select FHIR SDs and one compiled OPT 1.4", ["fhir-to-openehr"] = "One explicit reverse stage; select input FHIR SDs and one compiled OPT 1.4" },
            ["guidance"] = "Use source_inspect metadata to pin the source schema. requirements preserve originalText, id and basis. Every rule requires description, interpretation, assumptions and missing/null policies. Rules use explicit JSON Pointer indices; * is a schema marker only. number uses factor and offset; translate needs a dictionary; identifier/reference require namespace; constant needs value. condition has source and exactly one of equals/exists. A stage may explode an array into parent/item/index; groupBy creates _group/key and _group/records. Unresolved questions and failed synthetic examples block confirmation. Never put real records in this example or the model registry. Actual provided models and a separate human confirmation are required before operational execution."
        };
    }
}
