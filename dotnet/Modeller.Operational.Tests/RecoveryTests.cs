using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Modeller.Core;
using Modeller.Operational;

internal static class RecoveryTests
{
    public static async Task<int> Run(string root, byte[] key) {
        var checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); checks++; }
        async Task Reject(Func<Task> action, string code) { try { await action(); } catch (ProcessingException error) when (error.Code == code) { checks++; return; } throw new Exception("Expected " + code); }
        var socket = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0); socket.Start(); var port = ((IPEndPoint)socket.LocalEndpoint).Port; socket.Stop();
        var resources = new ConcurrentDictionary<string, JsonObject>();
        var writes = 0;
        using var listener = new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/"); listener.Start();
        var server = Task.Run(async () => {
            while (listener.IsListening) {
                HttpListenerContext context;
                try { context = await listener.GetContextAsync(); } catch (HttpListenerException) { break; } catch (ObjectDisposedException) { break; }
                try {
                    var path = context.Request.Url!.AbsolutePath.Trim('/'); JsonObject body; var status = 200;
                    if (context.Request.Headers["Authorization"] != "Bearer " + new string('c', 64)) { status = 401; body = new(); }
                    else if (path == "fhir/metadata") body = new() { ["resourceType"] = "CapabilityStatement", ["fhirVersion"] = "4.0.1", ["rest"] = new JsonArray(new JsonObject { ["mode"] = "server", ["resource"] = new JsonArray(new JsonObject { ["type"] = "Observation", ["conditionalCreate"] = true, ["interaction"] = new JsonArray(new JsonObject { ["code"] = "create" }) }) }) };
                    else if (context.Request.HttpMethod == "POST") {
                        using var reader = new StreamReader(context.Request.InputStream);
                        var resource = JsonNode.Parse(await reader.ReadToEndAsync())!.AsObject();
                        var identifier = resource["identifier"]![0]!["value"]!.GetValue<string>();
                        if (context.Request.Headers["If-None-Exist"] is null) throw new Exception("Conditional create required");
                        resource["id"] = identifier; resources["Observation/" + identifier] = resource; Interlocked.Increment(ref writes);
                        status = identifier == "synthetic-two" ? 202 : 201; body = status == 202 ? new() { ["resourceType"] = "OperationOutcome" } : resource;
                    } else if (context.Request.QueryString["identifier"] is string query) {
                        var type = path.Split('/').Last(); var delimiter = query.IndexOf('|'); var system = query[..delimiter]; var value = query[(delimiter + 1)..];
                        var matches = resources.Values.Where(resource => resource["resourceType"]?.GetValue<string>() == type && (resource["identifier"] as JsonArray)?.Any(identifier => identifier?["system"]?.GetValue<string>() == system && identifier?["value"]?.GetValue<string>() == value) == true).ToArray();
                        body = new() { ["resourceType"] = "Bundle", ["type"] = "searchset", ["total"] = matches.Length, ["entry"] = new JsonArray(matches.Select(resource => (JsonNode)new JsonObject { ["resource"] = resource.DeepClone() }).ToArray()) };
                    } else if (resources.TryGetValue(path["fhir/".Length..], out var resource)) body = (JsonObject)resource.DeepClone();
                    else { status = 404; body = new() { ["resourceType"] = "OperationOutcome" }; }
                    context.Response.StatusCode = status; context.Response.ContentType = "application/fhir+json";
                    var bytes = Encoding.UTF8.GetBytes(body.ToJsonString()); context.Response.ContentLength64 = bytes.Length; await context.Response.OutputStream.WriteAsync(bytes);
                } finally { context.Response.Close(); }
            }
        });
        var priorEnvironment = Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT"); Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", "Development");
        try {
            var token = Path.Combine(root, "recovery-token"); File.WriteAllText(token, new string('c', 64));
            var scope = new OperationalScope(new string('a', 64), "recovery", "synthetic-hospital", "synthetic-fhir");
            var connection = new DestinationConnection(scope.DestinationId, $"http://127.0.0.1:{port}/fhir/", token, [scope.ProjectId], [scope.Owner], ["Observation"], ["Patient", "Encounter", "Observation"]);
            var config = new Configuration(root, "", "", "", "", [], [connection], true, false);
            using var identities = new IdentityRegistry(Path.Combine(root, "recovery-state"), key);
            var queue = new DependencyQueue(identities);
            var patient = new ClinicalIdentity("urn:synthetic:patient", "000001");
            identities.RegisterVerifiedPatient(scope, patient, "verified-synthetic-row", Data.Hash("verified-source"));
            var patientKey = new EntityKey("Patient", patient.System, patient.Value);
            var encounterKey = new EntityKey("Encounter", "urn:synthetic:encounter", "enc-1");
            var original = Encoding.UTF8.GetBytes("synthetic-original");
            var sourceHash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(original));
            var subject = Data.Hash("synthetic-mapping"); var mappingHash = Data.Hash("synthetic-rules");
            var input = new PendingInput("synthetic-source", "synthetic-channel", "synthetic-message", sourceHash, subject, mappingHash, 0, patient, [patientKey, encounterKey], new JsonObject { ["synthetic"] = true }, DateTimeOffset.UtcNow.AddDays(1));
            var pending = queue.Accept(scope, input, original, DateTimeOffset.UtcNow);
            using var destination = new FhirDelivery(config, connection); await destination.Check("4.0.1", CancellationToken.None);
            var evidence = new DestinationEvidence(identities, queue, scope, destination);
            Check(!await evidence.Refresh(pending, CancellationToken.None), "Missing target Patient keeps the source waiting");
            resources["Patient/patient-one"] = new() { ["resourceType"] = "Patient", ["id"] = "patient-one", ["identifier"] = new JsonArray(new JsonObject { ["system"] = patient.System, ["value"] = patient.Value }) };
            resources["Encounter/encounter-one"] = new() { ["resourceType"] = "Encounter", ["id"] = "encounter-one", ["identifier"] = new JsonArray(new JsonObject { ["system"] = encounterKey.System, ["value"] = encounterKey.Value }), ["subject"] = new JsonObject { ["reference"] = "Patient/another-patient" } };
            await Reject(async () => { await evidence.Refresh(pending, CancellationToken.None); }, "DESTINATION_ENTITY_PATIENT_MISMATCH");
            Check(queue.Inspect(scope, pending.Id, DateTimeOffset.UtcNow).State == "WAITING_DEPENDENCIES", "A wrong-patient Encounter never releases the Observation");
            resources["Encounter/encounter-one"]["subject"] = new JsonObject { ["reference"] = "Patient/patient-one" };
            Check(await evidence.Refresh(pending, CancellationToken.None), "Authenticated direct Patient/Encounter evidence satisfies the dependency graph");
            var lease = queue.Acquire(scope, pending.Id, DateTimeOffset.UtcNow)!;
            JsonObject Observation(string id) => new() { ["resourceType"] = "Observation", ["status"] = "final", ["code"] = new JsonObject { ["text"] = "Synthetic only" }, ["identifier"] = new JsonArray(new JsonObject { ["system"] = "urn:synthetic:observation", ["value"] = id }), ["subject"] = new JsonObject { ["reference"] = "Patient/patient-one" }, ["encounter"] = new JsonObject { ["reference"] = "Encounter/encounter-one" } };
            var outputs = new[] { Observation("synthetic-one"), Observation("synthetic-two") };
            queue.PlanDelivery(scope, lease, destination.DestinationHash, outputs, DateTimeOffset.UtcNow);
            var first = await destination.Send(outputs[0], CancellationToken.None); queue.RecordDeliveryReceipt(scope, lease, 0, first, DateTimeOffset.UtcNow);
            Check(first.State == "CREATED", "A verified conditional-create receipt is persisted with the delivery plan");
            queue.Complete(scope, pending.Id, lease.LeaseId, Data.Hash("simulated-crash-before-second-output"), true, DateTimeOffset.UtcNow);
            var definition = new JsonObject { ["subject"] = subject, ["mappingSha256"] = mappingHash, ["mappingConfirmed"] = true, ["current"] = true, ["projectConfiguration"] = new JsonObject { ["fhirVersion"] = "4.0.1" } };
            var current = queue.Inspect(scope, pending.Id, DateTimeOffset.UtcNow);
            var review = await DeliveryRecovery.Check(identities, queue, scope, config, definition, pending.Id, current.Revision, sourceHash, "synthetic-reviewer", "Inspect actual destination after interrupted synthetic attempt", "check", CancellationToken.None);
            Check(review.State == "RECONCILIATION_REQUIRED" && review.VerifiedPresent == 1 && review.Missing == 1 && writes == 1, "Recovery inspection reads destination evidence without repeating the missing write");
            var retry = await DeliveryRecovery.Check(identities, queue, scope, config, definition, pending.Id, review.Revision, sourceHash, "synthetic-reviewer", "Explicitly authorise only the absent conditional create", "retry-missing", CancellationToken.None);
            Check(retry.State == "READY" && queue.DeliveryPlan(scope, pending.Id)!.Receipts[0]?.State == "ALREADY_PRESENT", "Reviewed retry retains the already committed output");
            var resumed = queue.Acquire(scope, pending.Id, DateTimeOffset.UtcNow)!;
            queue.PlanDelivery(scope, resumed, destination.DestinationHash, outputs, DateTimeOffset.UtcNow);
            var uncertain = await destination.Send(outputs[1], CancellationToken.None);
            Check(uncertain.State == "UNCERTAIN" && writes == 2, "An async response after commit remains uncertain until read back");
            queue.Complete(scope, pending.Id, resumed.LeaseId, Data.Hash("synthetic-async-commit"), true, DateTimeOffset.UtcNow);
            current = queue.Inspect(scope, pending.Id, DateTimeOffset.UtcNow);
            var complete = await DeliveryRecovery.Check(identities, queue, scope, config, definition, pending.Id, current.Revision, sourceHash, "synthetic-reviewer", "Verify both committed resources before completing the source", "confirm", CancellationToken.None);
            Check(complete.State == "DELIVERED" && complete.VerifiedPresent == 2 && writes == 2, "Verified reconciliation completes the whole saved plan with no duplicate POST");
            Check(queue.ReadOriginal(scope, sourceHash).SequenceEqual(original), "Delivery recovery preserves the original private source");
            await Reject(async () => { await destination.Send(new JsonObject { ["resourceType"] = "Patient" }, CancellationToken.None); }, "DESTINATION_RESOURCE_SCOPE_REJECTED");
            Check(writes == 2, "Read permission on Patient does not grant Patient writes");
        } finally {
            Environment.SetEnvironmentVariable("DOTNET_ENVIRONMENT", priorEnvironment);
            listener.Stop(); await server;
        }
        return checks;
    }
}
