using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

public sealed record MappedRecord(JsonObject Output, JsonObject? Composition, List<object> Provenance, List<object> Unmapped);
public sealed class Mapping
{
    private readonly JsonObject specification;
    private readonly JsonArray stages;
    public string Direction { get; }
    public string? SourceProfileKey { get; }
    public bool ProducesFhir => Direction is not ("source-to-openehr" or "fhir-to-openehr");
    public bool ProducesOpenEhr => Direction is "source-to-openehr" or "fhir-to-openehr";
    public bool RequiresOpenEhrInput => Direction == "openehr-to-fhir";
    public bool NeedsFhirModel => Direction != "source-to-openehr";
    public bool NeedsOpenEhrModel => Direction != "source-direct-to-fhir";
    public string Reversibility => Data.Required(specification, "reversibility");
    public string SchemaHash { get; }
    public Mapping(string json) {
        if (System.Text.Encoding.UTF8.GetByteCount(json) > 1048576 || Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(json)) is not JsonObject mapping) throw new ProcessingException("MAPPING_INVALID");
        specification = mapping;
        Data.Keys(mapping, "schemaVersion", "version", "direction", "sourceSchemaSha256", "reversibility", "description", "name", "requirements", "examples", "unresolvedQuestions", "sourceSchema", "groupBy", "stages", "sourceProfileKey");
        if (mapping["schemaVersion"]?.GetValue<int>() != 2 || string.IsNullOrWhiteSpace(Data.Required(mapping, "version")) || string.IsNullOrWhiteSpace(Data.Required(mapping, "description"))) throw new ProcessingException("MAPPING_VERSION_REQUIRED");
        SourceProfileKey = mapping["sourceProfileKey"]?.GetValue<string>();
        if (SourceProfileKey is not null && !Regex.IsMatch(SourceProfileKey, "^[a-f0-9]{64}$")) throw new ProcessingException("SOURCE_PROFILE_KEY_REQUIRED");
        Direction = Data.Required(mapping, "direction"); SchemaHash = Data.Required(mapping, "sourceSchemaSha256");
        if (Direction is not ("source-to-fhir" or "source-direct-to-fhir" or "fhir-to-openehr" or "source-to-openehr" or "openehr-to-fhir") || !Regex.IsMatch(SchemaHash, "^[a-f0-9]{64}$") || mapping["reversibility"]?.GetValue<string>() is not ("lossless-within-scope" or "retained-context" or "lossy")) throw new ProcessingException("MAPPING_SCOPE_REQUIRED");
        if (mapping["requirements"] is not JsonArray requirements || requirements.Count is < 1 or > 100) throw new ProcessingException("NARRATIVE_REQUIREMENTS_REQUIRED");
        foreach (var node in requirements) {
            if (node is not JsonObject requirement) throw new ProcessingException("REQUIREMENT_INVALID");
            Data.Keys(requirement, "id", "originalText", "basis");
            if (string.IsNullOrWhiteSpace(Data.Required(requirement, "id")) || string.IsNullOrWhiteSpace(Data.Required(requirement, "originalText")) || requirement["basis"]?.GetValue<string>() is not ("user-instruction" or "declared-fact" or "inferred-proposal")) throw new ProcessingException("REQUIREMENT_PROVENANCE_REQUIRED");
        }
        if (mapping["unresolvedQuestions"] is not JsonArray unresolved || unresolved.Any(q => q?.GetValueKind() != System.Text.Json.JsonValueKind.String)) throw new ProcessingException("UNRESOLVED_QUESTIONS_REQUIRED");
        if (mapping["examples"] is not JsonArray examples || examples.Count is < 1 or > 20) throw new ProcessingException("SYNTHETIC_EXAMPLES_REQUIRED");
        foreach (var node in examples) {
            if (node is not JsonObject example) throw new ProcessingException("EXAMPLE_INVALID");
            Data.Keys(example, "synthetic", "input", "expected", "expectedError");
            if (example["synthetic"]?.GetValue<bool>() != true || example["input"] is not JsonObject || example.ContainsKey("expected") == example.ContainsKey("expectedError") || example["expected"] is not null && example["expected"] is not JsonArray) throw new ProcessingException("SYNTHETIC_EXAMPLE_INVALID");
        }
        stages = mapping["stages"] as JsonArray ?? throw new ProcessingException("MAPPING_STAGES_REQUIRED");
        if (stages.Count != (Direction == "source-to-fhir" ? 2 : 1)) throw new ProcessingException("MAPPING_STAGES_INVALID");
        if (mapping["groupBy"] is JsonArray groupBy) { if (groupBy.Count is < 1 or > 8) throw new ProcessingException("MAPPING_GROUP_INVALID"); foreach (var path in groupBy) Tokens(path!.GetValue<string>()); }
        foreach (var item in stages) {
            if (item is not JsonObject stage || stage["rules"] is not JsonArray rules || rules.Count is < 1 or > 256 || stage["seed"] is not JsonObject) throw new ProcessingException("MAPPING_STAGE_INVALID");
            Data.Keys(stage, "seed", "rules", "explode");
            if (stage["explode"] is not null) Tokens(stage["explode"]!.GetValue<string>());
            var targets = new List<string>();
            foreach (var node in rules) {
                if (node is not JsonObject rule) throw new ProcessingException("MAPPING_RULE_INVALID");
                Data.Keys(rule, "source", "target", "operation", "description", "interpretation", "assumptions", "missing", "null", "factor", "offset", "dictionary", "value", "condition", "namespace");
                foreach (var field in new[] {"description", "interpretation"}) if (string.IsNullOrWhiteSpace(Data.Required(rule, field))) throw new ProcessingException("MAPPING_RULE_DESCRIPTION_REQUIRED");
                if (rule["assumptions"] is not JsonArray assumptions || assumptions.Any(a => a?.GetValueKind() != System.Text.Json.JsonValueKind.String)) throw new ProcessingException("MAPPING_RULE_ASSUMPTIONS_REQUIRED");
                var operation = Data.Required(rule, "operation");
                if (Reversibility == "lossless-within-scope" && (operation is not ("copy" or "constant") || rule.ContainsKey("condition") || rule["missing"]?.GetValue<string>() != "reject" || rule["null"]?.GetValue<string>() == "omit")) throw new ProcessingException("LOSSLESS_MAPPING_REQUIRES_EXACT_COPY");
                if (operation is not ("copy" or "number" or "translate" or "constant" or "datetime-utc" or "identifier" or "reference")) throw new ProcessingException("MAPPING_OPERATION_UNSUPPORTED");
                if (operation != "constant") Tokens(Data.Required(rule, "source"));
                if (rule["missing"]?.GetValue<string>() is not ("reject" or "omit") || rule["null"]?.GetValue<string>() is not ("reject" or "omit" or "preserve")) throw new ProcessingException("MAPPING_MISSING_POLICY_REQUIRED");
                var target = Data.Required(rule, "target"); Tokens(target);
                if (targets.Any(p => p == target || p.StartsWith(target + '/', StringComparison.Ordinal) || target.StartsWith(p + '/', StringComparison.Ordinal))) throw new ProcessingException("MAPPING_TARGET_OVERLAP");
                targets.Add(target);
                if (operation == "constant" && !rule.ContainsKey("value")) throw new ProcessingException("MAPPING_CONSTANT_REQUIRED");
                if (operation == "translate" && rule["dictionary"] is not JsonObject) throw new ProcessingException("MAPPING_DICTIONARY_REQUIRED");
                if (operation == "number") { _ = Decimal(rule["factor"] ?? JsonValue.Create(1)!); _ = Decimal(rule["offset"] ?? JsonValue.Create(0)!); }
                if (operation is "identifier" or "reference") _ = Data.Required(rule, "namespace");
                if (rule["condition"] is JsonObject condition) { Data.Keys(condition, "source", "equals", "exists"); Tokens(Data.Required(condition, "source")); if (condition.ContainsKey("equals") == condition.ContainsKey("exists")) throw new ProcessingException("MAPPING_CONDITION_INVALID"); }
                else if (rule["condition"] is not null) throw new ProcessingException("MAPPING_CONDITION_INVALID");
            }
        }
    }
    public void VerifySource(List<JsonObject> records) {
        if (specification["sourceSchema"] is not JsonArray declared) {
            if (SchemaHash != Sources.SchemaHash(records)) throw new ProcessingException("SOURCE_SCHEMA_CHANGED"); return;
        }
        if (Data.Hash(Data.Canonical(declared)) != SchemaHash || declared.Count > 256) throw new ProcessingException("DECLARED_SCHEMA_HASH_INVALID");
        if (declared.Any(f => f is not JsonObject) || declared.OfType<JsonObject>().Select(f => Data.Required(f, "path")).Distinct(StringComparer.Ordinal).Count() != declared.Count) throw new ProcessingException("DECLARED_SCHEMA_INVALID");
        var expected = declared.OfType<JsonObject>().ToDictionary(f => Data.Required(f, "path"), StringComparer.Ordinal);
        foreach (var field in Sources.Schema(records).OfType<JsonObject>()) {
            var path = Data.Required(field, "path");
            if (!expected.TryGetValue(path, out var definition) || definition["types"] is not JsonArray types || ((JsonArray)field["types"]!).Any(t => t!.GetValue<string>() != "null" && !types.Any(e => e!.GetValue<string>() == t.GetValue<string>()))) throw new ProcessingException("SOURCE_SCHEMA_CHANGED");
        }
    }
    public void VerifyExamples() {
        if (((JsonArray)specification["unresolvedQuestions"]!).Count > 0) throw new ProcessingException("MAPPING_UNRESOLVED");
        foreach (var example in ((JsonArray)specification["examples"]!).OfType<JsonObject>()) {
            JsonArray outputs;
            try { outputs = new JsonArray(Transform((JsonObject)example["input"]!).Select(r => (JsonNode)r.Output).ToArray()); }
            catch (ProcessingException error) {
                if (error.Code.StartsWith("RECORD_", StringComparison.Ordinal) && example["expectedError"]?.GetValue<string>() == error.Code) continue;
                throw new ProcessingException("MAPPING_EXAMPLE_MISMATCH");
            }
            if (example.ContainsKey("expectedError") || !JsonNode.DeepEquals(outputs, example["expected"])) throw new ProcessingException("MAPPING_EXAMPLE_MISMATCH");
        }
    }
    public List<(JsonObject Record, int SourceCount)> Group(List<JsonObject> records) {
        if (specification["groupBy"] is not JsonArray paths) return records.Select(r => (r, 1)).ToList();
        return records.GroupBy(record => Data.Canonical(new JsonArray(paths.Select(path => {
            var value = Get(record, path!.GetValue<string>()); if (!value.Present || value.Value is null) throw new ProcessingException("GROUP_KEY_REQUIRED"); return value.Value.DeepClone();
        }).ToArray())), StringComparer.Ordinal).Select(group => (new JsonObject { ["_group"] = new JsonObject { ["key"] = JsonNode.Parse(group.Key), ["records"] = new JsonArray(group.Select(r => r.DeepClone()).ToArray()) } }, group.Count())).ToList();
    }
    public List<MappedRecord> Transform(JsonObject record) {
        var pending = new List<MappedRecord> { new(record, null, [], []) };
        for (var stageNumber = 0; stageNumber < stages.Count; stageNumber++) {
            var stage = (JsonObject)stages[stageNumber]!; var next = new List<MappedRecord>(); var stageBytes = 0;
            foreach (var previous in pending) {
                IEnumerable<JsonObject> inputs = [previous.Output];
                if (stage["explode"] is JsonNode explode) {
                    var found = Get(previous.Output, explode.GetValue<string>());
                    if (!found.Present || found.Value is not JsonArray array || array.Count is < 1 or > 100) throw new ProcessingException("RECORD_EXPLODE_INVALID");
                    inputs = array.Select((item, index) => new JsonObject { ["parent"] = previous.Output.DeepClone(), ["item"] = item?.DeepClone(), ["index"] = index });
                }
                foreach (var input in inputs) {
                    var output = (JsonObject)stage["seed"]!.DeepClone(); var used = new List<string>();
                    var provenance = new List<object>(previous.Provenance); var unmapped = new List<object>(previous.Unmapped);
                    foreach (var ruleNode in (JsonArray)stage["rules"]!) {
                        var rule = (JsonObject)ruleNode!;
                        if (rule["condition"] is JsonObject condition) {
                            var test = Get(input, Data.Required(condition, "source"));
                            if (condition.ContainsKey("exists") ? test.Present != condition["exists"]!.GetValue<bool>() : !test.Present || !JsonNode.DeepEquals(test.Value, condition["equals"])) continue;
                        }
                        var operation = Data.Required(rule, "operation"); var source = rule["source"]?.GetValue<string>() ?? "";
                        var found = operation == "constant" ? (true, rule["value"]) : Get(input, source);
                        if (!found.Item1 || found.Item2 is null) {
                            var policy = rule[!found.Item1 ? "missing" : "null"]!.GetValue<string>();
                            if (policy == "reject") throw new ProcessingException("RECORD_REQUIRED");
                            if (policy == "omit") continue;
                        }
                        var value = found.Item2?.DeepClone();
                        if (value is not null) value = operation switch {
                            "number" => JsonValue.Create(ExactNumber.Convert(Decimal(value), Decimal(rule["factor"] ?? JsonValue.Create(1)!), Decimal(rule["offset"] ?? JsonValue.Create(0)!))),
                            "translate" => Translate((JsonObject)rule["dictionary"]!, value),
                            "datetime-utc" => DateTime(value),
                            "identifier" => Identifier(Data.Required(rule, "namespace"), value),
                            "reference" => Reference(Data.Required(rule, "namespace"), value),
                            _ => value
                        };
                        Put(output, Data.Required(rule, "target"), value);
                        if (source.Length > 0) used.Add(source);
                        provenance.Add(new { stage = stageNumber, source, target = Data.Required(rule, "target"), operation });
                    }
                    foreach (var path in Sources.Fields(input).Keys) if (!used.Any(p => path == p || path.StartsWith(p + '/', StringComparison.Ordinal))) unmapped.Add(new { stage = stageNumber, path, reason = "no-rule" });
                    var outputBytes = System.Text.Encoding.UTF8.GetByteCount(output.ToJsonString());
                    if (outputBytes > 2097152) throw new ProcessingException("RECORD_OUTPUT_LIMIT");
                    stageBytes += outputBytes; if (stageBytes > 8388608) throw new ProcessingException("RECORD_EXPANSION_LIMIT");
                    var composition = Direction == "source-to-fhir" && stageNumber == 0 ? output : previous.Composition;
                    next.Add(new(output, composition, provenance, unmapped));
                    if (next.Count > 100) throw new ProcessingException("RECORD_EXPANSION_LIMIT");
                }
            }
            pending = next;
        }
        if (specification["reversibility"]!.GetValue<string>() == "lossless-within-scope" && pending.Any(p => p.Unmapped.Count > 0)) throw new ProcessingException("RECORD_UNMAPPED_LOSSLESS_CLAIM");
        return pending;
    }
    private static decimal Decimal(JsonNode value) => ExactNumber.Parse(value.GetValueKind() == System.Text.Json.JsonValueKind.String ? value.GetValue<string>() : value.ToJsonString());
    private static JsonNode? Translate(JsonObject dictionary, JsonNode value) {
        var key = value.GetValueKind() == System.Text.Json.JsonValueKind.String ? value.GetValue<string>() : value.ToJsonString();
        return dictionary.TryGetPropertyValue(key, out var result) ? result?.DeepClone() : throw new ProcessingException("RECORD_TERMINOLOGY");
    }
    private static JsonNode DateTime(JsonNode value) {
        if (value.GetValueKind() != System.Text.Json.JsonValueKind.String) throw new ProcessingException("RECORD_TIMEZONE_REQUIRED");
        var text = value.GetValue<string>();
        if (!Regex.IsMatch(text, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,7})?(?:Z|[+-][0-9]{2}:[0-9]{2})$", RegexOptions.CultureInvariant) || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var result)) throw new ProcessingException("RECORD_TIMEZONE_REQUIRED");
        return JsonValue.Create(result.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture))!;
    }
    private static JsonNode Identifier(string scope, JsonNode value) {
        if (value.GetValueKind() != System.Text.Json.JsonValueKind.String) throw new ProcessingException("RECORD_IDENTIFIER_STRING_REQUIRED");
        return JsonValue.Create(Data.Hash(scope + "\n" + value.GetValue<string>()))!;
    }
    private static JsonNode Reference(string resourceType, JsonNode value) {
        if (value.GetValueKind() != System.Text.Json.JsonValueKind.String) throw new ProcessingException("RECORD_REFERENCE_INVALID");
        var id = value.GetValue<string>();
        if (!Regex.IsMatch(resourceType, "^[A-Z][A-Za-z0-9]{1,63}$") || !Regex.IsMatch(id, "^[A-Za-z0-9.-]{1,64}$")) throw new ProcessingException("RECORD_REFERENCE_INVALID");
        return JsonValue.Create(resourceType + "/" + id)!;
    }
    private static string[] Tokens(string path) {
        if (!path.StartsWith('/') || path.Length > 512 || Regex.IsMatch(path, "~(?![01])")) throw new ProcessingException("MAPPING_PATH_INVALID");
        var parts = path[1..].Split('/').Select(p => p.Replace("~1", "/").Replace("~0", "~")).ToArray();
        if (parts.Length > 32 || parts.Any(p => p is "" or "__proto__" or "prototype" or "constructor" || p.All(char.IsDigit) && (!int.TryParse(p, out var index) || index > 1023 || p.Length > 1 && p[0] == '0'))) throw new ProcessingException("MAPPING_PATH_INVALID");
        return parts;
    }
    public static (bool Present, JsonNode? Value) Get(JsonNode record, string path) {
        JsonNode? current = record;
        foreach (var part in Tokens(path)) {
            if (current is JsonObject obj) { if (!obj.TryGetPropertyValue(part, out current)) return (false, null); }
            else if (current is JsonArray array && int.TryParse(part, out var index) && index < array.Count) current = array[index];
            else return (false, null);
        }
        return (true, current);
    }
    private static void Put(JsonObject record, string path, JsonNode? value) {
        var parts = Tokens(path); JsonNode current = record;
        for (var i = 0; i < parts.Length; i++) {
            var last = i == parts.Length - 1;
            JsonNode? next = last ? value?.DeepClone() : int.TryParse(parts[i + 1], out _) ? new JsonArray() : new JsonObject();
            if (current is JsonObject obj) {
                if (last) { obj[parts[i]] = next; return; }
                if (obj[parts[i]] is null) obj[parts[i]] = next;
                current = obj[parts[i]]!;
            } else if (current is JsonArray array && int.TryParse(parts[i], out var index)) {
                while (array.Count <= index) array.Add(null);
                if (last) { array[index] = next; return; }
                if (array[index] is null) array[index] = next;
                current = array[index]!;
            } else throw new ProcessingException("MAPPING_TARGET_TYPE_CONFLICT");
        }
    }
}
