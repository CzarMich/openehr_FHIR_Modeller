using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Application;

/// <summary>FHIR R4 terminology operations against one operator-configured server.</summary>
public sealed class FhirTerminology(RemoteDefinitions remote)
{
    private static string S(JsonObject obj, string key) => KnowledgeCorpus.Text(obj, key);
    private static ProcessingException Invalid() => new("TERMINOLOGY_INVALID_RESPONSE");
    public async Task<JsonObject> Execute(string name, JsonObject args, CancellationToken cancellation)
    {
        var root = Environment.GetEnvironmentVariable("TERMINOLOGY_FHIR_BASE_URL") ?? "";
        var path = "metadata"; var kind = "metadata";
        var query = new Dictionary<string, string>(StringComparer.Ordinal);
        void Add(string parameter, string argument) { if (args[argument] is not null) query[parameter] = Data.Required(args, argument); }
        switch (name) {
            case "terminology_lookup": path = "CodeSystem/$lookup"; kind = "lookup"; Add("system", "system"); Add("code", "code"); Add("version", "version"); Add("displayLanguage", "language"); break;
            case "terminology_validate_code":
                Add("code", "code"); Add("display", "display"); Add("displayLanguage", "language");
                if (args["valueSet"] is not null) { path = "ValueSet/$validate-code"; kind = "validate-set"; Add("url", "valueSet"); Add("system", "system"); Add("valueSetVersion", "version"); Add("systemVersion", "codeSystemVersion"); }
                else {
                    path = "CodeSystem/$validate-code"; kind = "validate-system";
                    var parameter = Environment.GetEnvironmentVariable("TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER") ?? "url";
                    if (parameter is not ("url" or "system")) throw new ProcessingException("TERMINOLOGY_CONFIGURATION_INVALID");
                    if (args["version"] is not null && args["codeSystemVersion"] is not null && S(args, "version") != S(args, "codeSystemVersion")) throw new ProcessingException("TERMINOLOGY_VERSION_CONFLICT");
                    Add(parameter, "system"); Add("version", args["version"] is not null ? "version" : "codeSystemVersion");
                }
                break;
            case "terminology_expand":
                path = "ValueSet/$expand"; kind = "expand"; Add("url", "valueSet"); Add("valueSetVersion", "version"); Add("displayLanguage", "language"); Add("filter", "filter");
                var count = KnowledgeCorpus.Number(args, "count", 50); var offset = KnowledgeCorpus.Number(args, "offset", 0);
                if (count is < 0 or > 500 || offset is < 0 or > 1000000) throw new ProcessingException("TERMINOLOGY_PAGE_INVALID");
                query["count"] = count.ToString(System.Globalization.CultureInfo.InvariantCulture); query["offset"] = offset.ToString(System.Globalization.CultureInfo.InvariantCulture); query["includeDesignations"] = "true"; query["excludeNested"] = "true"; break;
            case "terminology_translate":
                path = "ConceptMap/$translate"; kind = "translate"; Add("url", "conceptMap"); Add("conceptMapVersion", "version"); Add("system", "system"); Add("code", "code"); Add("version", "codeSystemVersion"); Add("source", "sourceValueSet"); Add("target", "targetValueSet"); Add("targetsystem", "targetSystem"); break;
            case "terminology_resource_search": case "terminology_resource_get":
                path = Data.Required(args, "resourceType"); kind = "search";
                if (path is not ("CodeSystem" or "ValueSet" or "ConceptMap")) throw new ProcessingException("TERMINOLOGY_RESOURCE_TYPE_INVALID");
                Add("url", "canonical"); Add("version", "version"); Add("name", "name");
                var limit = name == "terminology_resource_get" ? 2 : KnowledgeCorpus.Number(args, "count", 50);
                if (limit is < 1 or > 100) throw new ProcessingException("TERMINOLOGY_PAGE_INVALID"); query["_count"] = limit.ToString(System.Globalization.CultureInfo.InvariantCulture); break;
            case "terminology_capabilities": break;
            default: throw new ProcessingException("TERMINOLOGY_OPERATION_UNSUPPORTED");
        }
        foreach (var parameter in query.Values) if (parameter.Length is < 1 or > 2048 || parameter.Any(char.IsControl)) throw new ProcessingException("TERMINOLOGY_PARAMETER_INVALID");
        var provenance = new JsonObject { ["provider"] = "fhir", ["endpoint"] = root, ["operation"] = path, ["timestamp"] = DateTimeOffset.UtcNow.ToString("O") };
        JsonObject Failure(string code) => new() { ["status"] = "NOT_EXECUTED", ["valid"] = null, ["errors"] = new JsonArray(code), ["message"] = "TERMINOLOGY OPERATION NOT EXECUTED", ["provenance"] = provenance.DeepClone() };
        if (root.Length == 0) return Failure("TERMINOLOGY_NOT_CONFIGURED");
        var headers = new Dictionary<string, string> { ["Accept"] = "application/fhir+json" };
        var token = Environment.GetEnvironmentVariable("TERMINOLOGY_BEARER_TOKEN"); var key = Environment.GetEnvironmentVariable("TERMINOLOGY_API_KEY");
        if (!string.IsNullOrEmpty(token) && !string.IsNullOrEmpty(key)) throw new ProcessingException("TERMINOLOGY_CONFIGURATION_INVALID");
        if (!string.IsNullOrEmpty(token)) headers["Authorization"] = "Bearer " + token;
        if (!string.IsNullOrEmpty(key)) {
            var header = Environment.GetEnvironmentVariable("TERMINOLOGY_API_KEY_HEADER") ?? "X-API-Key";
            if (!System.Text.RegularExpressions.Regex.IsMatch(header, "^[A-Za-z][A-Za-z0-9-]{0,99}$") || new[] { "host", "cookie", "authorization", "origin", "forwarded", "content-length", "connection" }.Contains(header.ToLowerInvariant())) throw new ProcessingException("TERMINOLOGY_CONFIGURATION_INVALID");
            headers[header] = key;
        }
        try {
            var reply = await remote.Send(root, path + (query.Count == 0 ? "" : "?" + string.Join("&", query.Select(p => Uri.EscapeDataString(p.Key) + "=" + Uri.EscapeDataString(p.Value)))), HttpMethod.Get, null, headers, cancellation);
            var data = Data.ParseStrict(Encoding.UTF8.GetBytes(reply.Body)) as JsonObject ?? throw Invalid();
            var result = Parse(kind, path, query, data); result["provenance"] = provenance.DeepClone();
            if (name == "terminology_resource_get") {
                var items = (JsonArray)result["items"]!;
                if (items.Count != 1 || result["complete"]?.GetValue<bool>() != true) return Failure(items.Count == 0 && result["complete"]?.GetValue<bool>() == true ? "TERMINOLOGY_RESOURCE_NOT_FOUND" : "TERMINOLOGY_RESOURCE_AMBIGUOUS_OR_INCOMPLETE");
                var resource = (JsonObject)items[0]!; var requested = args["version"]?.GetValue<string>();
                return new JsonObject { ["status"] = "VALIDATED", ["valid"] = null, ["result"] = resource.DeepClone(), ["requested_version"] = requested, ["returned_version"] = resource["version"]?.DeepClone(), ["version_confirmed"] = requested is not null && requested == resource["version"]?.GetValue<string>(), ["provenance"] = provenance, ["errors"] = new JsonArray(), ["warnings"] = new JsonArray() };
            }
            return result;
        } catch (ProcessingException e) { return Failure(e.Code.StartsWith("TERMINOLOGY_", StringComparison.Ordinal) ? e.Code : "TERMINOLOGY_UNAVAILABLE_OR_INVALID"); }
        catch (Exception e) when (e is System.Text.Json.JsonException or InvalidOperationException or FormatException or HttpRequestException) { return Failure("TERMINOLOGY_INVALID_RESPONSE"); }
    }

