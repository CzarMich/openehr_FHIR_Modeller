using System.Security.Cryptography;
using System.Text;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Protocol;
using Modeller.Mcp;
using Modeller.Core;
using System.Text.Json;

WorkspaceProtocol? workspace = null;
HumanProof? humanProof = null;
if (Environment.GetEnvironmentVariable("MODELLER_WORKSPACE_ENABLED") == "true") {
    var configurationFile = Environment.GetEnvironmentVariable("MODELLER_PROCESSING_CONFIG") ?? throw new InvalidOperationException("Workspace configuration required.");
    var configuration = Data.Read<Configuration>(configurationFile);
    var approvalKeys = JsonSerializer.Deserialize<Dictionary<string, string>>(Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEYS") ?? "{}") ?? throw new InvalidOperationException("Approval keys required.");
    var activeKey = Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEY_ID") ?? "active";
    var models = new ModelStore(configuration.ModelRoot, approvalKeys, activeKey);
    workspace = new WorkspaceProtocol(new Workspace(models, configuration), Environment.GetEnvironmentVariable("MODELLER_DRAFT_WRITES_ENABLED") == "true");
    humanProof = new HumanProof(approvalKeys, Environment.GetEnvironmentVariable("MODELLER_BROWSER_ORIGIN") ?? "",
        (Environment.GetEnvironmentVariable("MODELLER_IDENTITY_ISSUERS") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries), models);
}
var guides = new GuideRepository(Environment.GetEnvironmentVariable("GUIDE_ROOT") ?? "/app/resources/guides");
var stdio = args.Contains("--stdio");
var arguments = args.Where(a => a != "--stdio").ToArray();
Action<Microsoft.Extensions.Logging.Console.ConsoleLoggerOptions> stderr = options => options.LogToStandardErrorThreshold = LogLevel.Trace;
if (stdio)
{
    var builder = Host.CreateApplicationBuilder(arguments);
    builder.Logging.ClearProviders(); if (workspace is null) builder.Logging.AddConsole(stderr); builder.Logging.SetMinimumLevel(LogLevel.Warning);
    builder.Services.AddMcpServer(options =>
    {
        options.ServerInfo = new Implementation { Name = workspace is null ? "openehr-fhir-modeller-dotnet-dev" : "openehr-fhir-modeller-dotnet", Version = "0.1.0" };
        options.ServerInstructions = workspace is null ? "Read-only guide retrieval migration slice. Model writes, clinical approval and runtime data operations are unavailable." : "C# modelling workspace: supply exact models, original user narrative and explicit versioned rules. Direct FHIR and openEHR-mediated mappings are distinct. Human confirmation is a separate authenticated browser operation; agents cannot approve. MCP accepts synthetic records only and never delivers clinical records. Clinical/source database connections are read-only; no SQL driver is advertised. Private channels execute confirmed mappings without per-record LLM interpretation.";
    }).WithStdioServerTransport().AddGuides(guides, workspace);
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
web.Logging.ClearProviders(); if (workspace is null) web.Logging.AddConsole(stderr); web.Logging.SetMinimumLevel(LogLevel.Warning);
web.WebHost.ConfigureKestrel(options => { options.AddServerHeader = false; options.Limits.MaxRequestBodySize = workspace is null ? 262144 : 8 * 1048576; options.Limits.MaxRequestHeadersTotalSize = 16384; });
web.Services.AddMcpServer(options =>
{
    options.ServerInfo = new Implementation { Name = workspace is null ? "openehr-fhir-modeller-dotnet-dev" : "openehr-fhir-modeller-dotnet", Version = "0.1.0" };
    options.ServerInstructions = workspace is null ? "Read-only guide retrieval migration slice. Model writes, clinical approval and runtime data operations are unavailable." : "C# modelling workspace: supply exact models, original user narrative and explicit versioned rules. Direct FHIR and openEHR-mediated mappings are distinct. Human confirmation is a separate authenticated browser operation; agents cannot approve. MCP accepts synthetic records only and never delivers clinical records. Clinical/source database connections are read-only; no SQL driver is advertised. Private channels execute confirmed mappings without per-record LLM interpretation.";
}).WithHttpTransport(options => options.SessionMode = HttpServerSessionMode.Stateful).AddGuides(guides, workspace);
var app = web.Build();
app.Use(async (context, next) =>
{
    if (!hosts.Contains(context.Request.Host.Host)) { context.Response.StatusCode = 400; return; }
    if (context.Request.Headers.TryGetValue("Origin", out var origin) && (origin.Count != 1 || !origins.Contains(origin.ToString()))) { context.Response.StatusCode = 403; return; }
    if (context.Request.ContentLength > (workspace is null ? 262144 : 8 * 1048576)) { context.Response.StatusCode = 413; return; }
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
app.MapGet("/ready", () => Results.Json(new { status = "ready", scope = workspace is null ? "read-only guide retrieval" : "C# modelling and synthetic previews; operational records stay private", guides = guides.Resources.Count }));
app.MapMcp("/mcp");
if (workspace is not null && humanProof is not null) app.MapWorkspace(workspace, humanProof);
await app.RunAsync();
