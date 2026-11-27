using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Xml;

namespace Modeller.Core;

public sealed record ModelActor(string Id, string Owner, bool Human, string[] Roles, string[] Scopes)
{
    public static ModelActor Service => new("mcp-service", "shared", false, [], []);
    public bool Administrator => Human && Roles.Contains("modelling-administrator", StringComparer.Ordinal);
    public void Project(string project, bool write = false) {
        if (!Human) return;
        if (Administrator || Scopes.Contains("projects:admin", StringComparer.Ordinal) || Scopes.Contains("project:" + project + (write ? ":write" : ":read"), StringComparer.Ordinal)
            || !write && Scopes.Contains("project:" + project + ":write", StringComparer.Ordinal)) return;
        throw new ProcessingException("PROJECT_PERMISSION_REQUIRED");
    }
    public void Decision(string project) {
        if (!Human || !Roles.Intersect(["modelling-administrator", "modelling-modeller", "modelling-reviewer", "modelling-approver"], StringComparer.Ordinal).Any()) throw new ProcessingException("HUMAN_MAPPING_REVIEW_REQUIRED");
        Project(project, true);
    }
}

/** Content-addressed model/rule revisions. Records and job files never belong here. */
public sealed partial class ModelStore
{
    private readonly string root;
    private readonly Dictionary<string, string> keys;
    private readonly string activeKey;
    public ModelStore(string root, Dictionary<string, string> approvalKeys, string activeKey) {
        if (!Path.IsPathFullyQualified(root) || !approvalKeys.TryGetValue(activeKey, out var secret) || secret.Length < 32 || approvalKeys.Count > 8 || approvalKeys.Values.Any(v => v.Length < 32)) throw new ProcessingException("MODEL_STORE_CONFIGURATION_REQUIRED");
        this.root = root; keys = approvalKeys; this.activeKey = activeKey;
        Directory.CreateDirectory(root);
        if (new DirectoryInfo(root).LinkTarget is not null) throw new ProcessingException("MODEL_STORE_LINK_REJECTED");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        foreach (var name in new[] {"projects", "models", "definitions", "mappingVersions", "events", "nonces"}) Directory.CreateDirectory(Path.Combine(root, name));
    }
    private static void Id(string id) { if (!Regex.IsMatch(id, "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$") || id.Contains("..", StringComparison.Ordinal)) throw new ProcessingException("IDENTIFIER_INVALID"); }
    private static void Hash(string value) { if (!Regex.IsMatch(value, "^[a-f0-9]{64}$")) throw new ProcessingException("HASH_INVALID"); }
    private string PathFor(string area, string id) => Path.Combine(root, area, id + ".json");
    private JsonObject Read(string area, string id) => Data.Read<JsonObject>(PathFor(area, id), 8 * 1048576);
    private static string Hmac(string key, string value) => Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(value)));
    private void Immutable(string area, string id, JsonObject value) {
        if (Directory.EnumerateFiles(Path.Combine(root, area), "*.json").Take(2001).Count() > 2000) throw new ProcessingException("MODEL_STORE_LIMIT");
        var file = PathFor(area, id); var bytes = Encoding.UTF8.GetBytes(value.ToJsonString());
        if (File.Exists(file)) { if (Data.Canonical(Read(area, id)) != Data.Canonical(value)) throw new ProcessingException("VERSION_IMMUTABLE"); return; }
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { stream.Write(bytes); stream.Flush(true); }
        try { File.Move(temporary, file, false); }
        catch (IOException) when (File.Exists(file)) { if (Data.Canonical(Read(area, id)) != Data.Canonical(value)) throw new ProcessingException("VERSION_IMMUTABLE"); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public JsonObject CreateProject(string id, JsonObject configuration, ModelActor actor) {
        Id(id); actor.Project(id, true);
        Data.Keys(configuration, "name", "fhirVersion", "canonical", "packageId", "version", "publisher", "dependencies", "jurisdiction");
        var release = Data.Required(configuration, "fhirVersion");
        release = release switch { "R4" => "4.0.1", "R4B" => "4.3.0", "R5" => "5.0.0", _ => release };
        if (release is not ("4.0.1" or "4.3.0" or "5.0.0")) throw new ProcessingException("FHIR_RELEASE_UNSUPPORTED");
        foreach (var field in new[] {"name", "publisher"}) if (Data.Required(configuration, field).Length > 200) throw new ProcessingException("PROJECT_FIELD_LIMIT");
        Canonical(Data.Required(configuration, "canonical")); Version(Data.Required(configuration, "version"));
        if (!Regex.IsMatch(Data.Required(configuration, "packageId"), "^[a-z0-9][a-z0-9._-]{1,150}$")) throw new ProcessingException("PACKAGE_ID_INVALID");
        var dependencies = configuration["dependencies"] as JsonArray ?? new JsonArray();
        if (dependencies.Count > 50) throw new ProcessingException("DEPENDENCY_LIMIT");
        foreach (var item in dependencies.OfType<JsonObject>()) { Data.Keys(item, "id", "version"); Version(Data.Required(item, "version")); if (!Regex.IsMatch(Data.Required(item, "id"), "^[a-z0-9][a-z0-9._-]{1,150}$")) throw new ProcessingException("PACKAGE_ID_INVALID"); }
        if (dependencies.Any(d => d is not JsonObject)) throw new ProcessingException("DEPENDENCY_INVALID");
        var project = (JsonObject)configuration.DeepClone(); project["id"] = id; project["fhirVersion"] = release; project["dependencies"] = dependencies.DeepClone();
        Immutable("projects", id, project); return project;
    }
    public JsonObject GetProject(string id, ModelActor actor) { Id(id); actor.Project(id); return Read("projects", id); }
    public JsonArray Projects(ModelActor actor) {
        var result = new JsonArray(); foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "projects"), "*.json").Order(StringComparer.Ordinal)) {
            try { result.Add(GetProject(Path.GetFileNameWithoutExtension(file), actor)); } catch (ProcessingException e) when (e.Code == "PROJECT_PERMISSION_REQUIRED") { }
        }
        return result;
    }
    private static void Version(string version) { if (!Regex.IsMatch(version, "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")) throw new ProcessingException("EXACT_VERSION_REQUIRED"); }
    private static void Canonical(string canonical) { if (canonical.Length > 2000 || !Uri.TryCreate(canonical, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https" or "urn") || uri.UserInfo.Length > 0 || canonical.Any(char.IsWhiteSpace)) throw new ProcessingException("CANONICAL_INVALID"); }
    public JsonObject ProvideModel(string projectId, JsonObject input, ModelActor actor) {
        var project = GetProject(projectId, actor); actor.Project(projectId, true);
        Data.Keys(input, "id", "standard", "version", "origin", "content", "provenance");
        var id = Data.Required(input, "id"); Id(id); var version = Data.Required(input, "version");
        if (version.Length > 100 || version.Any(char.IsWhiteSpace) || version.Any(char.IsControl) || version.IndexOfAny(['|', '"', '\'', '<', '>', '\\']) >= 0 || version == "*") throw new ProcessingException("MODEL_VERSION_INVALID");
        var standard = Data.Required(input, "standard"); var content = Data.Required(input, "content"); var origin = Data.Required(input, "origin");
        if (Encoding.UTF8.GetByteCount(content) > 2097152 || origin is not ("externally-provided" or "agent-modelled") || standard is not ("FHIR" or "openEHR")) throw new ProcessingException("MODEL_INPUT_INVALID");
        if (standard == "FHIR") {
            var resource = Data.ParseStrict(Encoding.UTF8.GetBytes(content)) as JsonObject ?? throw new ProcessingException("STRUCTURE_DEFINITION_REQUIRED");
            if (resource["resourceType"]?.GetValue<string>() != "StructureDefinition" || (resource["version"]?.GetValue<string>() ?? "sha256-" + Data.Hash(content)) != version) throw new ProcessingException("STRUCTURE_DEFINITION_VERSION_REQUIRED");
            Canonical(Data.Required(resource, "url")); _ = Data.Required(resource, "type");
            var declared = resource["fhirVersion"]?.GetValue<string>();
            if (declared is not null && declared != project["fhirVersion"]?.GetValue<string>() && !(declared == "4.0.0" && project["fhirVersion"]?.GetValue<string>() == "4.0.1")) throw new ProcessingException("MODEL_RELEASE_MISMATCH");
        } else {
            using var reader = XmlReader.Create(new StringReader(content), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 2097152 });
            while (reader.Read()) if (reader.Depth > 64) throw new ProcessingException("MODEL_DEPTH_LIMIT");
        }
        var provenance = input["provenance"] as JsonObject ?? throw new ProcessingException("MODEL_PROVENANCE_REQUIRED");
        if (provenance.Count == 0 || provenance.ToJsonString().Length > 8192) throw new ProcessingException("MODEL_PROVENANCE_REQUIRED");
        var modelKey = Data.Hash(projectId + "\n" + standard + "\n" + id + "\n" + version);
        var model = (JsonObject)input.DeepClone(); model["projectId"] = projectId; model["key"] = modelKey; model["sha256"] = Data.Hash(content); model["clinicalApproval"] = false; model["technicalValidation"] = "NOT_EXECUTED";
        Immutable("models", modelKey, model); return model;
    }
    public JsonObject GetModel(string key, ModelActor actor) { Hash(key); var model = Read("models", key); actor.Project(Data.Required(model, "projectId")); if (Data.Hash(Data.Required(model, "projectId") + "\n" + Data.Required(model, "standard") + "\n" + Data.Required(model, "id") + "\n" + Data.Required(model, "version")) != key || Data.Hash(Data.Required(model, "content")) != model["sha256"]?.GetValue<string>()) throw new ProcessingException("MODEL_INTEGRITY_FAILED"); return model; }
    public JsonArray Models(string project, ModelActor actor) {
        _ = GetProject(project, actor); var result = new JsonArray();
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "models"), "*.json").Order(StringComparer.Ordinal)) {
            var model = Read("models", Path.GetFileNameWithoutExtension(file)); if (model["projectId"]?.GetValue<string>() != project) continue;
            model.Remove("content"); result.Add(model);
        }
        return result;
    }
    public JsonObject Prepare(string projectId, JsonObject input, ModelActor actor) {
        var project = GetProject(projectId, actor); actor.Project(projectId, true);
        Data.Keys(input, "modelKeys", "executionMapping", "reuseContext");
        var mappingText = Data.Required(input, "executionMapping"); var mapping = new Mapping(mappingText);
        var selected = input["modelKeys"] as JsonArray ?? throw new ProcessingException("MODELS_REQUIRED");
        if (selected.Count is < 1 or > 20 || selected.Any(s => s?.GetValueKind() != System.Text.Json.JsonValueKind.String)) throw new ProcessingException("MODELS_REQUIRED");
        var modelKeys = selected.Select(s => s!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray();
        if (modelKeys.Distinct().Count() != modelKeys.Length) throw new ProcessingException("DUPLICATE_MODEL");
        var standards = new List<string>(); var bytes = 0; var modelPins = new JsonArray(); var canonicals = new HashSet<string>(StringComparer.Ordinal);
        foreach (var key in modelKeys) {
            var model = GetModel(key, actor); if (model["projectId"]?.GetValue<string>() != projectId) throw new ProcessingException("MODEL_PROJECT_MISMATCH");
            if (model["standard"]?.GetValue<string>() == "FHIR") {
                var profile = (JsonObject)JsonNode.Parse(Data.Required(model, "content"))!;
                if (!canonicals.Add(Data.Required(profile, "url") + "|" + profile["version"]?.GetValue<string>())) throw new ProcessingException("MODELS_CANONICAL_CONFLICT");
            }
            modelPins.Add(new JsonObject { ["key"] = model["key"]!.DeepClone(), ["sha256"] = model["sha256"]!.DeepClone(), ["version"] = model["version"]!.DeepClone(), ["standard"] = model["standard"]!.DeepClone(), ["origin"] = model["origin"]!.DeepClone() });
            standards.Add(Data.Required(model, "standard")); bytes += Encoding.UTF8.GetByteCount(Data.Required(model, "content"));
        }
        if (bytes > 4194304 || !standards.Contains("FHIR", StringComparer.Ordinal) || mapping.Direction != "source-direct-to-fhir" && !standards.Contains("openEHR", StringComparer.Ordinal)
            || mapping.Direction == "source-direct-to-fhir" && standards.Contains("openEHR", StringComparer.Ordinal)) throw new ProcessingException("PIPELINE_MODELS_INVALID");
        var definition = new JsonObject { ["project"] = projectId, ["projectConfiguration"] = project.DeepClone(), ["modelKeys"] = new JsonArray(modelKeys.Select(k => (JsonNode)JsonValue.Create(k)!).ToArray()), ["modelPins"] = modelPins, ["executionMapping"] = mappingText, ["mappingSha256"] = Data.Hash(mappingText), ["direction"] = mapping.Direction };
        var mappingDocument = JsonNode.Parse(mappingText) as JsonObject ?? throw new ProcessingException("MAPPING_INVALID");
        if (input["reuseContext"] is JsonObject reuse) definition["reuseContext"] = ReuseContext(reuse,mapping.SchemaHash,mappingDocument["requirements"] as JsonArray ?? throw new ProcessingException("NARRATIVE_REQUIREMENTS_REQUIRED"));
        else if (input.ContainsKey("reuseContext")) throw new ProcessingException("REUSE_CONTEXT_REQUIRED");
        var mappingName = Data.Required(mappingDocument, "name"); Id(mappingName); Version(Data.Required(mappingDocument, "version"));
        var versionKey = Data.Hash(projectId + "\n" + mappingName + "\n" + Data.Required(mappingDocument, "version"));
        definition["versionKey"] = versionKey;
        var subject = Data.Hash(Data.Canonical(definition)); definition["subject"] = subject;
        using var mutex = new FileStream(Path.Combine(root, ".definition-lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        if (File.Exists(PathFor("mappingVersions", versionKey)) && Read("mappingVersions", versionKey)["subject"]?.GetValue<string>() != subject) throw new ProcessingException("MAPPING_VERSION_IMMUTABLE");
        Immutable("definitions", subject, definition);
        Immutable("mappingVersions", versionKey, new JsonObject { ["subject"] = subject }); return GetDefinition(subject, actor);
    }
    public JsonObject GetDefinition(string subject, ModelActor actor) {
        Hash(subject); var definition = Read("definitions", subject); actor.Project(Data.Required(definition, "project"));
        var identity = (JsonObject)definition.DeepClone(); identity.Remove("subject");
        if (Data.Hash(Data.Canonical(identity)) != subject || Data.Hash(Data.Required(definition, "executionMapping")) != definition["mappingSha256"]?.GetValue<string>()) throw new ProcessingException("MAPPING_INTEGRITY_FAILED");
        var events = Events(subject); var last = events.LastOrDefault() as JsonObject;
        var items = new JsonArray();
        foreach (var key in (JsonArray)definition["modelKeys"]!) {
            var model = GetModel(key!.GetValue<string>(), actor);
            var expected = ((JsonArray)definition["modelPins"]!).OfType<JsonObject>().Single(p => p["key"]!.GetValue<string>() == key.GetValue<string>());
            foreach (var field in new[] {"sha256", "version", "standard", "origin"}) if (!JsonNode.DeepEquals(expected[field], model[field])) throw new ProcessingException("MODEL_CHANGED");
            var pin = (JsonObject)model.DeepClone(); pin.Remove("content");
            items.Add(new JsonObject { ["pin"] = pin, ["content"] = model["content"]!.DeepClone(), ["current"] = true });
        }
        definition["items"] = items; definition["events"] = new JsonArray(events.TakeLast(20).Select(e => e!.DeepClone()).ToArray()); definition["sequence"] = events.Count; definition["state"] = last?["decision"]?.GetValue<string>() ?? "PENDING";
        definition["current"] = true; definition["mappingConfirmed"] = last?["decision"]?.GetValue<string>() == "CONFIRMED";
        definition["clinicalApproval"] = false; return definition;
    }
    public JsonArray Definitions(string project, ModelActor actor) {
        _ = GetProject(project, actor); var result = new JsonArray();
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "definitions"), "*.json").Order(StringComparer.Ordinal)) {
            var definition = Read("definitions", Path.GetFileNameWithoutExtension(file)); if (definition["project"]?.GetValue<string>() != project) continue;
            var view = GetDefinition(Data.Required(definition, "subject"), actor); var mapping = JsonNode.Parse(Data.Required(view, "executionMapping"))!;
            result.Add(new JsonObject { ["subject"] = view["subject"]!.DeepClone(), ["mappingSha256"] = view["mappingSha256"]!.DeepClone(), ["name"] = mapping["name"]?.DeepClone() ?? mapping["description"]?.DeepClone(), ["version"] = mapping["version"]!.DeepClone(), ["direction"] = view["direction"]!.DeepClone(), ["state"] = view["state"]!.DeepClone(), ["mappingConfirmed"] = view["mappingConfirmed"]!.DeepClone() });
        }
        return result;
    }
    private JsonArray Events(string subject) {
        var directory = Path.Combine(root, "events", subject); var result = new JsonArray(); if (!Directory.Exists(directory)) return result;
        var previous = new string('0', 64);
        foreach (var file in Directory.EnumerateFiles(directory, "*.json").Order(StringComparer.Ordinal)) {
            var item = Data.Read<JsonObject>(file, 32768); var signature = Data.Required(item, "signature"); var hash = Data.Required(item, "hash"); var keyId = Data.Required(item, "keyId");
            var value = (JsonObject)item.DeepClone(); value.Remove("signature"); value.Remove("hash");
            if (!keys.TryGetValue(keyId, out var key) || value["subject"]?.GetValue<string>() != subject || value["sequence"]?.GetValue<int>() != result.Count + 1
                || value["previousHash"]?.GetValue<string>() != previous || Data.Hash(Data.Canonical(value)) != hash
                || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(signature), Encoding.ASCII.GetBytes(Hmac(key, "modeller-decision-v1\n" + hash)))) throw new ProcessingException("DECISION_AUDIT_INTEGRITY_FAILED");
            result.Add(item); previous = hash;
        }
        return result;
    }
    public JsonObject Decide(string subject, int expectedSequence, string decision, string comment, ModelActor actor) {
        Hash(subject); var view = GetDefinition(subject, actor); actor.Decision(Data.Required(view, "project"));
        if (decision is not ("CONFIRMED" or "REVOKED") || string.IsNullOrWhiteSpace(comment) || comment.Length > 4000 || comment.Any(c => char.IsControl(c) && c is not ('\r' or '\n' or '\t'))) throw new ProcessingException("DECISION_INVALID");
        if (Read("mappingVersions", Data.Required(view, "versionKey"))["subject"]?.GetValue<string>() != subject) throw new ProcessingException("MAPPING_VERSION_INDEX_INVALID");
        if (decision == "CONFIRMED") new Mapping(Data.Required(view, "executionMapping")).VerifyExamples();
        var directory = Path.Combine(root, "events", subject); Directory.CreateDirectory(directory);
        using var mutex = new FileStream(Path.Combine(directory, ".lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var events = Events(subject); if (events.Count != expectedSequence) throw new ProcessingException("DECISION_SEQUENCE_CONFLICT");
        if (events.Count >= 256) throw new ProcessingException("DECISION_HISTORY_LIMIT");
        var item = new JsonObject { ["subject"] = subject, ["sequence"] = events.Count + 1, ["previousHash"] = events.LastOrDefault()?["hash"]?.GetValue<string>() ?? new string('0', 64),
            ["decision"] = decision, ["actor"] = actor.Id, ["owner"] = actor.Owner, ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"), ["comment"] = comment, ["keyId"] = activeKey };
        var hash = Data.Hash(Data.Canonical(item)); item["hash"] = hash; item["signature"] = Hmac(keys[activeKey], "modeller-decision-v1\n" + hash);
        Data.Write(Path.Combine(directory, $"{events.Count + 1:D6}.json"), item); return GetDefinition(subject, actor);
    }
    public void ConsumeNonce(string nonce, long expiry) {
        Hash(nonce); var folder = Path.Combine(root, "nonces"); var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        // Bound persistent replay protection. Expired assertions cannot be accepted again.
        var entries = Directory.EnumerateFiles(folder).Take(10001).ToArray();
        if (entries.Length > 512) foreach (var entry in entries) {
            if (long.TryParse(File.ReadAllText(entry), out var recordedExpiry) && recordedExpiry < now - 5) { try { File.Delete(entry); } catch (IOException) { } }
        }
        if (Directory.EnumerateFiles(folder).Take(10001).Count() >= 10000) throw new ProcessingException("INTERACTIVE_ASSERTION_CAPACITY");
        var path = Path.Combine(folder, nonce);
        try { using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); file.Write(Encoding.ASCII.GetBytes(expiry.ToString(System.Globalization.CultureInfo.InvariantCulture))); file.Flush(true); }
        catch (IOException) when (File.Exists(path)) { throw new ProcessingException("INTERACTIVE_ASSERTION_REPLAYED"); }
    }
}
