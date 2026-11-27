using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;

var count = 0;
void Check(bool value, string code) { if (!value) throw new Exception(code); count++; }
void Reject(Action action, string? code = null) { try { action(); } catch (Exception error) { if (code is null || error is ProcessingException problem && problem.Code == code) { count++; return; } throw; } throw new Exception("Expected rejection: " + code); }
var records = Sources.Parse(Encoding.UTF8.GetBytes("id,value,unit\r\none,0,mg/dL\r\ntwo,7.2,mg/dL\r\nthree,,mg/dL\r\n"), "csv");
Check(records.Count == 3 && records[0]["value"]!.GetValue<string>() == "0" && records[2]["value"]!.GetValue<string>() == "", "CSV preserves zero and empty");
var quoted = Sources.Parse(Encoding.UTF8.GetBytes("id,text\n1,\"first\nsecond,\"\"quoted\"\"\"\n"), "csv");
Check(quoted[0]["text"]!.GetValue<string>() == "first\nsecond,\"quoted\"", "CSV quoted fields");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("a,a\n1,2"), "csv"), "SOURCE_HEADERS_INVALID");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("a,b\n1"), "csv"), "SOURCE_WIDTH_INVALID");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("a\n\"open"), "csv"), "CSV_SYNTAX");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("[{\"a\":1,\"a\":2}]"), "json"), "DUPLICATE_JSON_MEMBER");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("<!DOCTYPE x [<!ENTITY p SYSTEM 'file:///etc/passwd'>]><x><r>&p;</r></x>"), "xml"));
Check(ExactNumber.Parse("7.20") == 7.2m && ExactNumber.Convert(7.2m, .1m, 0m) == .72m, "Exact units");
Check(ExactNumber.Parse("0") == 0m && ExactNumber.Parse("1e-28") == .0000000000000000000000000001m, "Smallest exact decimal");
Reject(() => ExactNumber.Parse("1e-29"), "RECORD_NUMBER_PRECISION");
Reject(() => ExactNumber.Convert(.0000000000000000000000000001m, .1m, 0m), "RECORD_NUMBER_PRECISION");
Reject(() => ExactNumber.Parse("79228162514264337593543950336"), "RECORD_NUMBER_PRECISION");
Reject(() => ExactNumber.Parse("1,25"), "RECORD_NUMBER");
JsonObject Rule(string source, string target, string operation = "copy") => new() { ["source"] = source, ["target"] = target, ["operation"] = operation, ["description"] = "Synthetic declared rule", ["interpretation"] = "Copy/conversion at the exact declared paths", ["assumptions"] = new JsonArray(), ["missing"] = "reject", ["null"] = "reject" };
var number = Rule("/value", "/valueQuantity/value", "number"); number["factor"] = .1m;
var unit = Rule("/unit", "/valueQuantity/unit", "translate"); unit["dictionary"] = new JsonObject { ["mg/dL"] = "declared-unit" };
var plan = new JsonObject { ["schemaVersion"] = 2, ["version"] = "1.0.0", ["direction"] = "source-direct-to-fhir", ["sourceSchemaSha256"] = Sources.SchemaHash(records), ["reversibility"] = "lossy", ["description"] = "Synthetic test; not a clinical mapping", ["stages"] = new JsonArray(
    new JsonObject { ["seed"] = new JsonObject { ["resourceType"] = "Observation" }, ["rules"] = new JsonArray(number, unit, Rule("/id", "/id")) }) };