    public static JsonObject Parse(string kind, string path, IReadOnlyDictionary<string, string> query, JsonObject data)
    {
        string? Q(string name) => query.GetValueOrDefault(name);
        var expected = kind switch { "search" => "Bundle", "expand" => "ValueSet", "metadata" => "CapabilityStatement", _ => "Parameters" };
        if (S(data, "resourceType") != expected) throw Invalid();
        if (kind == "search") {
            if (S(data, "type") != "searchset") throw Invalid();
            var items = new JsonArray(); var entries = data["entry"] as JsonArray ?? (data["entry"] is null ? new JsonArray() : throw Invalid());
            foreach (var node in entries) {
                var entry = node as JsonObject ?? throw Invalid(); var mode = entry["search"]?["mode"]?.GetValue<string>() ?? "match";
                if (mode == "include") continue;
                if (mode != "match" || entry["resource"] is not JsonObject resource || S(resource, "resourceType") != path || S(resource, "url").Length == 0) throw Invalid();
                if (Q("url") is { } canonical && canonical != S(resource, "url")) throw new ProcessingException("TERMINOLOGY_CANONICAL_MISMATCH");
                if (Q("version") is { } version && version != S(resource, "version")) throw new ProcessingException("TERMINOLOGY_VERSION_MISMATCH");
                items.Add(resource.DeepClone());
            }
            if (items.Count > int.Parse(query["_count"], System.Globalization.CultureInfo.InvariantCulture)) throw Invalid();
            var links = data["link"] as JsonArray ?? (data["link"] is null ? new JsonArray() : throw Invalid());
            var next = links.OfType<JsonObject>().Any(link => S(link, "relation") == "next");
            var total = data["total"]?.GetValue<int>(); if (total < items.Count) throw Invalid();
            return new JsonObject { ["status"] = "VALIDATED", ["valid"] = null, ["items"] = items, ["total"] = total, ["complete"] = !next && total == items.Count, ["has_next_page"] = next, ["errors"] = new JsonArray(), ["warnings"] = next ? new JsonArray("Additional search results were not fetched.") : new JsonArray() };
        }
        var parameters = new Parameters(data["parameter"] as JsonArray ?? (data["parameter"] is null ? new JsonArray() : throw Invalid()));
        var validate = kind is "validate-system" or "validate-set";
        var valid = validate || kind == "translate" ? parameters.One("result", "Boolean")?.GetValue<bool>() : (bool?)null;
        if ((validate || kind == "translate") && valid is null) throw new ProcessingException("TERMINOLOGY_MISSING_RESULT");
        if (kind == "lookup" && parameters.One("display", "String")?.GetValueKind() != System.Text.Json.JsonValueKind.String) throw new ProcessingException("TERMINOLOGY_MISSING_DISPLAY");
        var versions = new JsonObject(); var warnings = new JsonArray();
        void Version(string name, string? requested, JsonNode? returned) {
            if (returned is not null && returned.GetValueKind() != System.Text.Json.JsonValueKind.String) throw Invalid();
            var value = returned?.GetValue<string>();
            if (requested is not null && value is not null && requested != value) throw new ProcessingException("TERMINOLOGY_VERSION_MISMATCH");
            versions[name] = new JsonObject { ["requested"] = requested, ["returned"] = value, ["confirmed"] = requested is not null && requested == value };
            if (requested is not null && value is null) warnings.Add("Provider did not confirm the requested " + name + " version.");
        }
        switch (kind) {
            case "expand": Version("value_set", Q("valueSetVersion"), data["version"]); break;
            case "validate-set": Version("value_set", Q("valueSetVersion"), parameters.One("valueSetVersion", "String")); Version("code_system", Q("systemVersion"), parameters.One("systemVersion", "String")); break;
            case "translate": Version("concept_map", Q("conceptMapVersion"), parameters.One("conceptMapVersion", "String")); Version("code_system", Q("version"), parameters.One("systemVersion", "String")); break;
            default: Version("code_system", Q("version"), parameters.One("version", "String")); break;
        }
        var first = (JsonObject)versions.First().Value!;
        var result = new JsonObject { ["status"] = "VALIDATED", ["valid"] = validate ? valid : null, ["result"] = kind is "lookup" or "validate-system" or "validate-set" or "translate" ? parameters.Values() : data.DeepClone(), ["parameters"] = parameters.Items.DeepClone(), ["versions"] = versions, ["requested_version"] = first["requested"]?.DeepClone(), ["returned_version"] = first["returned"]?.DeepClone(), ["version_confirmed"] = first["confirmed"]!.DeepClone(), ["errors"] = new JsonArray(), ["warnings"] = warnings };
        if (kind == "expand") {
            if (data["url"] is not null && S(data, "url") != Q("url")) throw new ProcessingException("TERMINOLOGY_CANONICAL_MISMATCH");
            var page = Expansion(data, int.Parse(query["offset"], System.Globalization.CultureInfo.InvariantCulture), int.Parse(query["count"], System.Globalization.CultureInfo.InvariantCulture));
            page["filtered"] = Q("filter") is not null; page["scope"] = Q("filter") is null ? "expansion" : "filtered_expansion"; result["page"] = page;
        }
        if (kind == "translate") {
            var matches = new JsonArray(); var candidates = new JsonArray();
            foreach (var match in parameters.Named("match")) {
                var parts = new Parameters(match["part"] as JsonArray ?? throw Invalid()); var relation = parts.One("equivalence", "Code")?.GetValue<string>();
                if (!new[] { "relatedto", "equivalent", "equal", "wider", "subsumes", "narrower", "specializes", "inexact", "unmatched", "disjoint" }.Contains(relation)) throw Invalid();
                var coding = parts.One("concept", "Coding") as JsonObject; var positive = relation is not ("unmatched" or "disjoint");
                if ((coding is not null && (S(coding, "system").Length == 0 || S(coding, "code").Length == 0)) || positive && coding is null || positive && Q("targetsystem") is { } target && S(coding!, "system") != target) throw Invalid();
                if (coding is not null) foreach (var field in new[] { "version", "display" }) if (coding[field] is not null && coding[field]!.GetValueKind() != System.Text.Json.JsonValueKind.String) throw Invalid();
                var item = new JsonObject { ["equivalence"] = relation, ["concept"] = coding?.DeepClone(), ["source"] = parts.One("source", "Uri")?.DeepClone(), ["parts"] = match["part"]!.DeepClone(), ["requires_review"] = true };
                matches.Add(item); if (positive) candidates.Add(item.DeepClone());
            }
            if (valid != (candidates.Count > 0)) throw Invalid();
            result["mapping_found"] = valid; result["matches"] = matches; result["candidates"] = candidates; result["requires_review"] = true; result["applied"] = false;
        }
        return result;
    }
    private sealed class Parameters
    {
        public JsonArray Items { get; }
        public Parameters(JsonArray items) { Items = items; var remaining = 20000; Validate(items, 0, ref remaining); }
        private static void Validate(JsonArray items, int depth, ref int remaining) {
            if (depth > 16) throw Invalid();
            foreach (var node in items) {
                var item = node as JsonObject ?? throw Invalid();
                if (--remaining < 0 || S(item, "name").Length == 0 || item.Count(p => p.Key.StartsWith("value", StringComparison.Ordinal)) + (item.ContainsKey("part") ? 1 : 0) + (item.ContainsKey("resource") ? 1 : 0) != 1) throw Invalid();
                if (item.ContainsKey("part")) { var parts = item["part"] as JsonArray ?? throw Invalid(); if (parts.Count == 0) throw Invalid(); Validate(parts, depth + 1, ref remaining); }
            }
        }
        public JsonObject[] Named(string name) => Items.OfType<JsonObject>().Where(p => S(p, "name") == name).ToArray();
        public JsonNode? One(string name, string type) { var values = Named(name); if (values.Length > 1 || values.Length == 1 && !values[0].ContainsKey("value" + type)) throw Invalid(); return values.FirstOrDefault()?["value" + type]; }
        public JsonObject Values() {
            var result = new JsonObject();
            foreach (var group in Items.OfType<JsonObject>().GroupBy(p => S(p, "name"))) {
                var values = group.Select(p => (p["part"] ?? p["resource"] ?? p.FirstOrDefault(field => field.Key.StartsWith("value", StringComparison.Ordinal)).Value)?.DeepClone()).ToArray();
                result[group.Key] = values.Length == 1 && group.Key is not ("designation" or "property" or "match") ? values[0] : new JsonArray(values);
            }
            return result;
        }
    }
    private static JsonObject Expansion(JsonObject data, int requestedOffset, int requestedCount)
    {
        var expansion = data["expansion"] as JsonObject ?? throw Invalid();
        var total = expansion["total"]?.GetValue<int>(); var offset = expansion["offset"]?.GetValue<int>(); if (total < 0 || offset < 0) throw Invalid();
        var nested = false; var remaining = 50000;
        int Count(JsonArray items, int depth = 0) {
            if (depth > 16) throw Invalid(); var count = 0;
            foreach (var node in items) {
                var item = node as JsonObject ?? throw Invalid(); if (--remaining < 0) throw Invalid();
                foreach (var key in new[] { "system", "version", "code", "display" }) if (item[key] is not null && item[key]!.GetValueKind() != System.Text.Json.JsonValueKind.String) throw Invalid();
                if (item["code"] is not null) count++;
                if (item.ContainsKey("contains")) { nested = true; count += Count(item["contains"] as JsonArray ?? throw Invalid(), depth + 1); }
            }
            return count;
        }
        var count = Count(expansion["contains"] as JsonArray ?? (expansion["contains"] is null ? new JsonArray() : throw Invalid()));
        if (!nested && total is not null && (offset ?? 0) + count > total && count > 0 || !nested && count > requestedCount) throw Invalid();
        var unclosed = false;
        foreach (var node in new[] { data["extension"], expansion["extension"] }) {
            var extensions = node as JsonArray ?? (node is null ? new JsonArray() : throw Invalid());
            unclosed |= extensions.OfType<JsonObject>().Any(e => S(e, "url") == "http://hl7.org/fhir/StructureDefinition/valueset-unclosed" && e["valueBoolean"]?.GetValue<bool>() != false);
        }
        var confirmed = !nested && (offset is not null ? offset == requestedOffset : requestedOffset == 0);
        return new JsonObject { ["requested_offset"] = requestedOffset, ["requested_count"] = requestedCount, ["returned_offset"] = offset, ["total"] = total, ["returned_codes"] = count, ["hierarchical"] = nested, ["unclosed"] = unclosed, ["page_confirmed"] = confirmed, ["complete"] = confirmed && (offset ?? 0) == 0 && total is not null && count == total && !unclosed, ["has_more"] = confirmed && total is not null ? (offset ?? 0) + count < total : null };
    }
}
