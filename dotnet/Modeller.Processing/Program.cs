using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;

try {
    if (args.Length != 3 || args[0] is not ("inspect" or "run")) throw new ProcessingException("USAGE_REQUIRED");
    var config = Data.Read<Configuration>(args[1]);
    var directory = Path.GetFullPath(args[2]);
    if (!Directory.Exists(directory) || new DirectoryInfo(directory).LinkTarget is not null) throw new ProcessingException("PRIVATE_JOB_DIRECTORY_REQUIRED");
    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    using var ownership = new FileStream(Path.Combine(directory, "worker.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    var request = Data.Read<JobRequest>(Path.Combine(directory, "request.json"));
    if (!Regex.IsMatch(request.Owner ?? "", "^[a-f0-9]{64}$") || !Regex.IsMatch(request.ProjectId ?? "", "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
        || !Regex.IsMatch(request.SourceSha256 ?? "", "^[a-f0-9]{64}$")) throw new ProcessingException("JOB_IDENTITY_INVALID");
    var source = config.Sources.SingleOrDefault(s => s.Id == request.SourceId && s.Projects.Contains(request.ProjectId, StringComparer.Ordinal) && s.Owners.Contains(request.Owner, StringComparer.Ordinal)) ?? throw new ProcessingException("SOURCE_ACCESS_REJECTED");
    var file = Sources.FileWithin(source.Root, request.File);
    byte[] bytes;
    using (var stream = Sources.Open(source.Root, file)) {
        if (stream.Length > Sources.Limit) throw new ProcessingException("SOURCE_LIMIT");
        using var copy = new MemoryStream(); var buffer = new byte[16384]; int length;
        while ((length = stream.Read(buffer)) > 0) { if (copy.Length + length > Sources.Limit) throw new ProcessingException("SOURCE_LIMIT"); copy.Write(buffer, 0, length); }
        bytes = copy.ToArray();
    }
    if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != request.SourceSha256) throw new ProcessingException("SOURCE_CHANGED");
    var records = Sources.Parse(bytes, source.Format);
    if (args[0] == "inspect") { Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(Sources.Describe(records), Data.Json)); return; }
    if (request.Mode is not ("export" or "deliver") || !Regex.IsMatch(request.Subject ?? "", "^[a-f0-9]{64}$")) throw new ProcessingException("JOB_MODE_OR_SELECTION_INVALID");
    using var cancellation = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    using var term = System.Runtime.InteropServices.PosixSignalRegistration.Create(System.Runtime.InteropServices.PosixSignal.SIGTERM, context => { context.Cancel = true; cancellation.Cancel(); });
    var monitor = Task.Run(async () => { try { while (!cancellation.IsCancellationRequested) { if (File.Exists(Path.Combine(directory, "cancel"))) { cancellation.Cancel(); break; } await Task.Delay(200, cancellation.Token); } } catch (OperationCanceledException) { } });
    try {
        await using var models = await ModelContext.Connect(config, request, cancellation.Token);
        var mapping = new Mapping(models.MappingJson); mapping.VerifyExamples();
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
        var configurationHash = Data.Hash(Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(new { source, destination }, Data.Json)));
        var stateFile = Path.Combine(directory, "state.json");
        if (File.Exists(stateFile) && Data.Read<JobState>(stateFile).ConfigurationSha256 != configurationHash) throw new ProcessingException("JOB_CONNECTION_CONFIGURATION_CHANGED");
        var state = new JobState { ConfigurationSha256 = configurationHash, Status = "RUNNING", MappingSha256 = Data.Hash(models.MappingJson), SourceSchemaSha256 = mapping.SchemaHash };
        var groups = mapping.Group(records);
        Directory.CreateDirectory(Path.Combine(directory, "outputs")); Directory.CreateDirectory(Path.Combine(directory, "quarantine")); Directory.CreateDirectory(Path.Combine(directory, "evidence"));
        void Progress() {
            var rows = Directory.EnumerateFiles(directory, "row-*.json").Select(file => Data.Read<Row>(file)).ToArray();
            state.Checkpoint = rows.Count(r => r.Complete); state.Read = rows.Sum(r => r.SourceCount); state.Transformed = rows.Where(r => r.Transformed).Sum(r => r.SourceCount);
            state.Rejected = rows.Where(r => r.Rejected).Sum(r => r.SourceCount); state.Exported = rows.Sum(r => r.ExportCount);
            state.Emitted = rows.Sum(r => r.Receipts.Count(v => v.State is "CREATED" or "ALREADY_PRESENT"));
            state.DeliveryFailed = rows.Sum(r => r.Receipts.Count(v => v.State is not ("CREATED" or "ALREADY_PRESENT" or "UNCERTAIN")));
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
                try {
                    if (source.Format == "fhir-json") {
                        var inputs = groups[index].Record["_group"]?["records"] as JsonArray ?? new JsonArray(groups[index].Record.DeepClone());
                        for (var inputIndex = 0; inputIndex < inputs.Count; inputIndex++) await validation.Fhir((JsonObject)inputs[inputIndex]!, Path.Combine(directory, "evidence", $"input-{index:D6}-{inputIndex:D6}"), cancellation.Token);
                    }
                    if (mapping.RequiresOpenEhrInput) {
                        var inputs = groups[index].Record["_group"]?["records"] as JsonArray ?? new JsonArray(groups[index].Record.DeepClone());
                        for (var inputIndex = 0; inputIndex < inputs.Count; inputIndex++) await validation.Composition((JsonObject)inputs[inputIndex]!, Path.Combine(directory, "evidence", $"input-openehr-{index:D6}-{inputIndex:D6}.json"), cancellation.Token);
                    }
                    var mapped = mapping.Transform(groups[index].Record);
                    // Validate the complete source record's outputs before the first destination write.
                    for (var output = 0; output < mapped.Count; output++) {
                        var prefix = Path.Combine(directory, "evidence", $"{index:D6}-{output:D3}");
                        if (mapping.Direction == "source-to-fhir" || mapping.ProducesOpenEhr) {
                            var composition = mapping.Direction == "source-to-fhir" ? mapped[output].Composition! : mapped[output].Output;
                            await validation.Composition(composition, prefix + "-openehr.json", cancellation.Token);
                        }
                        if (mapping.ProducesFhir) await validation.Fhir(mapped[output].Output, prefix + "-fhir", cancellation.Token);
                        Data.Write(prefix + "-provenance.json", new { sourceId = request.SourceId, sourceSha256 = request.SourceSha256, group = index, mapped[output].Provenance, mapped[output].Unmapped, mappingSha256 = state.MappingSha256 });
                    }
                    if (mapping.Reversibility == "retained-context") Data.Write(Path.Combine(directory, "evidence", $"{index:D6}-retained-source.json"), groups[index].Record);
                    row.Transformed = true;
                    for (var output = 0; output < mapped.Count; output++) {
                        await models.Refresh(cancellation.Token); cancellation.Token.ThrowIfCancellationRequested();
                        var resource = mapped[output].Output;
                        var outputFile = Path.Combine(directory, "outputs", $"{index:D6}-{output:D3}.json");
                        Data.Write(outputFile, resource);
                        if (delivery is null) row.ExportCount = output + 1;
                        else {
                            var receiptFile = outputFile + ".receipt";
                            var receipt = File.Exists(receiptFile) ? Data.Read<DeliveryReceipt>(receiptFile) : null;
                            if (receipt is not null && (receipt.ResourceSha256 != FhirDelivery.PayloadHash(resource) || receipt.DestinationSha256 != delivery.DestinationHash)) throw new ProcessingException("DELIVERY_RECEIPT_MISMATCH");
                            if (receipt?.State is not ("CREATED" or "ALREADY_PRESENT")) {
                                receipt = await delivery.Send(resource, cancellation.Token); Data.Write(receiptFile, receipt);
                            }
                            if (row.Receipts.Count <= output) row.Receipts.Add(receipt); else row.Receipts[output] = receipt;
                            Data.Write(rowFile, row); Progress();
                            if (receipt.State == "UNCERTAIN") { state.Status = "DELIVERY_UNCERTAIN"; state.Error = "RETRY_REQUIRES_RECONCILIATION"; Progress(); Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(state, Data.Json)); return; }
                        }
                        Data.Write(rowFile, row); Progress();
                    }
                    row.Complete = true; Data.Write(rowFile, row); Progress();
                } catch (ProcessingException error) when (error.Code.StartsWith("RECORD_", StringComparison.Ordinal)) {
                    row.Rejected = true; row.Complete = true; row.Error = error.Code;
                    Data.Write(Path.Combine(directory, "quarantine", $"{index:D6}.json"), new { group = index, code = error.Code, sourceId = request.SourceId, record = groups[index].Record });
                    Data.Write(rowFile, row); Progress();
                }
            }
            var exportFile = Path.Combine(directory, "export.ndjson"); var temporary = exportFile + ".tmp";
            using (var writer = new StreamWriter(temporary, false, new System.Text.UTF8Encoding(false))) foreach (var output in Directory.EnumerateFiles(Path.Combine(directory, "outputs"), "*.json").Order(StringComparer.Ordinal)) writer.WriteLine(File.ReadAllText(output));
            File.Move(temporary, exportFile, true);
            var quarantineFile = Path.Combine(directory, "quarantine.ndjson");
            using (var writer = new StreamWriter(quarantineFile + ".tmp", false, new System.Text.UTF8Encoding(false))) foreach (var rejected in Directory.EnumerateFiles(Path.Combine(directory, "quarantine"), "*.json").Order(StringComparer.Ordinal)) writer.WriteLine(File.ReadAllText(rejected));
            File.Move(quarantineFile + ".tmp", quarantineFile, true);
            state.Status = state.Rejected > 0 || state.DeliveryFailed > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED"; state.Error = null; Progress();
        } catch (OperationCanceledException) { state.Status = "CANCELLED"; state.Error = null; Progress(); }
        catch (ProcessingException error) { state.Status = "BLOCKED"; state.Error = error.Code; Progress(); }
        catch { state.Status = "INTERRUPTED"; state.Error = "PROCESSING_INTERRUPTED"; Progress(); }
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(state, Data.Json));
    } finally { cancellation.Cancel(); await monitor; }
} catch (ProcessingException error) { Console.Error.WriteLine(error.Code); Environment.ExitCode = 1; }
catch { Console.Error.WriteLine("PROCESSING_FAILED"); Environment.ExitCode = 1; }

public sealed class Row {
    public int SourceCount { get; set; }
    public bool Complete { get; set; }
    public bool Transformed { get; set; }
    public bool Rejected { get; set; }
    public int ExportCount { get; set; }
    public string? Error { get; set; }
    public List<DeliveryReceipt> Receipts { get; set; } = [];
}
