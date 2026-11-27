using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
using Modeller.Operational;

try {
    if (args.Length != 3 || args[0] is not ("inspect" or "run" or "original")) throw new ProcessingException("USAGE_REQUIRED");
    var config = Data.Read<Configuration>(args[1]);
    var directory = Path.GetFullPath(args[2]);
    if (!Directory.Exists(directory) || new DirectoryInfo(directory).LinkTarget is not null) throw new ProcessingException("PRIVATE_JOB_DIRECTORY_REQUIRED");
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    using var ownership = new FileStream(Path.Combine(directory, "worker.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    var request = Data.Read<JobRequest>(Path.Combine(directory, "request.json"));
    if (!Regex.IsMatch(request.Owner ?? "", "^[a-f0-9]{64}$") || !Regex.IsMatch(request.ProjectId ?? "", "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
        || !Regex.IsMatch(request.SourceSha256 ?? "", "^[a-f0-9]{64}$")) throw new ProcessingException("JOB_IDENTITY_INVALID");
    var source = config.Sources.SingleOrDefault(s => s.Id == request.SourceId && s.Projects.Contains(request.ProjectId, StringComparer.Ordinal) && s.Owners.Contains(request.Owner, StringComparer.Ordinal)) ?? throw new ProcessingException("SOURCE_ACCESS_REJECTED");
    if (args[0] == "original") {
        var keys = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string,string>>(Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEYS") ?? "{}")!;
        var models = new ModelStore(config.ModelRoot, keys, Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEY_ID") ?? "active", config.RuntimeFiles);
        var definition = models.GetDefinition(request.Subject, ModelActor.Service);
        if (definition["project"]?.GetValue<string>() != request.ProjectId) throw new ProcessingException("MODEL_PROJECT_MISMATCH");
        var policy = new Mapping(Data.Required(definition, "executionMapping")).ClinicalPolicy ?? throw new ProcessingException("CLINICAL_POLICY_REQUIRED");
        if (policy.IdentityDomain != source.IdentityDomain) throw new ProcessingException("SOURCE_IDENTITY_DOMAIN_MISMATCH");
        using var registry = ClinicalPipeline.Open(config);
        var original = new DependencyQueue(registry).ReadOriginal(new(request.Owner!, request.ProjectId!, policy.IdentityDomain, policy.DestinationId), request.SourceSha256!);
        var destination = Path.Combine(directory, "received-source.bin"); var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.WriteThrough };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var output = new FileStream(temporary, options)) { output.Write(original); output.Flush(true); }
        File.Move(temporary, destination, true);
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { sourceSha256 = request.SourceSha256, length = original.Length, status = "READY" }, Data.Json)); return;
    }
    await using var pinnedModels = args[0] == "run" ? await ModelContext.Connect(config, request, CancellationToken.None) : null;
    byte[]? retained = null;
    if (pinnedModels is not null && new Mapping(pinnedModels.MappingJson).ClinicalPolicy is { } heldPolicy) {
        if (source.IdentityDomain != heldPolicy.IdentityDomain) throw new ProcessingException("SOURCE_IDENTITY_DOMAIN_MISMATCH");
        using var store = ClinicalPipeline.Open(config);
        try { retained = new DependencyQueue(store).ReadOriginal(new(request.Owner!, request.ProjectId!, heldPolicy.IdentityDomain, heldPolicy.DestinationId), request.SourceSha256!); }
        catch (ProcessingException error) when (error.Code == "HELD_SOURCE_UNAVAILABLE") { }
    }
    byte[] bytes;
    if (retained is not null) bytes = retained;
    else {
        var file = Sources.FileWithin(source.Root, request.File);
        using var stream = Sources.Open(source.Root, file);
        if (stream.Length > Sources.Limit) throw new ProcessingException("SOURCE_LIMIT");
        using var copy = new MemoryStream(); var buffer = new byte[16384]; int length;
        while ((length = stream.Read(buffer)) > 0) { if (copy.Length + length > Sources.Limit) throw new ProcessingException("SOURCE_LIMIT"); copy.Write(buffer, 0, length); }
        bytes = copy.ToArray();
    }
    if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != request.SourceSha256) throw new ProcessingException("SOURCE_CHANGED");
    if (args[0] == "inspect" && request.SourceContractKey is not null) {
        if (!Regex.IsMatch(request.SourceContractKey, "^[a-f0-9]{64}$")) throw new ProcessingException("SOURCE_PROFILE_KEY_REQUIRED");
        var keys = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string,string>>(Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEYS") ?? "{}")!;
        var store = new ModelStore(config.ModelRoot, keys, Environment.GetEnvironmentVariable("MODELLER_APPROVAL_KEY_ID") ?? "active", config.RuntimeFiles);
        var model = store.GetModel(request.SourceContractKey, ModelActor.Service);
        if (model["projectId"]?.GetValue<string>() != request.ProjectId || model["standard"]?.GetValue<string>() != "source-contract") throw new ProcessingException("SOURCE_PROFILE_SELECTION_MISMATCH");
        var contract = new SourceContract(Data.Required(model, "content"));
        if (contract.Definition.Format != source.Format) throw new ProcessingException("DECLARED_SOURCE_FORMAT_MISMATCH");
        var projected = new SourceProjection(contract).Read(bytes);
        var description = System.Text.Json.JsonSerializer.SerializeToNode(Sources.Describe(projected.Select(record => record.Record).ToList()), Data.Json)!.AsObject();
        description["sourceContractSha256"] = contract.Sha256; description["recordValues"] = "NOT_INCLUDED";
        Console.WriteLine(description.ToJsonString()); return;
    }
    if (args[0] == "inspect") {
        var description = source.Format is "hl7-v2" or "hl7-v2-xml" or "hl7-v3" or "cda"
            ? ClinicalMessages.Describe(bytes, source.Format) : System.Text.Json.JsonSerializer.SerializeToNode(Sources.Describe(Sources.Parse(bytes, source.Format)), Data.Json);
        Console.WriteLine(description!.ToJsonString()); return;
    }
    if (request.Mode is not ("export" or "deliver") || !Regex.IsMatch(request.Subject ?? "", "^[a-f0-9]{64}$")) throw new ProcessingException("JOB_MODE_OR_SELECTION_INVALID");
    using var cancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    using var term = System.Runtime.InteropServices.PosixSignalRegistration.Create(System.Runtime.InteropServices.PosixSignal.SIGTERM, context => { context.Cancel = true; cancellation.Cancel(); });
    var monitor = Task.Run(async () => { try { while (!cancellation.IsCancellationRequested) { if (File.Exists(Path.Combine(directory, "cancel"))) { cancellation.Cancel(); break; } await Task.Delay(200, cancellation.Token); } } catch (OperationCanceledException) { } });
    try {
        var models = pinnedModels!;
        await models.Refresh(cancellation.Token);
        var mapping = new Mapping(models.MappingJson); mapping.VerifyExamples();
        SourceContract? sourceContract = null;
        List<ProjectedSourceRecord>? projected = null;
        if (mapping.SourceProfileKey is not null) {
            var selectedSource = ((JsonArray)models.Selection["items"]!).OfType<JsonObject>().SingleOrDefault(item => item["pin"]?["key"]?.GetValue<string>() == mapping.SourceProfileKey && item["pin"]?["standard"]?.GetValue<string>() == "source-contract") ?? throw new ProcessingException("EXACT_SOURCE_PROFILE_REQUIRED");
            sourceContract = new(Data.Required(selectedSource, "content"));
            if (sourceContract.Definition.Format != source.Format) throw new ProcessingException("DECLARED_SOURCE_FORMAT_MISMATCH");
            projected = new SourceProjection(sourceContract).Read(bytes);
        }
        if (sourceContract is null || mapping.ClinicalPolicy is null) throw new ProcessingException("CONFIRMED_SOURCE_AND_PATIENT_POLICY_REQUIRED");
        var records = projected!.Select(record => record.Record).ToList();
        mapping.VerifySource(records);
        if (mapping.Direction == "fhir-to-openehr" && source.Format != "fhir-json") throw new ProcessingException("DECLARED_FHIR_SOURCE_REQUIRED");
        if (mapping.RequiresOpenEhrInput && source.Format != "openehr-json") throw new ProcessingException("DECLARED_OPENEHR_SOURCE_REQUIRED");
        if (source.Format == "openehr-json" && !mapping.RequiresOpenEhrInput) throw new ProcessingException("DECLARED_OPENEHR_MAPPING_REQUIRED");
        if (mapping.Direction == "fhir-to-openehr" && request.Mode != "export") throw new ProcessingException("REVERSE_MAPPING_EXPORT_ONLY");
        if (mapping.Direction == "source-to-openehr" && request.Mode != "export") throw new ProcessingException("OPENEHR_OUTPUT_EXPORT_ONLY");
        var destination = request.Mode == "deliver" ? config.Destinations.SingleOrDefault(d => d.Id == request.DestinationId && d.Projects.Contains(request.ProjectId, StringComparer.Ordinal) && d.Owners.Contains(request.Owner, StringComparer.Ordinal)) ?? throw new ProcessingException("DESTINATION_ACCESS_REJECTED") : null;
        using var delivery = destination is null ? null : new FhirDelivery(config, destination);
        if (delivery is not null) await delivery.Check(Data.Required(models.Project, "fhirVersion"), cancellation.Token);
        using var validation = new Validation(config, request, models);
        var clinicalPolicy = mapping.ClinicalPolicy;
        if (source.IdentityDomain != clinicalPolicy.IdentityDomain || request.Mode == "deliver" && request.DestinationId != clinicalPolicy.DestinationId) throw new ProcessingException("CLINICAL_POLICY_SCOPE_MISMATCH");
        using var identities = ClinicalPipeline.Open(config);
        var scope = new OperationalScope(request.Owner!, request.ProjectId!, clinicalPolicy.IdentityDomain, clinicalPolicy.DestinationId);
        var clinical = new ClinicalPipeline(identities, scope, clinicalPolicy, sourceContract);
        var dependencyQueue = new DependencyQueue(identities);
        var destinationEvidence = delivery is null ? null : new DestinationEvidence(identities, dependencyQueue, scope, delivery);
        var configurationHash = Data.Hash(Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(new { source, destination }, Data.Json)));
        var stateFile = Path.Combine(directory, "state.json");
        if (File.Exists(stateFile) && Data.Read<JobState>(stateFile).ConfigurationSha256 != configurationHash) throw new ProcessingException("JOB_CONNECTION_CONFIGURATION_CHANGED");
        var state = new JobState { ConfigurationSha256 = configurationHash, Status = "RUNNING", MappingSha256 = Data.Hash(models.MappingJson), SourceSchemaSha256 = mapping.SchemaHash };
        var groups = mapping.Group(records);
        var sourceEnvelopes = new List<ProjectedSourceRecord>();
        foreach (var group in groups) {
            if (group.Record["_group"] is null) { sourceEnvelopes.Add(projected![sourceEnvelopes.Count]); continue; }
            var members = (JsonArray)group.Record["_group"]!["records"]!;
            var envelopes = members.OfType<JsonObject>().SelectMany(member => projected!.Where(item => JsonNode.DeepEquals(item.Record, member))).Distinct().ToArray();
            var first = envelopes[0];
            if (envelopes.Any(item => item.PatientIdentity != first.PatientIdentity || Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(item.Relations, Data.Json)) != Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(first.Relations, Data.Json)))) throw new ProcessingException("GROUP_PATIENT_OR_RELATION_CONFLICT");
            var messageId = envelopes.All(item => item.MessageId is not null) ? Data.Hash(string.Join("\n", envelopes.Select(item => item.MessageId).Order(StringComparer.Ordinal)) + "\n" + Data.Canonical(group.Record["_group"]!["key"])) : null;
            sourceEnvelopes.Add(first with { Record = group.Record, MessageId = messageId, InputResources = new JsonArray(envelopes.SelectMany(item => item.InputResources?.ToArray() ?? []).Select(item => item?.DeepClone()).ToArray()) });
        }
        Directory.CreateDirectory(Path.Combine(directory, "outputs")); Directory.CreateDirectory(Path.Combine(directory, "quarantine")); Directory.CreateDirectory(Path.Combine(directory, "evidence"));
        void Progress() {
            var rows = Directory.EnumerateFiles(directory, "row-*.json").Select(file => Data.Read<Row>(file)).ToArray();
            state.Checkpoint = rows.Count(r => r.Complete); state.Read = rows.Sum(r => r.SourceCount); state.Transformed = rows.Where(r => r.Transformed).Sum(r => r.SourceCount);
            state.Rejected = rows.Where(r => r.Rejected).Sum(r => r.SourceCount); state.Exported = rows.Sum(r => r.ExportCount);
            state.Emitted = rows.Sum(r => r.Receipts.Count(v => v.State is "CREATED" or "ALREADY_PRESENT"));
            state.DeliveryFailed = rows.Sum(r => r.Receipts.Count(v => v.State is not ("CREATED" or "ALREADY_PRESENT" or "UNCERTAIN")));
            state.Held = rows.Count(row => row.Held);
            state.Uncertain = rows.Sum(r => r.Receipts.Count(v => v.State == "UNCERTAIN")); state.Updated = DateTimeOffset.UtcNow;
            Data.Write(Path.Combine(directory, "state.json"), state);
        }
        try {
            Progress();
            await validation.Profiles(Path.Combine(directory, "evidence", "models"), cancellation.Token);
            for (var index = 0; index < groups.Count; index++) {
                cancellation.Token.ThrowIfCancellationRequested(); await models.Refresh(cancellation.Token);
                if (Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).Sum(file => new FileInfo(file).Length) > 256L * 1048576) throw new ProcessingException("JOB_STORAGE_LIMIT");
                var rowFile = Path.Combine(directory, $"row-{index:D6}.json");
                var row = File.Exists(rowFile) ? Data.Read<Row>(rowFile) : new Row { SourceCount = groups[index].SourceCount };
                if (row.Complete && (row.Rejected || row.Receipts.All(r => r.State is "CREATED" or "ALREADY_PRESENT"))) {
                    if (delivery is not null && row.Receipts.Any(r => r.DestinationSha256 != delivery.DestinationHash)) throw new ProcessingException("DELIVERY_RECEIPT_MISMATCH");
                    continue;
                }
                row.Complete = false;
                Data.Write(rowFile, row);
                var envelope = sourceEnvelopes[index];
                var controlId = envelope.MessageId ?? request.SourceSha256 + ":" + index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var pendingItem = clinical.Admit(source, request.IntakeId ?? request.Subject!, request.Subject!, state.MappingSha256!, envelope, controlId, bytes, DateTimeOffset.UtcNow);
                row.PendingId = pendingItem.Id;
                var priorPlan = dependencyQueue.DeliveryPlan(scope, pendingItem.Id);
                if (priorPlan is not null) {
                    row.Transformed = true;
                    if (delivery is null || priorPlan.DestinationSha256 != delivery.DestinationHash || priorPlan.SourceSha256 != request.SourceSha256 || priorPlan.MappingSha256 != state.MappingSha256) throw new ProcessingException("DELIVERY_PLAN_CHANGED_REVIEW_REQUIRED");
                    for (var planned = 0; planned < priorPlan.Outputs.Length; planned++) {
                        if (priorPlan.Receipts[planned] is not { } verifiedReceipt) continue;
                        var outputFile = Path.Combine(directory, "outputs", $"{index:D6}-{planned:D3}.json");
                        Data.Write(outputFile, priorPlan.Outputs[planned]); Data.Write(outputFile + ".receipt", verifiedReceipt);
                        if (row.Receipts.Count <= planned) { while (row.Receipts.Count < planned) row.Receipts.Add(new("", "NOT_SENT", null)); row.Receipts.Add(verifiedReceipt); } else row.Receipts[planned] = verifiedReceipt;
                    }
                }
                if (pendingItem.State == "DELIVERED") { row.Complete = true; row.Held = false; Data.Write(rowFile, row); Progress(); continue; }
                if (destinationEvidence is not null) await destinationEvidence.Refresh(pendingItem, cancellation.Token);
                var lease = clinical.Acquire(pendingItem.Id, request.Subject!, state.MappingSha256!, DateTimeOffset.UtcNow);
                if (lease is null) { row.Held = true; row.Error = clinical.Inspect(pendingItem.Id, DateTimeOffset.UtcNow).State; Data.Write(rowFile, row); Progress(); continue; }
                row.Held = false; row.Error = null;
                var writeStarted = false;
                using var recordDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
                recordDeadline.CancelAfter(TimeSpan.FromMinutes(12));
                var recordCancellation = recordDeadline.Token;
                try {
                    if (source.Format == "fhir-json") {
                        var inputs = envelope.InputResources ?? throw new ProcessingException("VALIDATED_INPUT_RESOURCE_REQUIRED");
                        for (var inputIndex = 0; inputIndex < inputs.Count; inputIndex++) await validation.Fhir((JsonObject)inputs[inputIndex]!, Path.Combine(directory, "evidence", $"input-{index:D6}-{inputIndex:D6}"), recordCancellation);
                    }
                    if (mapping.RequiresOpenEhrInput) {
                        var inputs = envelope.InputResources ?? throw new ProcessingException("VALIDATED_INPUT_RESOURCE_REQUIRED");
                        for (var inputIndex = 0; inputIndex < inputs.Count; inputIndex++) await validation.Composition((JsonObject)inputs[inputIndex]!, Path.Combine(directory, "evidence", $"input-openehr-{index:D6}-{inputIndex:D6}.json"), recordCancellation);
                    }
                    var mapped = mapping.Transform(clinical.MappingInput(lease));
                    if (mapping.ProducesFhir) mapped = mapped.Select(item => item with { Output = clinical.ApplyReferences(lease, item.Output) }).ToList();
                    else foreach (var item in mapped) clinical.CheckPrivacy(lease, item.Output);
                    // Validate the complete source record's outputs before the first destination write.
                    for (var output = 0; output < mapped.Count; output++) {
                        var prefix = Path.Combine(directory, "evidence", $"{index:D6}-{output:D3}");
                        if (mapping.ProducesOpenEhr) {
                            var composition = mapped[output].Output;
                            await validation.Composition(composition, prefix + "-openehr.json", recordCancellation);
                        }
                        if (mapping.ProducesFhir) await validation.Fhir(mapped[output].Output, prefix + "-fhir", recordCancellation);
                        Data.Write(prefix + "-provenance.json", new { sourceId = request.SourceId, sourceSha256 = request.SourceSha256, group = index, mapped[output].Provenance, mapped[output].Unmapped, mappingSha256 = state.MappingSha256, sourceProfileKey = mapping.SourceProfileKey, sourceContractSha256 = sourceContract.Sha256, privacyPolicyRevision = lease.Input.PrivacyPolicyRevision, identityResolutionEvidenceSha256 = lease.Input.IdentityResolutionEvidenceSha256 });
                    }
                    if (delivery is not null) dependencyQueue.PlanDelivery(scope, lease, delivery.DestinationHash, mapped.Select(item => item.Output).ToArray(), DateTimeOffset.UtcNow);
                    if (mapping.Reversibility == "retained-context") Data.Write(Path.Combine(directory, "evidence", $"{index:D6}-retained-source.json"), groups[index].Record);
                    row.Transformed = true;
                    for (var output = 0; output < mapped.Count; output++) {
                        await models.Refresh(recordCancellation); recordCancellation.ThrowIfCancellationRequested();
                        var resource = mapped[output].Output;
                        var outputFile = Path.Combine(directory, "outputs", $"{index:D6}-{output:D3}.json");
                        Data.Write(outputFile, resource);
                        Data.Write(Path.Combine(directory, "evidence", $"{index:D6}-{output:D3}-patient-index.json"), new { output = Path.GetFileName(outputFile), outputSha256 = Data.Hash(Data.Canonical(resource)), patient = lease.OutboundPatientIdentity, destinationId = clinicalPolicy.DestinationId, privacyPolicyRevision = lease.Input.PrivacyPolicyRevision, mappingSha256 = state.MappingSha256 });
                        if (delivery is null) row.ExportCount = output + 1;
                        else {
                            var receiptFile = outputFile + ".receipt";
                            var receipt = File.Exists(receiptFile) ? Data.Read<DeliveryReceipt>(receiptFile) : null;
                            if (receipt is not null && (receipt.ResourceSha256 != FhirDelivery.PayloadHash(resource) || receipt.DestinationSha256 != delivery.DestinationHash)) throw new ProcessingException("DELIVERY_RECEIPT_MISMATCH");
                            if (receipt?.State is not ("CREATED" or "ALREADY_PRESENT")) {
                                writeStarted = true;
                                receipt = await delivery.Send(resource, recordCancellation); Data.Write(receiptFile, receipt);
                            }
                            if (receipt.State is "CREATED" or "ALREADY_PRESENT") dependencyQueue.RecordDeliveryReceipt(scope, lease, output, receipt, DateTimeOffset.UtcNow);
                            if (row.Receipts.Count <= output) row.Receipts.Add(receipt); else row.Receipts[output] = receipt;
                            Data.Write(rowFile, row); Progress();
                            if (receipt.State is "CREATED" or "ALREADY_PRESENT" && clinical.PublicationIdentity(lease, Data.Required(resource, "resourceType")) is { } publicationIdentity)
                                await destinationEvidence!.Publish(lease, Data.Required(resource, "resourceType"), publicationIdentity, receipt, recordCancellation);
                            if (receipt.State == "UNCERTAIN") { clinical.Complete(lease, Data.Hash(System.Text.Json.JsonSerializer.Serialize(receipt, Data.Json)), true, DateTimeOffset.UtcNow); state.Status = "DELIVERY_UNCERTAIN"; state.Error = "RETRY_REQUIRES_RECONCILIATION"; Progress(); Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(state, Data.Json)); return; }
                        }
                        Data.Write(rowFile, row); Progress();
                    }
                    if (row.Receipts.Any(receipt => receipt.State is not ("CREATED" or "ALREADY_PRESENT"))) throw new ProcessingException("CLINICAL_DELIVERY_INCOMPLETE");
                    clinical.Complete(lease, Data.Hash(Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(new { row.ExportCount, row.Receipts }, Data.Json))), false, DateTimeOffset.UtcNow);
                    row.Complete = true; Data.Write(rowFile, row); Progress();
                } catch (ProcessingException error) when (error.Code.StartsWith("RECORD_", StringComparison.Ordinal)) {
                    dependencyQueue.Fail(scope, lease, Data.Hash(error.Code), writeStarted, DateTimeOffset.UtcNow);
                    row.Rejected = true; row.Complete = true; row.Error = error.Code;
                    Data.Write(Path.Combine(directory, "quarantine", $"{index:D6}.json"), new { group = index, code = error.Code, sourceId = request.SourceId, record = groups[index].Record });
                    Data.Write(rowFile, row); Progress();
                } catch {
                    dependencyQueue.Fail(scope, lease, Data.Hash("PROCESSING_INTERRUPTED"), writeStarted, DateTimeOffset.UtcNow);
                    throw;
                }
            }
            var exportFile = Path.Combine(directory, "export.ndjson"); var temporary = exportFile + ".tmp";
            using (var writer = new StreamWriter(temporary, false, new System.Text.UTF8Encoding(false))) foreach (var output in Directory.EnumerateFiles(Path.Combine(directory, "outputs"), "*.json").Order(StringComparer.Ordinal)) writer.WriteLine(File.ReadAllText(output));
            File.Move(temporary, exportFile, true);
            var patientIndex = Path.Combine(directory, "patient-index.ndjson");
            using (var writer = new StreamWriter(patientIndex + ".tmp", false, new System.Text.UTF8Encoding(false))) foreach (var entry in Directory.EnumerateFiles(Path.Combine(directory, "evidence"), "*-patient-index.json").Order(StringComparer.Ordinal)) writer.WriteLine(File.ReadAllText(entry));
            File.Move(patientIndex + ".tmp", patientIndex, true);
            var quarantineFile = Path.Combine(directory, "quarantine.ndjson");
            using (var writer = new StreamWriter(quarantineFile + ".tmp", false, new System.Text.UTF8Encoding(false))) foreach (var rejected in Directory.EnumerateFiles(Path.Combine(directory, "quarantine"), "*.json").Order(StringComparer.Ordinal)) writer.WriteLine(File.ReadAllText(rejected));
            File.Move(quarantineFile + ".tmp", quarantineFile, true);
            state.Status = state.Held > 0 ? "WAITING_DEPENDENCIES" : state.Rejected > 0 || state.DeliveryFailed > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED"; state.Error = null; Progress();
        } catch (OperationCanceledException) { state.Status = "CANCELLED"; state.Error = null; Progress(); }
        catch (ProcessingException error) { state.Status = "BLOCKED"; state.Error = error.Code; Progress(); }
        catch { state.Status = "INTERRUPTED"; state.Error = "PROCESSING_INTERRUPTED"; Progress(); }
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(state, Data.Json));
    } finally { cancellation.Cancel(); await monitor; }
} catch (ProcessingException error) { Console.Error.WriteLine(error.Code); Environment.ExitCode = 1; }
catch { Console.Error.WriteLine("PROCESSING_FAILED"); Environment.ExitCode = 1; }

public sealed class Row {
    public int SourceCount { get; set; }
    public string? PendingId { get; set; }
    public bool Held { get; set; }
    public bool Complete { get; set; }
    public bool Transformed { get; set; }
    public bool Rejected { get; set; }
    public int ExportCount { get; set; }
    public string? Error { get; set; }
    public List<DeliveryReceipt> Receipts { get; set; } = [];
}
