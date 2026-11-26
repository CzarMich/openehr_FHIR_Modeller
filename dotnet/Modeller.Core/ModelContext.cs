using System.Text.Json.Nodes;

namespace Modeller.Core;

public sealed class ModelContext : IAsyncDisposable
{
    private readonly ModelStore store;
    private readonly JobRequest job;
    public JsonObject Project { get; private set; } = new();
    public JsonObject Selection { get; private set; } = new();
    public string MappingJson => Data.Required(Selection, "executionMapping");
    private ModelContext(ModelStore store, JobRequest job) { this.store = store; this.job = job; }
    public static Task<ModelContext> Connect(Configuration configuration, JobRequest job, CancellationToken cancellation) {
        var keys = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEYS") ?? "{}") ?? throw new ProcessingException("APPROVAL_KEYS_REQUIRED");
        var active = Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEY_ID") ?? "active";
        var context = new ModelContext(new ModelStore(configuration.ModelRoot, keys, active), job);
        context.Refresh(cancellation).GetAwaiter().GetResult();
        context.Project = (JsonObject)context.Selection["projectConfiguration"]!.DeepClone();
        return Task.FromResult(context);
    }
    public Task Refresh(CancellationToken cancellation) {
        cancellation.ThrowIfCancellationRequested(); var current = store.GetDefinition(job.Subject, ModelActor.Service);
        if (current["project"]?.GetValue<string>() != job.ProjectId || current["mappingConfirmed"]?.GetValue<bool>() != true || current["current"]?.GetValue<bool>() != true) throw new ProcessingException("CURRENT_HUMAN_CONFIRMATION_REQUIRED");
        if (Selection["mappingSha256"] is JsonNode previous && previous.GetValue<string>() != current["mappingSha256"]?.GetValue<string>()) throw new ProcessingException("MAPPING_CHANGED");
        Selection = current; return Task.CompletedTask;
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
