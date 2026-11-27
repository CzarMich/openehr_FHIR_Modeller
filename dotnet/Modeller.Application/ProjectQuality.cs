using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Application;

/// <summary>Read-only checks of one exact model revision and its recorded evidence.</summary>
public sealed class ProjectQuality(SnapshotRepository repository, ModellingIdentity actor, StandardsGateway engine, RemoteDefinitions remote)
{
    private static string S(JsonObject obj, string key) => KnowledgeCorpus.Text(obj, key);
    private static bool Same(JsonObject? left, JsonObject? right) => left is not null && right is not null &&
        new[] { "path", "revision", "sha256" }.All(key => S(left, key).Length > 0 && S(left, key) == S(right, key));

    public async Task<JsonObject> Evaluate(JsonObject args, CancellationToken cancellation)
    {
        var project = Data.Required(args, "project");
        actor.Read(project);
        var path = Data.Required(args, "path");
        var source = repository.Artifact(project, path, args["revision"]?.GetValue<string>());
        if (source["content"]?.GetValueKind() != System.Text.Json.JsonValueKind.String) throw new ProcessingException("MODEL_TEXT_FORMAT_REQUIRED");
        var content = Data.Required(source, "content");
        var format = args["format"]?.GetValue<string>() ?? Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
        if (format is "adls" or "adlt") format = "adl";
        var report = await ModelChecks.Quality(new JsonObject { ["content"] = content, ["format"] = format }, engine, cancellation);
        var findings = (JsonArray)report["findings"]!.DeepClone();
        var checks = new JsonArray();
        void Finding(string severity, string code, string message, string location = "/") {
            var finding = ModelChecks.Finding(severity, code, message); finding["location"] = location; findings.Add(finding);
        }
        void Check(string name, bool pass, string code) {
            checks.Add(new JsonObject { ["name"] = name, ["status"] = pass ? "PASS" : "FAIL" });
            if (!pass) Finding("error", code, "Exact source repository evidence did not satisfy this check.", path);
        }
        Check("repository_integrity", Data.Hash(content) == S(source, "sha256"), "REPOSITORY_HASH_MISMATCH");
        Check("project_active", S(repository.Project(project), "status") == "ACTIVE", "PROJECT_ARCHIVED");
        try { Check("current_revision", Same(repository.Artifact(project, path), source), "REPOSITORY_REVISION_CONFLICT"); }
        catch (ProcessingException) {
            checks.Add(ModelChecks.Stage("current_revision", "NOT_EXECUTED", "The current source could not be read."));
            Finding("error", "REPOSITORY_CURRENT_UNAVAILABLE", "Current source freshness could not be verified.", path);
        }
        Check("recorded_provenance", Provenance(source["metadata"]?["provenance"]), "MISSING_PROVENANCE");
        JsonObject? trace = null;
        try {
            var graphReport = await new Traceability(repository, actor, engine).Execute("model_traceability_get", new JsonObject { ["project"] = project }, cancellation);
            var graph = (JsonObject)graphReport["graph"]!;
            var nodes = ((JsonArray)graph["nodes"]!).OfType<JsonObject>().ToDictionary(node => S(node, "id"), StringComparer.Ordinal);
            var edges = ((JsonArray)graph["edges"]!).OfType<JsonObject>().ToArray();
            var models = nodes.Values.Where(node => Same(node["artifact"] as JsonObject, source)).Select(node => S(node, "id")).ToArray();
            HashSet<string> Walk(string start, bool reverse, string[]? relations = null) {
                var visited = new HashSet<string>(StringComparer.Ordinal) { start }; var queue = new Queue<string>(); queue.Enqueue(start);
                while (queue.TryDequeue(out var id)) foreach (var edge in edges) {
                    if (relations is not null && !relations.Contains(S(edge, "relation"))) continue;
                    var from = reverse ? S(edge, "to") : S(edge, "from"); var to = reverse ? S(edge, "from") : S(edge, "to");
                    if (from == id && visited.Add(to)) queue.Enqueue(to);
                }
                return visited;
            }
            var linked = new HashSet<string>(StringComparer.Ordinal);
            var hasRequirement = false;
            foreach (var id in models) {
                var ancestors = Walk(id, true);
                hasRequirement |= ancestors.Any(node => S(nodes[node], "type") == "requirement" && S(nodes[node], "status") == "ACTIVE");
                linked.UnionWith(ancestors); linked.UnionWith(Walk(id, false, ["bound_by", "validated_by", "reviewed_by"]));
            }
            Check("recorded_requirements_trail", hasRequirement, "MISSING_REQUIREMENT_TRACEABILITY");
            var validations = new JsonObject(); var reviews = new JsonObject();
            using var ledger = new AuditLedger();
            foreach (var id in linked) {
                var resolved = graphReport["resolved"]?[id] as JsonObject;
                if (S(resolved ?? new JsonObject(), "status") is "INVALID" or "UNAVAILABLE" or "STALE") {
                    Finding("error", "TRACEABILITY_REFERENCE_UNVERIFIED", "A linked exact model or evidence reference is unavailable, invalid or stale.", id); continue;
                }
                var node = nodes[id];
                if (node["event"] is not JsonObject pin || S(resolved ?? new JsonObject(), "status") != "VERIFIED") continue;
                var events = ledger.Events(actor.Tenant, S(pin, "subject"));
                var sequence = pin["sequence"]!.GetValue<int>();
                var evidence = sequence > 0 && sequence <= events.Count ? events[sequence - 1] as JsonObject : null;
                if (evidence is null || S(evidence, "hash") != S(pin, "hash") || S(evidence, "project") != project || !Same(events[0]?["source"] as JsonObject, source)) continue;
                var detail = new JsonObject { ["event"] = pin.DeepClone(), ["source"] = events[0]!["source"]!.DeepClone(), ["status"] = "VERIFIED" };
                if (S(node, "type") == "validation_evidence" && S(evidence, "type") == "VALIDATION") {
                    var validation = evidence["validation"] as JsonObject;
                    var qualified = ReviewGovernance.Qualified(validation, S(source, "sha256"));
                    detail["release_eligible_at_event"] = qualified; detail["validation_status"] = validation?["status"]?.DeepClone();
                    validations[id] = detail;
                    if (!qualified) Finding("warning", "VALIDATION_NOT_QUALIFIED", "An authentic validation event does not qualify the model for release.", id);
                } else if (S(node, "type") == "review" && S(evidence, "type") == "TRANSITION" && evidence["actor"]?["human"]?.GetValue<bool>() == true) reviews[id] = detail;
            }
            Check("recorded_validation_evidence", validations.Count > 0, "MISSING_VALIDATION_EVIDENCE");
            checks.Add(new JsonObject { ["name"] = "recorded_human_review", ["status"] = reviews.Count > 0 ? "PASS" : "NOT_EXECUTED", ["scope"] = "Historical authenticated review presence only; not a current approval." });
            if (reviews.Count == 0) Finding("warning", "MISSING_HUMAN_REVIEW", "No authentic linked human review was found.", path);
            trace = new JsonObject { ["artifact"] = graphReport["artifact"]!.DeepClone(), ["model_nodes"] = new JsonArray(models.Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()), ["linked_nodes"] = new JsonArray(linked.Order(StringComparer.Ordinal).Select(id => (JsonNode)JsonValue.Create(id)!).ToArray()), ["validation_events"] = validations, ["review_events"] = reviews, ["semantic_satisfaction"] = "NOT_ASSESSED" };
        } catch (ProcessingException e) when (e.Code != "PROJECT_PERMISSION_REQUIRED") {
            Check("requirements_traceability", false, "MISSING_OR_INVALID_TRACEABILITY");
        }
        try {
            var inspection = new TerminologyWorkspace(repository, actor, remote);
            var result = await inspection.Execute("model_terminology_inspect", new JsonObject { ["project"] = project, ["path"] = path, ["revision"] = source["revision"]!.DeepClone() }, cancellation);
            checks.Add(new JsonObject { ["name"] = "explicit_terminology_inspection", ["status"] = result["inspection"]!["status"]!.DeepClone(), ["scope"] = result["inspection"]!["scope"]!.DeepClone(), ["qualified"] = false });
        } catch (ProcessingException) {
            checks.Add(ModelChecks.Stage("explicit_terminology_inspection", "NOT_EXECUTED", "The explicit source inspector could not execute."));
            Finding("warning", "TERMINOLOGY_INSPECTION_NOT_EXECUTED", "Terminology requirements could not be inspected.", path);
        }
        var builds = Builds(project, source);
        checks.Add(new JsonObject { ["name"] = "native_build_evidence", ["status"] = builds["status"]!.DeepClone(), ["builds"] = builds["builds"]!.DeepClone(), ["reason"] = builds["reason"]?.DeepClone() });
        if (S(builds, "status") != "PASS") Finding(S(builds, "status") == "FAIL" ? "error" : "warning", S(builds, "status") == "FAIL" ? "NATIVE_BUILD_EVIDENCE_INVALID" : "NATIVE_BUILD_EVIDENCE_NOT_FOUND", "A matching saved build is missing or failed exact-source/output/dependency verification.", path);
        checks.Add(ModelChecks.Stage("pinned_dependency_integrity", S(builds, "status") == "PASS" ? "PASS" : "NOT_EXECUTED", "Exact pinned repository revisions and hashes from a verified saved build manifest."));
        foreach (var name in new[] { "dependency_versions", "rm_type_membership", "duplicate_native_node_identifiers", "native_path_resolution", "deprecated_dependencies", "external_dependency_resolution" }) {
            checks.Add(ModelChecks.Stage(name, "NOT_EXECUTED", "Requires a qualified model-aware engine and dependency resolver."));
            Finding("warning", "CHECK_NOT_EXECUTED", "This model-aware check has not run: " + name, path);
        }
        return new JsonObject { ["status"] = findings.OfType<JsonObject>().Any(f => S(f, "severity") == "error") ? "FAIL" : "INCOMPLETE", ["release_eligible"] = false, ["source"] = TemplateAuthoring.Reference(source), ["content_sha256"] = source["sha256"]!.DeepClone(), ["format"] = format, ["document_validation"] = report["steps"]![0]!["report"]!.DeepClone(), ["checks"] = checks, ["traceability"] = trace, ["findings"] = findings, ["model_changed"] = false, ["clinical_approval"] = false, ["scope"] = "Exact source/document checks and recorded evidence; provenance and requirement links remain modeller assertions.", ["consistency"] = "Observed repository/ledger reads, not a distributed snapshot transaction.", ["executed_at"] = DateTimeOffset.UtcNow.ToString("O") };
    }

