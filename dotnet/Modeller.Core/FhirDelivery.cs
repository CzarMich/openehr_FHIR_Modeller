using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

public sealed record DeliveryReceipt(string ResourceSha256, string State, int? HttpStatus, string? DestinationResourceSha256 = null, string? DestinationSha256 = null, string? DestinationReference = null);
public sealed class FhirDelivery : IDisposable
{
    private readonly DestinationConnection destination;
    private readonly Uri root;
    private readonly HttpClient http = Network.Client(TimeSpan.FromSeconds(45));
    private JsonObject? capabilities;
    public FhirDelivery(Configuration config, DestinationConnection destination) { this.destination = destination; root = Network.DestinationUri(destination.BaseUrl, config); }
    public void Dispose() => http.Dispose();
    public string DestinationHash => Data.Hash(destination.Id + "\n" + root.AbsoluteUri);
    private DeliveryReceipt Receipt(string hash, string state, int? status, string? actual = null, string? reference = null) => new(hash, state, status, actual, DestinationHash, reference);
    private HttpRequestMessage Request(HttpMethod method, Uri uri) {
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Network.Key(destination.TokenFile));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/fhir+json"));
        return request;
    }
    public async Task Check(string fhirVersion, CancellationToken cancellation) {
        using var request = Request(HttpMethod.Get, new Uri(root, "metadata"));
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        if (!response.IsSuccessStatusCode) throw new ProcessingException("DESTINATION_CAPABILITIES_UNAVAILABLE");
        capabilities = await Network.Object(response, cancellation);
        if (capabilities["resourceType"]?.GetValue<string>() != "CapabilityStatement" || capabilities["fhirVersion"]?.GetValue<string>() != fhirVersion) throw new ProcessingException("DESTINATION_RELEASE_MISMATCH");
    }
    public static string PayloadHash(JsonObject resource) { var payload = (JsonObject)resource.DeepClone(); payload.Remove("id"); return Data.Hash(Data.Canonical(payload)); }
    public async Task<DeliveryReceipt> Send(JsonObject resource, CancellationToken cancellation) {
        var type = Data.Required(resource, "resourceType");
        if (!Regex.IsMatch(type, "^[A-Z][A-Za-z0-9]{1,63}$") || !destination.ResourceTypes.Contains(type, StringComparer.Ordinal)) throw new ProcessingException("DESTINATION_RESOURCE_SCOPE_REJECTED");
        var supported = (capabilities?["rest"] as JsonArray)?.OfType<JsonObject>().Where(r => r["mode"]?.GetValue<string>() == "server")
            .SelectMany(r => (r["resource"] as JsonArray)?.OfType<JsonObject>() ?? []).Any(r => r["type"]?.GetValue<string>() == type && r["conditionalCreate"]?.GetValue<bool>() == true
                && ((r["interaction"] as JsonArray)?.Any(i => i?["code"]?.GetValue<string>() == "create") ?? false));
        if (supported != true) throw new ProcessingException("DESTINATION_CONDITIONAL_CREATE_REQUIRED");
        var identifiers = resource["identifier"] as JsonArray;
        if (identifiers?.Count != 1 || identifiers[0] is not JsonObject identifier) throw new ProcessingException("RECORD_SINGLE_DELIVERY_IDENTIFIER_REQUIRED");
        var system = Data.Required(identifier, "system"); var value = Data.Required(identifier, "value");
        if (!Uri.TryCreate(system, UriKind.Absolute, out var identifierUri) || identifierUri.Scheme is not ("https" or "http" or "urn") || system.Contains('|') || value.Contains('|') || value.Length > 200 || value.Any(char.IsControl)) throw new ProcessingException("RECORD_DELIVERY_IDENTIFIER_INVALID");
        await References(resource, cancellation);
        var payload = (JsonObject)resource.DeepClone(); payload.Remove("id");
        var hash = PayloadHash(resource);
        for (var attempt = 0; attempt < 3; attempt++) {
            if (cancellation.IsCancellationRequested && attempt > 0) return Receipt(hash, "UNCERTAIN", null);
            cancellation.ThrowIfCancellationRequested();
            try {
                using var request = Request(HttpMethod.Post, new Uri(root, type));
                request.Content = JsonContent.Create(payload); request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/fhir+json");
                request.Headers.Add("If-None-Exist", "identifier=" + IdentifierQuery(system, value));
                request.Headers.Add("Prefer", "return=representation");
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
                var status = (int)response.StatusCode;
                if (status is 200 or 201) {
                    JsonObject? actual = null;
                    try { actual = await Network.Object(response, cancellation); }
                    catch (ProcessingException) { /* A location can still establish the actual committed representation. */ }
                    if (actual?["resourceType"]?.GetValue<string>() != type) {
                        var location = response.Headers.Location;
                        if (location is null) return Receipt(hash, "UNCERTAIN", status);
                        var uri = location.IsAbsoluteUri ? location : new Uri(root, location);
                        if (!root.IsBaseOf(uri) || uri.Query.Length > 0 || uri.Fragment.Length > 0 || !Regex.IsMatch(uri.AbsolutePath[root.AbsolutePath.Length..], "^" + type + "/[A-Za-z0-9.-]{1,64}(?:/_history/[A-Za-z0-9.-]{1,64})?$")) return Receipt(hash, "UNCERTAIN", status);
                        using var read = Request(HttpMethod.Get, uri); using var readResponse = await http.SendAsync(read, HttpCompletionOption.ResponseHeadersRead, cancellation);
                        if (readResponse.StatusCode != HttpStatusCode.OK) return Receipt(hash, "UNCERTAIN", status);
                        actual = await Network.Object(readResponse, cancellation);
                    }
                    if (!Equivalent(payload, actual)) return Receipt(hash, "EXISTING_CONTENT_CONFLICT", status);
                    return Receipt(hash, status == 201 ? "CREATED" : "ALREADY_PRESENT", status, Data.Hash(Data.Canonical(actual)), ReferenceOf(actual));
                }
                if (status == 202) return Receipt(hash, "UNCERTAIN", status);
                if (status == 429 || status >= 500 || status == 408) {
                    if (attempt < 2) { var wait = Math.Clamp(response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 1, 0, 3); await Task.Delay(TimeSpan.FromSeconds(wait), cancellation); continue; }
                    return Receipt(hash, "UNCERTAIN", status);
                }
                return Receipt(hash, status == 412 ? "IDENTIFIER_NOT_UNIQUE" : "REJECTED", status);
            } catch (HttpRequestException) { if (attempt == 2) return Receipt(hash, "UNCERTAIN", null); }
            catch (OperationCanceledException) { return Receipt(hash, "UNCERTAIN", null); }
            catch (Exception error) when (error is ProcessingException or System.Text.Json.JsonException or InvalidOperationException or IOException) { return Receipt(hash, "UNCERTAIN", null); }
        }
        return Receipt(hash, "UNCERTAIN", null);
    }
    public static string IdentifierQuery(string system, string value) {
        static string Escape(string input) => input.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("$", "\\$", StringComparison.Ordinal).Replace(",", "\\,", StringComparison.Ordinal).Replace("|", "\\|", StringComparison.Ordinal);
        return Uri.EscapeDataString(Escape(system) + "|" + Escape(value));
    }
    private static string ReferenceOf(JsonObject actual) {
        var reference = actual["resourceType"]?.GetValue<string>() + "/" + actual["id"]?.GetValue<string>();
        if (!Regex.IsMatch(reference, "^[A-Z][A-Za-z0-9]{1,63}/[A-Za-z0-9.-]{1,64}$")) throw new ProcessingException("DESTINATION_RESOURCE_ID_REQUIRED");
        return reference;
    }
    public async Task<JsonObject?> FindExact(string type, string system, string value, CancellationToken cancellation) {
        if (!Regex.IsMatch(type, "^[A-Z][A-Za-z0-9]{1,63}$") || !(destination.ReadResourceTypes ?? destination.ResourceTypes).Contains(type, StringComparer.Ordinal)) throw new ProcessingException("DESTINATION_RESOURCE_SCOPE_REJECTED");
        using var request = Request(HttpMethod.Get, new Uri(root, type + "?identifier=" + IdentifierQuery(system, value) + "&_count=2"));
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        if (response.StatusCode != HttpStatusCode.OK) throw new ProcessingException("DESTINATION_LOOKUP_UNAVAILABLE");
        var bundle = await Network.Object(response, cancellation);
        if (bundle["resourceType"]?.GetValue<string>() != "Bundle" || bundle["type"]?.GetValue<string>() != "searchset") throw new ProcessingException("DESTINATION_SEARCH_BUNDLE_REQUIRED");
        var entries = bundle["entry"] as JsonArray ?? new JsonArray();
        if (entries.Count > 1 || bundle["total"]?.GetValue<int>() > 1 || (bundle["link"] as JsonArray)?.Any(link => link?["relation"]?.GetValue<string>() == "next") == true) throw new ProcessingException("DESTINATION_IDENTIFIER_AMBIGUOUS");
        if (entries.Count == 0) return null;
        var resource = entries[0]?["resource"] as JsonObject ?? throw new ProcessingException("DESTINATION_SEARCH_RESOURCE_REQUIRED");
        _ = ReferenceOf(resource);
        if (resource["resourceType"]?.GetValue<string>() != type || (resource["identifier"] as JsonArray)?.Any(identifier => identifier?["system"]?.GetValue<string>() == system && identifier?["value"]?.GetValue<string>() == value) != true) throw new ProcessingException("DESTINATION_SEARCH_IDENTITY_MISMATCH");
        if (type == "Patient" && (resource["active"]?.GetValueKind() == System.Text.Json.JsonValueKind.False || (resource["link"] as JsonArray)?.Any(link => link?["type"]?.GetValue<string>() == "replaced-by") == true)) throw new ProcessingException("PATIENT_IDENTITY_REVIEW_REQUIRED");
        return resource;
    }
    public async Task<JsonObject?> ReadExact(string reference, CancellationToken cancellation) {
        if (!Regex.IsMatch(reference, "^[A-Z][A-Za-z0-9]{1,63}/[A-Za-z0-9.-]{1,64}$") || !(destination.ReadResourceTypes ?? destination.ResourceTypes).Contains(reference.Split('/')[0], StringComparer.Ordinal)) throw new ProcessingException("DESTINATION_RESOURCE_SCOPE_REJECTED");
        using var request = Request(HttpMethod.Get, new Uri(root, reference));
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone) return null;
        if (response.StatusCode != HttpStatusCode.OK) throw new ProcessingException("DESTINATION_LOOKUP_UNAVAILABLE");
        var actual = await Network.Object(response, cancellation);
        if (ReferenceOf(actual) != reference) throw new ProcessingException("DESTINATION_REFERENCE_IDENTITY_MISMATCH");
        return actual;
    }
    public static bool Equivalent(JsonObject expected, JsonObject? actual) {
        if (actual is null) return false;
        bool Contains(JsonNode? left, JsonNode? right) {
            if (left is JsonObject obj && right is JsonObject other) return obj.All(p => other.ContainsKey(p.Key) && Contains(p.Value, other[p.Key]));
            if (left is JsonArray array && right is JsonArray otherArray) return array.Count == otherArray.Count && array.Select((v, i) => Contains(v, otherArray[i])).All(v => v);
            return JsonNode.DeepEquals(left, right);
        }
        return Contains(expected, actual);
    }
    private async Task References(JsonObject resource, CancellationToken cancellation) {
        var references = new HashSet<string>(StringComparer.Ordinal);
        void Walk(JsonNode? node) {
            if (node is JsonObject obj) foreach (var pair in obj) {
                if (pair.Key == "reference" && pair.Value is JsonValue v) references.Add(v.GetValue<string>());
                else Walk(pair.Value);
            } else if (node is JsonArray array) foreach (var child in array) Walk(child);
        }
        Walk(resource);
        if (references.Count > 128) throw new ProcessingException("RECORD_REFERENCE_LIMIT");
        foreach (var reference in references) {
            if (reference.StartsWith('#')) {
                if ((resource["contained"] as JsonArray)?.Any(r => r?["id"]?.GetValue<string>() == reference[1..]) != true) throw new ProcessingException("RECORD_CONTAINED_REFERENCE_UNRESOLVED");
                continue;
            }
            if (!Regex.IsMatch(reference, "^[A-Z][A-Za-z0-9]{1,63}/[A-Za-z0-9.-]{1,64}$")) throw new ProcessingException("RECORD_LOCAL_DESTINATION_REFERENCE_REQUIRED");
            if (!(destination.ReadResourceTypes ?? destination.ResourceTypes).Contains(reference.Split('/')[0], StringComparer.Ordinal)) throw new ProcessingException("DESTINATION_RESOURCE_SCOPE_REJECTED");
            using var request = Request(HttpMethod.Get, new Uri(root, reference)); using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if (response.StatusCode == HttpStatusCode.NotFound || response.StatusCode == HttpStatusCode.Gone) throw new ProcessingException("RECORD_REFERENCE_UNRESOLVED");
            if (response.StatusCode != HttpStatusCode.OK) throw new ProcessingException("DESTINATION_REFERENCE_CHECK_UNAVAILABLE");
            var actual = await Network.Object(response, cancellation);
            if (actual["resourceType"]?.GetValue<string>() + "/" + actual["id"]?.GetValue<string>() != reference) throw new ProcessingException("RECORD_REFERENCE_IDENTITY_MISMATCH");
        }
    }
}
