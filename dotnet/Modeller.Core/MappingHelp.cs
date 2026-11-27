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
            ["clinicalExecution"] = new JsonObject {
                ["required"] = "Private clinical jobs require sourceProfileKey selecting one supplied source-contract model and a clinicalPolicy selecting the stable identityDomain, destinationId and exact privacyPolicyRevision. Confirm these with the executable mapping. Examples below illustrate transformation rules only.",
                ["patientPrerequisite"] = "A verified source patient identity is mandatory in every privacy mode. Authoritative registration requires both the source contract declaration and separate human-reviewed trust of the exact source configuration. Never infer patient identity from demographics or create placeholders.",
                ["references"] = "clinicalPolicy.references contains role, targetType, JSON Pointer path, mode (logical/literal/resolve-literal) and requireDestination. patient names the registered patient; other roles must exist in source-contract relations. Logical references do not establish destination existence.",
                ["privacy"] = "Load and human-review destination settings in the browser. Pin revision, pseudonymisePatientIdentifiers and pseudonymSystem in clinicalPolicy. A setting change requires a new confirmed mapping. Do not generate or cache patient crosswalks in model context.",
                ["retiredDirection"] = "source-to-fhir formerly meant a combined two-stage route. It is rejected; use a new independent source-direct-to-fhir definition and obtain human confirmation."
            },
            ["directions"] = new JsonObject { ["source-direct-to-fhir"] = "One stage; select actual FHIR SDs", ["fhir-to-openehr"] = "One explicit reverse stage; select input FHIR SDs and one compiled OPT 1.4", ["source-to-openehr"] = "One stage; select one exact compiled OPT 1.4; private composition export", ["openehr-to-fhir"] = "One stage; validate canonical source compositions against one exact compiled OPT 1.4 and outputs against supplied FHIR SDs" },
            ["guidance"] = "Use source_inspect metadata to pin the source schema. requirements preserve originalText, id and basis. Every rule requires description, interpretation, assumptions and missing/null policies. Rules use explicit JSON Pointer indices; * is a schema marker only. number uses factor and offset; translate needs a dictionary; identifier/reference require namespace; constant needs value. condition has source and exactly one of equals/exists. A stage may explode an array into parent/item/index; groupBy creates _group/key and _group/records. Unresolved questions and failed synthetic examples block confirmation. Never put real records in this example or the model registry. Actual provided models and a separate human confirmation are required before operational execution."
        };
    }
}