    private static bool Provenance(JsonNode? value, int depth = 0) => depth <= 16 && (value is JsonValue text && text.GetValueKind() == System.Text.Json.JsonValueKind.String && !string.IsNullOrWhiteSpace(text.GetValue<string>()) || value is JsonObject obj && obj.Any(p => Provenance(p.Value, depth + 1)) || value is JsonArray array && array.Any(p => Provenance(p, depth + 1)));

    private JsonObject Builds(string project, JsonObject source)
    {
        var verified = new JsonArray(); var invalid = new JsonArray();
        JsonObject Result(string status, string? reason) => new() { ["status"] = status, ["builds"] = verified, ["invalid_builds"] = invalid, ["reason"] = reason };
        JsonObject[] artifacts;
        try { artifacts = repository.Artifacts(project).OfType<JsonObject>().ToArray(); }
        catch (ProcessingException) { return Result("NOT_EXECUTED", "Repository builds could not be listed."); }
        var matching = artifacts.Where(a => Same(a["metadata"]?["build"]?["source"] as JsonObject, source)).ToList();
        if (matching.Count == 0) {
            try {
                foreach (var artifact in artifacts.Where(a => a["metadata"]?["build"]?["source"]?["path"]?.GetValue<string>() == S(source, "path") && a["metadata"]?["kind"]?.GetValue<string>() is "compiled_opt14" or "compiled_opt2"))
                    matching.AddRange(repository.History(project, S(artifact, "path")).OfType<JsonObject>().Where(a => S(a, "status") != "DELETED" && Same(a["metadata"]?["build"]?["source"] as JsonObject, source)));
            } catch (ProcessingException) { return Result("NOT_EXECUTED", "Historical build evidence could not be read."); }
        }
        foreach (var artifact in matching) {
            try {
                var build = artifact["metadata"]!["build"] as JsonObject ?? throw new ProcessingException("BUILD_EVIDENCE_INVALID");
                VerifyBuild(project, artifact, build, source);
                verified.Add(new JsonObject { ["artifact"] = TemplateAuthoring.Reference(artifact), ["kind"] = artifact["metadata"]!["kind"]!.DeepClone(), ["format"] = build["format"]!.DeepClone(), ["profile"] = build["report"]!["profile"]!.DeepClone(), ["engine"] = build["engine"]!.DeepClone(), ["dependencies"] = ((JsonArray)build["dependencies"]!).Count, ["checks"] = build["report"]!["checks"]!.DeepClone(), ["limitations"] = build["report"]!["limitations"]!.DeepClone() });
            } catch (Exception e) when (e is ProcessingException or InvalidOperationException or FormatException or ArgumentException or NullReferenceException) { invalid.Add(S(artifact, "path")); }
        }
        return invalid.Count > 0 ? Result("FAIL", "A matching saved build failed integrity verification.") : verified.Count > 0 ? Result("PASS", null) : Result("NOT_EXECUTED", "No saved compiler build names this exact source revision.");
    }
    private void VerifyBuild(string project, JsonObject artifact, JsonObject build, JsonObject source)
    {
        void Require(bool pass) { if (!pass) throw new ProcessingException("BUILD_EVIDENCE_INVALID"); }
        var report = build["report"] as JsonObject ?? throw new ProcessingException("BUILD_EVIDENCE_INVALID");
        var kind = artifact["metadata"]?["kind"]?.GetValue<string>(); var format = S(build, "format");
        Require(artifact["content"]?.GetValueKind() == System.Text.Json.JsonValueKind.String && Data.Hash(S(artifact, "content")) == S(artifact, "sha256") && S(build, "output_sha256") == S(artifact, "sha256"));
        Require(kind is "compiled_opt14" or "compiled_opt2" && format is "opt14_xml" or "opt2_adl" && (kind == "compiled_opt14") == (format == "opt14_xml"));
        Require(S(artifact, "status") == "DRAFT" && (S(artifact, "path").StartsWith("templates/compiled/", StringComparison.Ordinal) || S(artifact, "path").StartsWith("templates/opt/", StringComparison.Ordinal)));
        Require(build["schema"]?.GetValue<int>() == 1 && S(build, "project") == project && Same(build["source"] as JsonObject, source));
        Require(S(report, "operation") == "compile/template" && report["valid"]?.GetValue<bool>() == true && S(report, "status") == "PASS" && S(report, "content_sha256") == S(source, "sha256") && Data.Canonical(build["engine"]) == Data.Canonical(report["engine"]) && build["engine"] is JsonObject && report["checks"] is JsonArray && report["limitations"] is JsonArray);
        Require(S(report, "profile") == (format == "opt14_xml" ? "OET14_COMPILATION_RM_STRUCTURE" : "ADL2_AOM2_BMM"));
        var dependencies = build["dependencies"] as JsonArray ?? throw new ProcessingException("BUILD_DEPENDENCY_MANIFEST_INVALID");
        var reported = report["dependencies"] as JsonArray ?? throw new ProcessingException("BUILD_DEPENDENCY_MANIFEST_INVALID");
        Require(dependencies.Count <= 64 && reported.Count == dependencies.Count);
        var manifest = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in dependencies) {
            var pin = item as JsonObject ?? throw new ProcessingException("BUILD_DEPENDENCY_MANIFEST_INVALID");
            var identifier = Data.Required(pin, "identifier"); Require(manifest.TryAdd(identifier, Data.Required(pin, "sha256")));
            var pinned = repository.Artifact(project, Data.Required(pin, "path"), Data.Required(pin, "revision"));
            Require(pinned["content"]?.GetValueKind() == System.Text.Json.JsonValueKind.String && S(pinned, "sha256") == S(pin, "sha256") && Data.Hash(S(pinned, "content")) == S(pin, "sha256"));
        }
        var actual = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in reported) {
            var pin = item as JsonObject ?? throw new ProcessingException("BUILD_DEPENDENCY_MANIFEST_INVALID");
            Require(actual.TryAdd(Data.Required(pin, "identifier"), Data.Required(pin, "sha256")));
        }
        Require(manifest.SequenceEqual(actual));
        var identity = new JsonObject { ["schema"] = 1, ["project"] = project, ["source"] = build["source"]!.DeepClone(), ["dependencies"] = dependencies.DeepClone(), ["engine"] = build["engine"]!.DeepClone(), ["output_sha256"] = build["output_sha256"]!.DeepClone() };
        var canonical = Data.Canonical(identity);
        // Preserve both the previous serializer's canonical identity and existing .NET build records.
        Require(S(build, "id") == Data.Hash(canonical) || S(build, "id") == Data.Hash(HistoricJson.Encode(JsonNode.Parse(canonical)!, false)));
    }
}
