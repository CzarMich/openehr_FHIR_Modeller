using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Xml;
using System.Xml.Linq;

namespace Modeller.Core;

public sealed class Validation(Configuration config, JobRequest job, ModelContext models) : IDisposable
{
    private readonly HttpClient http = Network.Client(TimeSpan.FromSeconds(650));
    public void Dispose() => http.Dispose();
    public static void RequireFhirCompleted(JsonObject report, bool requireTerminology) {
        if (report["status"]?.GetValue<string>() is not ("valid" or "invalid") || report["evidence"]?["executed"]?.GetValue<bool>() != true
            || report["evidence"]?["timedOut"]?.GetValue<bool>() == true || report["evidence"]?["oversized"]?.GetValue<bool>() == true || report["outcome"] is not JsonObject)
            throw new ProcessingException("FHIR_VALIDATION_NOT_EXECUTED");
        var terminology = report["terminology"]?["status"]?.GetValue<string>();
        if (terminology is not ("valid" or "failed" or "not-run") || requireTerminology && terminology == "not-run") throw new ProcessingException("FHIR_TERMINOLOGY_NOT_EXECUTED");
        if (terminology == "failed" && report["valid"]?.GetValue<bool>() == true) throw new ProcessingException("FHIR_VALIDATION_EVIDENCE_INCONSISTENT");
    }
    public async Task<JsonObject> Composition(JsonObject composition, string evidenceFile, CancellationToken cancellation) {
        var templates = ((JsonArray)models.Selection["items"]!).OfType<JsonObject>().Where(i => i["pin"]?["standard"]?.GetValue<string>() == "openEHR").ToArray();
        if (templates.Length != 1) throw new ProcessingException("EXACT_COMPOSITION_TEMPLATE_REQUIRED");
        var template = templates[0]; var content = template["content"]!.GetValue<string>();
        using var reader = XmlReader.Create(new StringReader(content), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4194304 });
        var xml = XDocument.Load(reader);
        var identifiers = xml.Root?.Elements().Where(e => e.Name.LocalName == "template_id").SelectMany(e => e.Elements().Where(v => v.Name.LocalName == "value")).Select(e => e.Value).ToArray();
        if (identifiers?.Length != 1) throw new ProcessingException("COMPILED_OPT_1_4_REQUIRED");
        var dependency = new { identifier = identifiers[0], content, sha256 = Data.Hash(content) };
        if (dependency.sha256 != template["pin"]?["sha256"]?.GetValue<string>()) throw new ProcessingException("TEMPLATE_HASH_MISMATCH");
        using var request = new HttpRequestMessage(HttpMethod.Post, config.NativeUrl.TrimEnd('/') + "/v1/validate/composition") { Content = JsonContent.Create(new { content = composition.ToJsonString(), dependencies = new[] { dependency } }) };
        request.Headers.Add("X-Engine-Key", Network.Key(config.NativeKeyFile));
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        if (!response.IsSuccessStatusCode) throw new ProcessingException("OPENEHR_VALIDATION_UNAVAILABLE");
        var result = await Network.Object(response, cancellation); Data.Write(evidenceFile, result);
        if (result["template_sha256"]?.GetValue<string>() != dependency.sha256) throw new ProcessingException("OPENEHR_VALIDATION_PIN_MISMATCH");
        if (result["status"]?.GetValue<string>() != "PASS" || result["valid"]?.GetValue<bool>() != true) throw new ProcessingException("RECORD_OPENEHR_VALIDATION");
        if (config.RequireTerminology && result["terminology"]?.GetValue<string>() == "EXTERNAL_NOT_EXECUTED") throw new ProcessingException("OPENEHR_TERMINOLOGY_NOT_EXECUTED");
        return result;
    }
    public async Task Profiles(string evidenceDirectory, CancellationToken cancellation) {
        var profiles = new JsonArray(((JsonArray)models.Selection["items"]!).OfType<JsonObject>()
            .Where(item => item["pin"]?["standard"]?.GetValue<string>() == "FHIR")
            .Select(item => JsonNode.Parse(item["content"]!.GetValue<string>())).ToArray());
        for (var index = 0; index < profiles.Count; index++) {
            using var request = new HttpRequestMessage(HttpMethod.Post, config.FhirUrl.TrimEnd('/') + "/execute") {
                Content = JsonContent.Create(new { operation = "artifact.validate", tenant = job.Owner, parameters = new { project = models.Project, content = profiles[index], profiles } })
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Network.Key(config.FhirKeyFile));
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if (!response.IsSuccessStatusCode) throw new ProcessingException("FHIR_MODEL_VALIDATION_UNAVAILABLE");
            var result = await Network.Object(response, cancellation); Data.Write(Path.Combine(evidenceDirectory, index + ".json"), result);
            RequireFhirCompleted(result, config.RequireTerminology);
            if (result["valid"]?.GetValue<bool>() != true || result["success"]?.GetValue<bool>() != true) throw new ProcessingException("MODEL_FHIR_VALIDATION");
        }
    }
    public async Task Fhir(JsonObject resource, string evidencePrefix, CancellationToken cancellation) {
        var type = resource["resourceType"]?.GetValue<string>() ?? throw new ProcessingException("RECORD_FHIR_TYPE_REQUIRED");
        var profiles = new JsonArray(); var targets = new List<JsonObject>();
        foreach (var input in ((JsonArray)models.Selection["items"]!).OfType<JsonObject>().Where(i => i["pin"]?["standard"]?.GetValue<string>() == "FHIR")) {
            var definition = JsonNode.Parse(input["content"]!.GetValue<string>()) as JsonObject ?? throw new ProcessingException("PROFILE_REQUIRED");
            profiles.Add(definition);
            if (definition["type"]?.GetValue<string>() == type) targets.Add(definition);
        }
        if (targets.Count == 0) throw new ProcessingException("EXACT_RESOURCE_PROFILE_REQUIRED");
        for (var i = 0; i < targets.Count; i++) {
            var profile = targets[i];
            var canonical = Data.Required(profile, "url") + (profile["version"]?.GetValue<string>() is { Length: > 0 } businessVersion ? "|" + businessVersion : "");
            using var request = new HttpRequestMessage(HttpMethod.Post, config.FhirUrl.TrimEnd('/') + "/execute") {
                Content = JsonContent.Create(new { operation = "artifact.validate", tenant = job.Owner, parameters = new { project = models.Project, content = resource, profiles, profile = canonical } })
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Network.Key(config.FhirKeyFile));
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if (!response.IsSuccessStatusCode) throw new ProcessingException("FHIR_VALIDATION_UNAVAILABLE");
            var result = await Network.Object(response, cancellation); Data.Write(evidencePrefix + "-" + i + ".json", result);
            RequireFhirCompleted(result, config.RequireTerminology);
            if (result["valid"]?.GetValue<bool>() != true || result["success"]?.GetValue<bool>() != true) throw new ProcessingException("RECORD_FHIR_VALIDATION");
        }
    }
}
