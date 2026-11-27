using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class OptionalRepositoryTests
{
    public static async Task Run(string root, Action<bool, string> check)
    {
        var guides = Path.Combine(root, "independent-knowledge", "guides", "howto"); Directory.CreateDirectory(guides);
        File.WriteAllText(Path.Combine(guides, "synthetic.md"), "# Synthetic modelling guide\nA synthetic retrieval fixture.");
        var beforeProvider = Environment.GetEnvironmentVariable("MODEL_REPOSITORY_PROVIDER");
        var beforePath = Environment.GetEnvironmentVariable("MODEL_REPOSITORY_PATH");
        var unused = Path.Combine(root, "unused-repository");
        try {
            Environment.SetEnvironmentVariable("MODEL_REPOSITORY_PROVIDER", "unavailable-fixture");
            Environment.SetEnvironmentVariable("MODEL_REPOSITORY_PATH", unused);
            using var application = new ModellingApplication(Path.GetDirectoryName(Path.GetDirectoryName(guides))!);
            var actor = new ModellingIdentity("synthetic-guide-reader", "shared", false, []);
            var result = await application.Execute("guide_search", new JsonObject { ["query"] = "synthetic", ["maxResults"] = 1 }, actor, CancellationToken.None);
            check(result["items"] is JsonArray { Count: 1 } && !Directory.Exists(unused), "knowledge retrieval does not initialise an unrelated optional repository");
            try { await application.Execute("model_projects", new JsonObject(), actor, CancellationToken.None); throw new Exception("Unavailable repository was silently substituted"); }
            catch (ProcessingException error) { check(error.Code == "REPOSITORY_PROVIDER_UNSUPPORTED", "repository operations still reject the unavailable configured provider"); }
        } finally {
            Environment.SetEnvironmentVariable("MODEL_REPOSITORY_PROVIDER", beforeProvider);
            Environment.SetEnvironmentVariable("MODEL_REPOSITORY_PATH", beforePath);
        }
    }
}
