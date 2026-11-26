using System.Security.Cryptography;
using System.Text;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Protocol;
using Modeller.Mcp;

var guides = new GuideRepository(Environment.GetEnvironmentVariable("GUIDE_ROOT") ?? "/app/resources/guides");
var stdio = args.Contains("--stdio");
var arguments = args.Where(a => a != "--stdio").ToArray();
Action<Microsoft.Extensions.Logging.Console.ConsoleLoggerOptions> stderr = options => options.LogToStandardErrorThreshold = LogLevel.Trace;
if (stdio)
{
    var builder = Host.CreateApplicationBuilder(arguments);
    builder.Logging.ClearProviders(); builder.Logging.AddConsole(stderr); builder.Logging.SetMinimumLevel(LogLevel.Warning);
    builder.Services.AddMcpServer(options =>
    {
        options.ServerInfo = new Implementation { Name = "openehr-fhir-modeller-dotnet-dev", Version = "0.1.0" };
        options.ServerInstructions = "Read-only guide retrieval migration slice. Model writes, clinical approval and runtime data operations are unavailable.";
    }).WithStdioServerTransport().AddGuides(guides);
    await builder.Build().RunAsync();
    return;
}

var keyFile = Environment.GetEnvironmentVariable("DOTNET_MCP_API_KEY_FILE");
if (string.IsNullOrWhiteSpace(keyFile) || !Path.IsPathFullyQualified(keyFile) || new FileInfo(keyFile).Length > 257)
    throw new InvalidOperationException("An explicit scoped API key file is required.");
var secret = File.ReadAllText(keyFile).Trim();
if (secret.Length is < 32 or > 256) throw new InvalidOperationException("The API key does not meet the deployment constraints.");
var keyHash = SHA256.HashData(Encoding.UTF8.GetBytes(secret));
var hosts = (Environment.GetEnvironmentVariable("DOTNET_MCP_ALLOWED_HOSTS") ?? "localhost,127.0.0.1").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
var origins = (Environment.GetEnvironmentVariable("DOTNET_MCP_ALLOWED_ORIGINS") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);
var web = WebApplication.CreateBuilder(arguments);
web.Logging.ClearProviders(); web.Logging.AddConsole(stderr); web.Logging.SetMinimumLevel(LogLevel.Warning);
web.WebHost.ConfigureKestrel(options => { options.AddServerHeader = false; options.Limits.MaxRequestBodySize = 262144; options.Limits.MaxRequestHeadersTotalSize = 16384; });
web.Services.AddMcpServer(options =>
{
    options.ServerInfo = new Implementation { Name = "openehr-fhir-modeller-dotnet-dev", Version = "0.1.0" };
    options.ServerInstructions = "Read-only guide retrieval migration slice. Model writes, clinical approval and runtime data operations are unavailable.";
}).WithHttpTransport(options => options.SessionMode = HttpServerSessionMode.Stateful).AddGuides(guides);
var app = web.Build();
app.Use(async (context, next) =>
{
    if (!hosts.Contains(context.Request.Host.Host)) { context.Response.StatusCode = 400; return; }
    if (context.Request.Headers.TryGetValue("Origin", out var origin) && (origin.Count != 1 || !origins.Contains(origin.ToString()))) { context.Response.StatusCode = 403; return; }
    if (context.Request.ContentLength > 262144) { context.Response.StatusCode = 413; return; }
    if (context.Request.Path is not { Value: "/health" or "/ready" })
    {
        var value = context.Request.Headers["X-API-Key"];
        if (value.Count != 1 || !CryptographicOperations.FixedTimeEquals(keyHash, SHA256.HashData(Encoding.UTF8.GetBytes(value.ToString()))))
        { context.Response.StatusCode = 401; return; }
    }
    context.Response.Headers.XContentTypeOptions = "nosniff";
    await next();
});
app.MapGet("/health", () => Results.Json(new { status = "alive" }));
app.MapGet("/ready", () => Results.Json(new { status = "ready", scope = "read-only guide retrieval", guides = guides.Resources.Count }));
app.MapMcp("/mcp");
await app.RunAsync();
