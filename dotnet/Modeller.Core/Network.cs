using System.Text.Json.Nodes;

namespace Modeller.Core;

public static class Network
{
    public static HttpClient Client(TimeSpan timeout) => new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false, MaxResponseHeadersLength = 32, MaxConnectionsPerServer = 2 }) { Timeout = timeout };
    public static string Key(string file) {
        if (!Path.IsPathFullyQualified(file) || new FileInfo(file).Length > 8192) throw new ProcessingException("CONNECTION_CREDENTIAL_INVALID");
        var key = File.ReadAllText(file).Trim();
        if (key.Length is < 16 or > 8192 || key.Any(c => c < '!' || c > '~')) throw new ProcessingException("CONNECTION_CREDENTIAL_INVALID");
        return key;
    }
    public static async Task<JsonObject> Object(HttpResponseMessage response, CancellationToken cancellation, int limit = 5 * 1048576) {
        if (response.Content.Headers.ContentLength > limit) throw new ProcessingException("UPSTREAM_RESPONSE_LIMIT");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
        using var output = new MemoryStream(); var buffer = new byte[16384];
        int size; while ((size = await stream.ReadAsync(buffer, cancellation)) > 0) { if (output.Length + size > limit) throw new ProcessingException("UPSTREAM_RESPONSE_LIMIT"); output.Write(buffer, 0, size); }
        try { return Data.ParseStrict(output.ToArray()) as JsonObject ?? throw new ProcessingException("UPSTREAM_OBJECT_REQUIRED"); }
        catch (System.Text.Json.JsonException) { throw new ProcessingException("UPSTREAM_JSON_REQUIRED"); }
    }
    // Private deterministic compute only. Destination delivery has its own conditional-create policy.
    public static async Task<HttpResponseMessage> Compute(HttpClient client, HttpRequestMessage original, CancellationToken cancellation) {
        var bytes = original.Content is null ? null : await original.Content.ReadAsByteArrayAsync(cancellation);
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        for (;;) {
            cancellation.ThrowIfCancellationRequested();
            using var attempt = new HttpRequestMessage(original.Method, original.RequestUri);
            foreach (var header in original.Headers) attempt.Headers.TryAddWithoutValidation(header.Key, header.Value);
            if (bytes is not null) {
                attempt.Content = new ByteArrayContent(bytes);
                foreach (var header in original.Content!.Headers) if (!header.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) attempt.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }
            var response = await client.SendAsync(attempt, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if ((int)response.StatusCode is not (429 or 503) || elapsed.Elapsed >= TimeSpan.FromSeconds(330)) return response;
            var delay = Math.Clamp(response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 1, 1, 5);
            response.Dispose();
            await Task.Delay(TimeSpan.FromSeconds(delay), cancellation);
        }
    }
    public static JsonObject NativeData(JsonObject envelope) {
        if (envelope["ok"] is JsonValue flag && flag.TryGetValue<bool>(out var ok) && ok && envelope["data"] is JsonObject data) return (JsonObject)data.DeepClone();
        var code = envelope["error"]?["code"]?.GetValue<string>();
        if (code is not null && System.Text.RegularExpressions.Regex.IsMatch(code, "^ENGINE_[A-Z0-9_]{1,90}$")) throw new ProcessingException(code);
        throw new ProcessingException("OPENEHR_ENGINE_PROTOCOL_ERROR");
    }
    public static Uri DestinationUri(string value, Configuration config) {
        if (!Uri.TryCreate(value.TrimEnd('/') + '/', UriKind.Absolute, out var uri) || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0
            || (uri.Scheme != "https" && !(uri.Scheme == "http" && config.AllowLoopbackHttp && Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") == "Development" && System.Net.IPAddress.TryParse(uri.Host, out var ip) && System.Net.IPAddress.IsLoopback(ip)))) throw new ProcessingException("DESTINATION_HTTPS_REQUIRED");
        return uri;
    }
}
