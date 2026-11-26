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
        try { return JsonNode.Parse(output.ToArray()) as JsonObject ?? throw new ProcessingException("UPSTREAM_OBJECT_REQUIRED"); }
        catch (System.Text.Json.JsonException) { throw new ProcessingException("UPSTREAM_JSON_REQUIRED"); }
    }
    public static Uri DestinationUri(string value, Configuration config) {
        if (!Uri.TryCreate(value.TrimEnd('/') + '/', UriKind.Absolute, out var uri) || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0
            || (uri.Scheme != "https" && !(uri.Scheme == "http" && config.AllowLoopbackHttp && Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") == "Development" && System.Net.IPAddress.TryParse(uri.Host, out var ip) && System.Net.IPAddress.IsLoopback(ip)))) throw new ProcessingException("DESTINATION_HTTPS_REQUIRED");
        return uri;
    }
}