plan["name"] = "synthetic-numeric";
plan["requirements"] = new JsonArray(new JsonObject { ["id"] = "USER-1", ["originalText"] = "Convert the synthetic value by the explicitly declared factor and retain zero.", ["basis"] = "user-instruction" });
plan["unresolvedQuestions"] = new JsonArray();
plan["examples"] = new JsonArray(new JsonObject { ["synthetic"] = true, ["input"] = records[0].DeepClone(), ["expected"] = new JsonArray(new JsonObject { ["resourceType"] = "Observation", ["valueQuantity"] = new JsonObject { ["value"] = 0m, ["unit"] = "declared-unit" }, ["id"] = "one" }) });
var retired = (JsonObject)plan.DeepClone(); retired["direction"] = "source-to-fhir";
Reject(() => new Mapping(retired.ToJsonString()), "LEGACY_CHAINED_MAPPING_REVIEW_REQUIRED");
var mapping = new Mapping(plan.ToJsonString());
mapping.VerifyExamples();
var result = mapping.Transform(records[0]); Check(result[0].Output["valueQuantity"]!["value"]!.GetValue<decimal>() == 0m, "Zero retained");
Check(mapping.Transform(records[1])[0].Output["valueQuantity"]!["value"]!.GetValue<decimal>() == .72m, "Numeric transform");
Reject(() => mapping.Transform(records[2]), "RECORD_NUMBER");
var nullRecord = (JsonObject)records[0].DeepClone(); nullRecord["value"] = null; Reject(() => mapping.Transform(nullRecord), "RECORD_REQUIRED");
var missingRecord = (JsonObject)records[0].DeepClone(); missingRecord.Remove("value"); Reject(() => mapping.Transform(missingRecord), "RECORD_REQUIRED");
var badCode = (JsonObject)records[0].DeepClone(); badCode["unit"] = "unknown"; Reject(() => mapping.Transform(badCode), "RECORD_TERMINOLOGY");
Check(result[0].Provenance.Count == 3, "Field provenance covers the independent source-to-FHIR rules");
Check(Data.Canonical(mapping.Transform(records[1])[0].Output) == Data.Canonical(mapping.Transform(records[1])[0].Output), "Deterministic rerun");
var time = Rule("/time", "/normalised", "datetime-utc"); var datePlan = (JsonObject)plan.DeepClone(); datePlan["direction"] = "fhir-to-openehr"; datePlan["stages"] = new JsonArray(new JsonObject { ["seed"] = new JsonObject(), ["rules"] = new JsonArray(time) });
var dates = new Mapping(datePlan.ToJsonString());
Check(dates.Transform(new JsonObject { ["time"] = "2026-11-26T10:15:00.123+02:00" })[0].Output["normalised"]!.GetValue<string>() == "2026-11-26T08:15:00.1230000+00:00", "Timezone and instant");
Reject(() => dates.Transform(new JsonObject { ["time"] = "2026-11-26T10:15:00" }), "RECORD_TIMEZONE_REQUIRED");
var invalid = (JsonObject)plan.DeepClone(); ((JsonArray)invalid["stages"]![0]!["rules"]!).Add(Rule("/id", "/valueQuantity")); Reject(() => new Mapping(invalid.ToJsonString()), "MAPPING_TARGET_OVERLAP");
var sourceRoot = Path.Combine(Path.GetTempPath(), "processing-sources-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(sourceRoot);
try {
    File.WriteAllText(Path.Combine(sourceRoot, "fixture.csv"), "id,value\n1,0");
    var file = Sources.FileWithin(sourceRoot, "fixture.csv"); using var stream = Sources.Open(sourceRoot, file); Check(stream.Length > 0, "Scoped regular source read");
    Reject(() => Sources.FileWithin(sourceRoot, "../outside.csv"), "SOURCE_PATH_REJECTED");
    File.CreateSymbolicLink(Path.Combine(sourceRoot, "linked.csv"), "/etc/passwd"); Reject(() => Sources.FileWithin(sourceRoot, "linked.csv"), "SOURCE_LINK_REJECTED");
    Reject(() => Sources.Open(sourceRoot, Path.Combine(sourceRoot, "linked.csv")), "SOURCE_OPEN_REJECTED");
} finally { Directory.Delete(sourceRoot, true); }
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { processingUnitChecks = count, status = "PASS", clinicalConformance = "NOT_ASSESSED_BY_UNIT_TESTS" }));

