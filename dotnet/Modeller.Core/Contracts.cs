using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Modeller.Core;

public sealed class ProcessingException(string code) : Exception(code) { public string Code => Message; }
public static class Data
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, MaxDepth = 64, RespectRequiredConstructorParameters = true };
    public static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public static string Canonical(JsonNode? value) => value switch {
        JsonObject obj => "{" + string.Join(",", obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Key) + ":" + Canonical(p.Value))) + "}",
        JsonArray arr => "[" + string.Join(",", arr.Select(Canonical)) + "]",
        _ => value?.ToJsonString() ?? "null"
    };
    public static JsonNode? ParseStrict(byte[] bytes) {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 64 });
        var objects = new Stack<HashSet<string>>();
        while (reader.Read()) {
            if (reader.TokenType == JsonTokenType.StartObject) objects.Push(new HashSet<string>(StringComparer.Ordinal));
            else if (reader.TokenType == JsonTokenType.EndObject) objects.Pop();
            else if (reader.TokenType == JsonTokenType.PropertyName && !objects.Peek().Add(reader.GetString()!)) throw new ProcessingException("DUPLICATE_JSON_MEMBER");
        }
        return JsonNode.Parse(bytes);
    }
    public static T Read<T>(string file, int limit = 1048576) {
        if (new FileInfo(file).Length > limit) throw new ProcessingException("DOCUMENT_LIMIT");
        return JsonSerializer.Deserialize<T>(File.ReadAllText(file), Json) ?? throw new ProcessingException("DOCUMENT_REQUIRED");
    }
    public static void Write(string file, object value) {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            JsonSerializer.Serialize(stream, value, Json); stream.Flush(true);
        }
        File.Move(temporary, file, true);
    }
    public static string Required(JsonObject obj, string key) => obj[key]?.GetValue<string>() is { Length: > 0 } value ? value : throw new ProcessingException("MAPPING_FIELD_REQUIRED");
    public static void Keys(JsonObject obj, params string[] allowed) { if (obj.Any(p => !allowed.Contains(p.Key))) throw new ProcessingException("UNSUPPORTED_FIELD"); }
}
public sealed record SourceConnection(string Id, string Root, string Format, string[] Projects, string[] Owners, string? IdentityDomain = null, bool TrustPatientRegistration = false);
public sealed record DestinationConnection(string Id, string BaseUrl, string TokenFile, string[] Projects, string[] Owners, string[] ResourceTypes);
public sealed record Configuration(string ModelRoot, string FhirUrl, string FhirKeyFile, string NativeUrl, string NativeKeyFile, SourceConnection[] Sources, DestinationConnection[] Destinations, bool AllowLoopbackHttp = false, bool RequireTerminology = true, string? OperationalRoot = null, string? OperationalKeyFile = null, string[]? RuntimeFiles = null);
public sealed record JobRequest(string Owner, string ProjectId, string Subject, string SourceId, string File, string SourceSha256, string Mode, string? DestinationId = null, string? IntakeId = null, string? SourceContractKey = null);
public sealed class JobState {
    public string SchemaVersion { get; set; } = "1";
    public string Status { get; set; } = "PENDING";
    public string? Error { get; set; }
    public string? MappingSha256 { get; set; }
    public string? ConfigurationSha256 { get; set; }
    public string? SourceSchemaSha256 { get; set; }
    public int Checkpoint { get; set; }
    public int Read { get; set; }
    public int Transformed { get; set; }
    public int Rejected { get; set; }
    public int Exported { get; set; }
    public int Emitted { get; set; }
    public int DeliveryFailed { get; set; }
    public int Uncertain { get; set; }
    public int Held { get; set; }
    public DateTimeOffset Updated { get; set; } = DateTimeOffset.UtcNow;
}
