using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Modeller.Mcp;

public static class GuideProtocol
{
    public static IMcpServerBuilder AddGuides(this IMcpServerBuilder builder, GuideRepository guides)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "contracts");
        var tool = JsonSerializer.Deserialize<Tool>(File.ReadAllText(Path.Combine(directory, "guide_get.tool.json")))
            ?? throw new InvalidOperationException("Published guide tool contract is required.");
        var template = JsonSerializer.Deserialize<ResourceTemplate>(File.ReadAllText(Path.Combine(directory, "guides.template.json")))
            ?? throw new InvalidOperationException("Published guide resource contract is required.");
        return builder
            .WithListToolsHandler((_, _) => ValueTask.FromResult(new ListToolsResult { Tools = [tool] }))
            .WithCallToolHandler((request, cancellation) =>
            {
                cancellation.ThrowIfCancellationRequested();
                var parameters = request.Params ?? throw InvalidInput();
                if (parameters.Name != "guide_get") throw InvalidInput();
                var args = parameters.Arguments ?? new Dictionary<string, JsonElement>();
                if (args.Keys.Any(k => k is not ("uri" or "category" or "name"))) throw InvalidInput();
                var uri = StringArgument(args, "uri", false) ?? "";
                var category = StringArgument(args, "category", true);
                var name = StringArgument(args, "name", false) ?? "";
                if (category is not null && !GuideRepository.Categories.Contains(category)) throw InvalidInput();
                try
                {
                    return ValueTask.FromResult(new CallToolResult
                    {
                        Content = [new EmbeddedResourceBlock { Resource = guides.Get(uri, category, name) }]
                    });
                }
                catch (GuideLookupException error)
                {
                    return ValueTask.FromResult(new CallToolResult { IsError = true, Content = [new TextContentBlock { Text = error.Message }] });
                }
            })
            .WithListResourcesHandler((_, _) => ValueTask.FromResult(new ListResourcesResult { Resources = guides.Resources.ToList() }))
            .WithListResourceTemplatesHandler((_, _) => ValueTask.FromResult(new ListResourceTemplatesResult { ResourceTemplates = [template] }))
            .WithReadResourceHandler((request, cancellation) =>
            {
                cancellation.ThrowIfCancellationRequested();
                try { return ValueTask.FromResult(new ReadResourceResult { Contents = [guides.Get(request.Params?.Uri ?? "")] }); }
                catch (GuideLookupException) { throw new McpProtocolException("Guide resource not found.", McpErrorCode.InvalidParams); }
            });
    }

    private static string? StringArgument(IDictionary<string, JsonElement> args, string key, bool nullable)
    {
        if (!args.TryGetValue(key, out var value)) return null;
        if (nullable && value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String) throw InvalidInput();
        return value.GetString();
    }
    private static McpProtocolException InvalidInput() => new("Input does not meet the published guide tool schema.", McpErrorCode.InvalidParams);
}
