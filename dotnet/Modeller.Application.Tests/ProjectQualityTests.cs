using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class ProjectQualityTests
{
    public static async Task Run(string root, Action<bool, string> check)
    {
        var repo = new SnapshotRepository(Path.Combine(root, "project-quality"));
        const string project = "qa-fixture";
        repo.Create(project, "Synthetic QA project", "No patient records");
        var actor = new ModellingIdentity("qa-author", "shared", true, [], false, ["modeller"]);
        var reviewer = new ModellingIdentity("qa-reviewer", "shared", true, [], false, ["modeller", "reviewer"], true, "interactive_local");
        using var engine = new StandardsGateway(); using var remote = new RemoteDefinitions();
        var quality = new ProjectQuality(repo, actor, engine, remote);
        var metadata = new JsonObject { ["provenance"] = new JsonObject { ["source"] = "Synthetic QA fixture" } };
        var source = repo.Save(project, "templates/qa.oet", "<template><definition /></template>", metadata, null);
        JsonObject Args(JsonObject s) => new() { ["project"] = project, ["path"] = s["path"]!.DeepClone(), ["revision"] = s["revision"]!.DeepClone() };
        string Status(JsonObject report, string name) => ((JsonArray)report["checks"]!).OfType<JsonObject>().First(c => c["name"]!.GetValue<string>() == name)["status"]!.GetValue<string>();
        var empty = await quality.Evaluate(Args(source), CancellationToken.None);
        check(Status(empty, "requirements_traceability") == "FAIL" && Status(empty, "native_build_evidence") == "NOT_EXECUTED", "missing recorded QA evidence is explicit");
        var governance = new ReviewGovernance(repo, actor, engine);
        var review = await governance.Execute("governance_prepare", new JsonObject { ["project"] = project, ["path"] = source["path"]!.DeepClone(), ["modelRevision"] = source["revision"]!.DeepClone(), ["comment"] = "Synthetic evidence fixture" }, CancellationToken.None);
        var subject = review["subject"]!.GetValue<string>();
        await governance.Execute("governance_validate", new JsonObject { ["subject"] = subject, ["expectedSequence"] = 1 }, CancellationToken.None);
        await governance.Execute("governance_request_review", new JsonObject { ["subject"] = subject, ["expectedSequence"] = 2, ["comment"] = "Review exact synthetic source" }, CancellationToken.None);
        new ReviewGovernance(repo, reviewer, engine).HumanTransition(subject, 3, "REVIEWED", "Independent synthetic review", null);
        using var ledger = new AuditLedger(); var events = ledger.Events("shared", subject);
        JsonObject Node(string id, string type) => new() { ["id"] = id, ["type"] = type, ["title"] = id, ["description"] = "Synthetic project evidence", ["provenance"] = new JsonArray("Synthetic fixture") };
        JsonObject Evidence(string id, string type, int sequence) { var node = Node(id, type); node["event"] = new JsonObject { ["subject"] = subject, ["sequence"] = sequence, ["hash"] = events[sequence - 1]!["hash"]!.DeepClone() }; return node; }
        var requirement = Node("REQ-QA", "requirement"); requirement["priority"] = "must"; requirement["status"] = "ACTIVE";
        var model = Node("MODEL-QA", "template"); model["artifact"] = TemplateAuthoring.Reference(source); ((JsonObject)model["artifact"]!).Remove("provider");
        JsonObject Edge(string from, string to, string relation) => new() { ["from"] = from, ["to"] = to, ["relation"] = relation, ["rationale"] = "Explicit synthetic reference" };
        var satisfaction = Edge("REQ-QA", "MODEL-QA", "satisfied_by"); satisfaction["coverage"] = "full";
        var graph = new JsonObject { ["schema"] = 1, ["nodes"] = new JsonArray(requirement, model, Evidence("VALIDATION-QA", "validation_evidence", 2), Evidence("REVIEW-QA", "review", 4)), ["edges"] = new JsonArray(satisfaction, Edge("MODEL-QA", "VALIDATION-QA", "validated_by"), Edge("MODEL-QA", "REVIEW-QA", "reviewed_by")) };
        await new Traceability(repo, actor, engine).Execute("model_traceability_save", new JsonObject { ["project"] = project, ["graph"] = graph }, CancellationToken.None);
        var dependency = repo.Save(project, "archetypes/synthetic.adl", "synthetic exact dependency", metadata, null);
        JsonObject Build(JsonObject input, string output) {
            var pin = TemplateAuthoring.Reference(dependency); pin["identifier"] = "synthetic-archetype";
            var manifest = new JsonArray(pin);
            var engineId = new JsonObject { ["name"] = "synthetic-evidence-fixture", ["version"] = "1" };
            var build = new JsonObject { ["schema"] = 1, ["project"] = project, ["source"] = TemplateAuthoring.Reference(input), ["dependencies"] = manifest, ["engine"] = engineId, ["output_sha256"] = Data.Hash(output) };
            build["id"] = Data.Hash(HistoricJson.Encode(JsonNode.Parse(Data.Canonical(build))!, false));
            build["format"] = "opt14_xml";
            build["report"] = new JsonObject { ["operation"] = "compile/template", ["valid"] = true, ["status"] = "PASS", ["content_sha256"] = input["sha256"]!.DeepClone(), ["engine"] = engineId.DeepClone(), ["checks"] = new JsonArray(), ["limitations"] = new JsonArray("Synthetic evidence verification only; no real compilation asserted."), ["dependencies"] = new JsonArray(new JsonObject { ["identifier"] = "synthetic-archetype", ["sha256"] = dependency["sha256"]!.DeepClone() }), ["profile"] = "OET14_COMPILATION_RM_STRUCTURE" };
            return build;
        }
        var output = "<template><definition /></template>";
        var build = Build(source, output);
        var compiled = repo.Save(project, "templates/opt/qa.opt", output, new JsonObject { ["kind"] = "compiled_opt14", ["build"] = build.DeepClone() }, null);
        var valid = await quality.Evaluate(Args(source), CancellationToken.None);
        check(Status(valid, "recorded_requirements_trail") == "PASS" && Status(valid, "recorded_validation_evidence") == "PASS" && Status(valid, "recorded_human_review") == "PASS", "exact graph references resolve authentic validation and human review events");
        check(Status(valid, "native_build_evidence") == "PASS" && Status(valid, "pinned_dependency_integrity") == "PASS", "saved output identity and exact dependency hashes verified");
        check(valid["clinical_approval"]!.GetValue<bool>() == false && valid["release_eligible"]!.GetValue<bool>() == false && valid["status"]!.GetValue<string>() == "INCOMPLETE", "recorded evidence does not certify clinical meaning or release qualification");
        check(((JsonArray)valid["findings"]!).OfType<JsonObject>().Any(f => f["code"]!.GetValue<string>() == "VALIDATION_NOT_QUALIFIED"), "historical unqualified validation remains visible");
        var changed = repo.Save(project, "templates/qa.oet", "<template><definition /><description>New draft</description></template>", metadata, source["revision"]!.GetValue<string>());
        var newerBuild = Build(changed, output + "\n");
        compiled = repo.Save(project, "templates/opt/qa.opt", output + "\n", new JsonObject { ["kind"] = "compiled_opt14", ["build"] = newerBuild.DeepClone() }, compiled["revision"]!.GetValue<string>());
        var historical = await quality.Evaluate(Args(source), CancellationToken.None);
        check(Status(historical, "current_revision") == "FAIL" && Status(historical, "native_build_evidence") == "PASS", "historical source uses exact saved historical build without pretending current freshness");
        newerBuild["output_sha256"] = new string('0', 64);
        repo.Save(project, "templates/opt/qa.opt", output + "\n", new JsonObject { ["kind"] = "compiled_opt14", ["build"] = newerBuild.DeepClone() }, compiled["revision"]!.GetValue<string>());
        var inconsistent = await quality.Evaluate(Args(changed), CancellationToken.None);
        check(Status(inconsistent, "native_build_evidence") == "FAIL" && inconsistent["status"]!.GetValue<string>() == "FAIL", "inconsistent saved build fails QA");
        repo.Save(project, "archetypes/synthetic.adl", "changed dependency draft", metadata, dependency["revision"]!.GetValue<string>());
        var pinned = await quality.Evaluate(Args(source), CancellationToken.None);
        check(Status(pinned, "native_build_evidence") == "PASS", "later dependency edits do not rewrite historical pinned evidence");
    }
}