var storeRoot = Path.Combine(Path.GetTempPath(), "modeller-core-" + Guid.NewGuid().ToString("N"));
var approvalKeys = new Dictionary<string, string> { ["active"] = new string('a', 64) };
try {
    var store = new ModelStore(storeRoot, approvalKeys, "active");
    var actor = new ModelActor("synthetic-human", new string('b', 64), true, ["modelling-administrator"], []);
    var project = new JsonObject { ["name"] = "Synthetic project", ["fhirVersion"] = "R4", ["canonical"] = "https://example.invalid/test", ["packageId"] = "org.example.synthetic", ["version"] = "1.0.0", ["publisher"] = "Synthetic fixture", ["dependencies"] = new JsonArray() };
    store.CreateProject("synthetic", project, actor);
    var profile = new JsonObject { ["id"] = "synthetic-profile", ["standard"] = "FHIR", ["version"] = "1.0.0", ["origin"] = "externally-provided", ["content"] = "{\"resourceType\":\"StructureDefinition\",\"url\":\"https://example.invalid/profile\",\"version\":\"1.0.0\",\"type\":\"Observation\",\"fhirVersion\":\"4.0.1\"}", ["provenance"] = new JsonObject { ["source"] = "Synthetic test fixture" } };
    var model = store.ProvideModel("synthetic", profile, actor);
    var dated = (JsonObject)profile.DeepClone(); dated["version"] = "20261126"; dated["content"] = Data.Required(profile, "content").Replace("1.0.0", "20261126");
    Check(store.ProvideModel("synthetic", dated, actor)["version"]!.GetValue<string>() == "20261126", "FHIR business versions need not be SemVer");
    var unversioned = (JsonObject)profile.DeepClone(); var unversionedContent = (JsonObject)JsonNode.Parse(Data.Required(profile, "content"))!; unversionedContent.Remove("version");
    unversioned["content"] = unversionedContent.ToJsonString(); unversioned["version"] = "sha256-" + Data.Hash(unversionedContent.ToJsonString());
    Check(store.ProvideModel("synthetic", unversioned, actor)["version"]!.GetValue<string>().StartsWith("sha256-"), "Unversioned FHIR models pin actual content without inventing a business version");
    var direct = (JsonObject)plan.DeepClone(); direct["name"] = "direct-lab"; direct["direction"] = "source-direct-to-fhir";
    direct["stages"] = new JsonArray(new JsonObject { ["seed"] = new JsonObject { ["resourceType"] = "Observation" }, ["rules"] = new JsonArray(Rule("/value", "/value", "number")) });
    direct["examples"] = new JsonArray(new JsonObject { ["synthetic"] = true, ["input"] = new JsonObject { ["value"] = "0" }, ["expected"] = new JsonArray(new JsonObject { ["resourceType"] = "Observation", ["value"] = 0m }) });
    var request = new JsonObject { ["modelKeys"] = new JsonArray(model["key"]!.DeepClone()), ["executionMapping"] = direct.ToJsonString() };
    var definition = store.Prepare("synthetic", request, ModelActor.Service); var subject = definition["subject"]!.GetValue<string>();
    Check(definition["mappingConfirmed"]!.GetValue<bool>() == false, "Draft never auto approves");
    Reject(() => store.Decide(subject, 0, "CONFIRMED", "Forged approval", ModelActor.Service), "HUMAN_MAPPING_REVIEW_REQUIRED");
    var confirmed = store.Decide(subject, 0, "CONFIRMED", "Inspected exact synthetic profile and rules", actor);
    Check(confirmed["mappingConfirmed"]!.GetValue<bool>() && !confirmed["clinicalApproval"]!.GetValue<bool>(), "Mapping selection distinct from clinical approval");
    Reject(() => store.Decide(subject, 0, "CONFIRMED", "Replay", actor), "DECISION_SEQUENCE_CONFLICT");
    var changed = (JsonObject)request.DeepClone(); var changedPlan = (JsonObject)direct.DeepClone(); changedPlan["description"] = "Changed narrative"; changed["executionMapping"] = changedPlan.ToJsonString();
    Reject(() => store.Prepare("synthetic", changed, actor), "MAPPING_VERSION_IMMUTABLE");
    Check(!store.Decide(subject, 1, "REVOKED", "Withdraw synthetic selection", actor)["mappingConfirmed"]!.GetValue<bool>(), "Revocation stops mapping");
    MappingReuseTests.Run(store,actor,model,direct,Check);
    var proof = new HumanProof(approvalKeys, "https://browser.example", ["https://identity.example"], store);
    var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    string Sign(JsonObject claims, string purpose = "openehr-integration+jwt") {
        string Encode(string value) => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var text = Encode(new JsonObject { ["alg"] = "HS256", ["typ"] = purpose, ["kid"] = "active" }.ToJsonString()) + "." + Encode(claims.ToJsonString());
        return text + "." + Convert.ToBase64String(System.Security.Cryptography.HMACSHA256.HashData(System.Text.Encoding.UTF8.GetBytes(approvalKeys["active"]), System.Text.Encoding.ASCII.GetBytes(text))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
    JsonObject Claims() => new() { ["iss"] = "https://browser.example", ["aud"] = "openehr-modelling-integration", ["identity_issuer"] = "https://identity.example", ["tenant"] = "https://identity.example", ["identity_method"] = "interactive_oidc", ["sub"] = "synthetic-human", ["owner_hash"] = new string('b', 64), ["roles"] = new JsonArray("modelling-reviewer"), ["project_scopes"] = new JsonArray("project:synthetic:write"), ["session_started"] = now, ["iat"] = now, ["exp"] = now + 60, ["jti"] = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)), ["method"] = "POST", ["target"] = "/api/v1/integration/execute", ["body_sha256"] = Data.Hash("{}") };
    var signed = Sign(Claims());
    var verified = proof.Verify(signed, "POST", "/api/v1/integration/execute", "{}");
    Check(verified.Human && verified.Owner == new string('b', 64), "Request-bound human proof");
    Reject(() => proof.Verify(signed, "POST", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REPLAYED");
    Reject(() => proof.Verify(Sign(Claims()), "POST", "/api/v1/integration/execute", "{ }"), "INTERACTIVE_ASSERTION_REQUIRED");
    Reject(() => proof.Verify(Sign(Claims()), "GET", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REQUIRED");
    Reject(() => proof.Verify(Sign(Claims(), "openehr-review+jwt"), "POST", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REQUIRED");
    var expired = Claims(); expired["exp"] = now - 1;
    Reject(() => proof.Verify(Sign(expired), "POST", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REQUIRED");
    var stale = Claims(); stale["session_started"] = now - 601;
    Reject(() => proof.Verify(Sign(stale), "POST", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REQUIRED");
    var foreign = Claims(); foreign["tenant"] = "foreign";
    Reject(() => proof.Verify(Sign(foreign), "POST", "/api/v1/integration/execute", "{}"), "INTERACTIVE_ASSERTION_REQUIRED");
    Reject(() => verified.Decision("other-project"), "PROJECT_PERMISSION_REQUIRED");
    var eventPath = Path.Combine(storeRoot, "events", subject, "000001.json");
    File.WriteAllText(eventPath, File.ReadAllText(eventPath).Replace("CONFIRMED", "REVOKED"));
    Reject(() => store.GetDefinition(subject, actor), "DECISION_AUDIT_INTEGRITY_FAILED");
} finally { Directory.Delete(storeRoot, true); }
// The new routes retain explicit model selection and do not invent a FHIR output.
var ehrOnly = (JsonObject)plan.DeepClone();
ehrOnly["direction"] = "source-to-openehr";
ehrOnly["name"] = "synthetic-composition-only";
ehrOnly["stages"] = new JsonArray(new JsonObject { ["seed"] = new JsonObject { ["_type"] = "COMPOSITION" }, ["rules"] = new JsonArray(Rule("/value", "/syntheticValue")) });
ehrOnly["examples"] = new JsonArray(new JsonObject { ["synthetic"] = true, ["input"] = records[0].DeepClone(), ["expected"] = new JsonArray(new JsonObject { ["_type"] = "COMPOSITION", ["syntheticValue"] = "0" }) });
var ehrMapping = new Mapping(ehrOnly.ToJsonString()); ehrMapping.VerifyExamples();
Check(ehrMapping.ProducesOpenEhr && !ehrMapping.ProducesFhir && !ehrMapping.NeedsFhirModel && ehrMapping.NeedsOpenEhrModel, "Composition-only route does not require an unrelated FHIR model");
var ehrInput = Sources.Parse(Encoding.UTF8.GetBytes("{\"_type\":\"COMPOSITION\",\"syntheticValue\":\"0\"}"), "openehr-json");
Check(ehrInput.Count == 1 && ehrInput[0]["syntheticValue"]!.GetValue<string>() == "0", "Canonical composition input retains clinical values without conversion");
Reject(() => Sources.Parse(Encoding.UTF8.GetBytes("{\"_type\":\"OBSERVATION\"}"), "openehr-json"), "OPENEHR_COMPOSITION_REQUIRED");
var ehrForward = (JsonObject)ehrOnly.DeepClone(); ehrForward["direction"] = "openehr-to-fhir";
ehrForward["stages"] = new JsonArray(new JsonObject { ["seed"] = new JsonObject { ["resourceType"] = "Observation" }, ["rules"] = new JsonArray(Rule("/syntheticValue", "/valueString")) });
ehrForward["examples"] = new JsonArray(new JsonObject { ["synthetic"] = true, ["input"] = ehrInput[0].DeepClone(), ["expected"] = new JsonArray(new JsonObject { ["resourceType"] = "Observation", ["valueString"] = "0" }) });
var ehrForwardMapping = new Mapping(ehrForward.ToJsonString()); ehrForwardMapping.VerifyExamples();
Check(ehrForwardMapping.RequiresOpenEhrInput && ehrForwardMapping.ProducesFhir && ehrForwardMapping.NeedsOpenEhrModel && ehrForwardMapping.NeedsFhirModel, "Composition-to-FHIR requires both the source template and target profile");
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { coreChecks = count, status = "PASS" }));

// Isolated synthetic HTTP destination: no production endpoint or clinical database.
Check(Network.NativeData(new JsonObject { ["ok"] = true, ["data"] = new JsonObject { ["valid"] = false, ["status"] = "FAIL" } })["valid"]!.GetValue<bool>() == false, "Native HTTP success does not imply a valid composition");
Reject(() => Network.NativeData(new JsonObject { ["ok"] = false, ["error"] = new JsonObject { ["code"] = "ENGINE_PROCESSING_FAILED" } }), "ENGINE_PROCESSING_FAILED");
Reject(() => Network.NativeData(new JsonObject { ["ok"] = true }), "OPENEHR_ENGINE_PROTOCOL_ERROR");
JsonObject ValidationReport(string status, string terminology = "not-run", bool timedOut = false) => new() { ["status"] = status, ["evidence"] = new JsonObject { ["executed"] = true, ["timedOut"] = timedOut }, ["terminology"] = new JsonObject { ["status"] = terminology }, ["outcome"] = new JsonObject { ["resourceType"] = "OperationOutcome" }, ["valid"] = status == "valid" };
Reject(() => Validation.RequireFhirCompleted(ValidationReport("not-completed"), false), "FHIR_VALIDATION_NOT_EXECUTED");
Reject(() => Validation.RequireFhirCompleted(ValidationReport("invalid", timedOut: true), false), "FHIR_VALIDATION_NOT_EXECUTED");
Reject(() => Validation.RequireFhirCompleted(ValidationReport("valid"), true), "FHIR_TERMINOLOGY_NOT_EXECUTED");
Reject(() => Validation.RequireFhirCompleted(ValidationReport("invalid", "incomplete"), false), "FHIR_TERMINOLOGY_NOT_EXECUTED");
Validation.RequireFhirCompleted(ValidationReport("invalid", "failed"), true); Check(true, "Completed invalid validation is distinct from unavailable checks");
new Mapping(MappingHelp.Document()["example"]!.ToJsonString()).VerifyExamples();
Check(true, "Bundled agent mapping example is executable");
var socket = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); socket.Start();
var port = ((System.Net.IPEndPoint)socket.LocalEndpoint).Port; socket.Stop();
var destinationRoot = Path.Combine(Path.GetTempPath(), "modeller-destination-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(destinationRoot);
var priorEnvironment = Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT"); Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", "Development");
try {
    var keyFile = Path.Combine(destinationRoot, "token"); File.WriteAllText(keyFile, new string('c', 64));
    var configuration = new Configuration(destinationRoot, "", "", "", "", [], [], true, false);
    var connection = new DestinationConnection("synthetic", $"http://127.0.0.1:{port}/fhir/", keyFile, ["synthetic"], ["synthetic"], ["Patient"]);
    var listener = new System.Net.HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
    var attempts = new Dictionary<string, int>(); var created = new HashSet<string>(); var calls = 0;
    var serving = Task.Run(async () => {
        while (listener.IsListening) {
            System.Net.HttpListenerContext context;
            try { context = await listener.GetContextAsync(); } catch (System.Net.HttpListenerException) { break; } catch (ObjectDisposedException) { break; }
            try {
                var path = context.Request.Url!.AbsolutePath; JsonObject result;
                if (path == "/fhir/metadata") result = new JsonObject { ["resourceType"] = "CapabilityStatement", ["fhirVersion"] = "4.0.1", ["rest"] = new JsonArray(new JsonObject { ["mode"] = "server", ["resource"] = new JsonArray(new JsonObject { ["type"] = "Patient", ["conditionalCreate"] = true, ["interaction"] = new JsonArray(new JsonObject { ["code"] = "create" }) }) }) };
                else if (path == "/compute") {
                    attempts["compute"] = attempts.GetValueOrDefault("compute") + 1;
                    context.Response.StatusCode = attempts["compute"] == 1 ? 429 : 200;
                    result = new JsonObject { ["status"] = "synthetic-compute" };
                }
                else {
                    calls++; using var reader = new StreamReader(context.Request.InputStream); var resource = JsonNode.Parse(await reader.ReadToEndAsync()) as JsonObject ?? new JsonObject();
                    var value = resource["identifier"]?[0]?["value"]?.GetValue<string>() ?? "";
                    Check(context.Request.Headers["If-None-Exist"]?.StartsWith("identifier=", StringComparison.Ordinal) == true, "Conditional create header on every write");
                    attempts[value] = attempts.GetValueOrDefault(value) + 1;
                    if (value == "duplicate") { context.Response.StatusCode = 412; result = new JsonObject(); }
                    else if (value == "redirect") { context.Response.StatusCode = 302; context.Response.RedirectLocation = "http://127.0.0.1:1/private"; result = new JsonObject(); }
                    else if (value == "busy" && attempts[value] == 1) { context.Response.StatusCode = 429; context.Response.Headers.Add("Retry-After", "0"); result = new JsonObject(); }
                    else if (value == "unavailable") { context.Response.StatusCode = 503; context.Response.Headers.Add("Retry-After", "0"); result = new JsonObject(); }
                    else if (value == "cancel") { await Task.Delay(500); context.Response.StatusCode = 201; result = resource; }
                    else { context.Response.StatusCode = created.Add(value) ? 201 : 200; result = resource; result["id"] = "synthetic-id"; if (value == "conflict") result["active"] = false; }
                }
                var bytes = System.Text.Encoding.UTF8.GetBytes(result.ToJsonString()); context.Response.ContentType = "application/fhir+json"; context.Response.ContentLength64 = bytes.Length; await context.Response.OutputStream.WriteAsync(bytes); context.Response.Close();
            } catch { context.Response.Abort(); }
        }
    });
    JsonObject Patient(string id) => new() { ["resourceType"] = "Patient", ["identifier"] = new JsonArray(new JsonObject { ["system"] = "urn:uuid:991c7a7a-c903-4da4-944c-23329b16797a", ["value"] = id }), ["active"] = true };
    try {
        using (var compute = Network.Client(TimeSpan.FromSeconds(10))) {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/compute") { Content = new StringContent("{}") };
            using var computeResponse = await Network.Compute(compute, request, CancellationToken.None);
            Check((int)computeResponse.StatusCode == 200 && attempts["compute"] == 2, "Private compute admission retries without advancing the source");
        }
        using var delivery = new FhirDelivery(configuration, connection); await delivery.Check("4.0.1", CancellationToken.None);
        Check((await delivery.Send(Patient("created"), CancellationToken.None)).State == "CREATED", "Synthetic destination create");
        Check((await delivery.Send(Patient("created"), CancellationToken.None)).State == "ALREADY_PRESENT", "Idempotent existing representation");
        Check((await delivery.Send(Patient("conflict"), CancellationToken.None)).State == "EXISTING_CONTENT_CONFLICT", "Existing content never overwritten");
        Check((await delivery.Send(Patient("duplicate"), CancellationToken.None)).State == "IDENTIFIER_NOT_UNIQUE", "Nonunique identifier stops delivery");
        Check((await delivery.Send(Patient("redirect"), CancellationToken.None)).State == "REJECTED", "Redirect never followed");
        Check((await delivery.Send(Patient("busy"), CancellationToken.None)).State == "CREATED" && attempts["busy"] == 2, "Bounded conditional retry");
        Check((await delivery.Send(Patient("unavailable"), CancellationToken.None)).State == "UNCERTAIN" && attempts["unavailable"] == 3, "Exhausted delivery remains uncertain");
        using var cancelled = new CancellationTokenSource(150);
        Check((await delivery.Send(Patient("cancel"), cancelled.Token)).State == "UNCERTAIN", "Cancellation after POST cannot claim no write");
        Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", "Production");
        Reject(() => new FhirDelivery(configuration, connection), "DESTINATION_HTTPS_REQUIRED");
    } finally { listener.Stop(); listener.Close(); await serving; }
} finally { Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", priorEnvironment); Directory.Delete(destinationRoot, true); }
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { coreAndDeliveryChecks = count, status = "PASS", clinicalData = "SYNTHETIC_ONLY" }));
