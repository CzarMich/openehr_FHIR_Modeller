using System.Text.Json.Nodes;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record PlannedDelivery(string DestinationSha256, string SourceSha256, string MappingSha256, JsonObject[] Outputs, DeliveryReceipt?[] Receipts);
public sealed record ReconciliationLease(string Id, string LeaseId, PendingInput Input);
public sealed record RecoveryResult(string Id, int Revision, string State, int Planned, int VerifiedPresent, int Missing, bool RetryRequiresConfirmation);

public sealed partial class DependencyQueue
{
    public void PlanDelivery(OperationalScope scope, ProcessingLease lease, string destinationSha256, JsonObject[] outputs, DateTimeOffset now) {
        var token = registry.Scope(scope); Hash(destinationSha256);
        if (outputs.Length is < 1 or > 100 || outputs.Sum(output => System.Text.Encoding.UTF8.GetByteCount(output.ToJsonString())) > 8388608) throw new ProcessingException("DELIVERY_PLAN_LIMIT");
        using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", lease.Id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.State != "LEASED" || item.LeaseId != lease.LeaseId || item.LeaseUntil <= now) throw new ProcessingException("PROCESSING_LEASE_CONFLICT");
        var before = registry.Read<PlannedDelivery>(token, "delivery-plan", lease.Id, transaction);
        if (before is not null) {
            if (before.DestinationSha256 != destinationSha256 || before.SourceSha256 != item.Input.SourceSha256 || before.MappingSha256 != item.Input.MappingSha256
                || !JsonNode.DeepEquals(new JsonArray(before.Outputs.Select(output => output.DeepClone()).ToArray()), new JsonArray(outputs.Select(output => output.DeepClone()).ToArray())))
                throw new ProcessingException("DELIVERY_PLAN_CHANGED_REVIEW_REQUIRED");
        } else {
            registry.Write(token, "delivery-plan", lease.Id, 1, new PlannedDelivery(destinationSha256, item.Input.SourceSha256, item.Input.MappingSha256,
                outputs.Select(output => (JsonObject)output.DeepClone()).ToArray(), new DeliveryReceipt?[outputs.Length]), transaction);
        }
        // Bind identity policy before any request might commit, including an uncertain response.
        registry.MarkDestinationIdentityUse(scope, item.Input.PrivacyPolicyRevision, destinationSha256, transaction);
        transaction.Commit();
    }
    public void RecordDeliveryReceipt(OperationalScope scope, ProcessingLease lease, int index, DeliveryReceipt receipt, DateTimeOffset now) {
        var token = registry.Scope(scope); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", lease.Id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        var plan = registry.Read<PlannedDelivery>(token, "delivery-plan", lease.Id, transaction) ?? throw new ProcessingException("DELIVERY_PLAN_REQUIRED");
        if (item.State != "LEASED" || item.LeaseId != lease.LeaseId || item.LeaseUntil <= now || index < 0 || index >= plan.Outputs.Length) throw new ProcessingException("PROCESSING_LEASE_CONFLICT");
        if (receipt.State is not ("CREATED" or "ALREADY_PRESENT" or "UPDATED" or "SUPERSEDED") || receipt.DestinationSha256 != plan.DestinationSha256 || receipt.ResourceSha256 != ClinicalDelivery.Hash(plan.Outputs[index]) || receipt.DestinationReference is null) throw new ProcessingException("DELIVERY_RECEIPT_MISMATCH");
        var receipts = plan.Receipts.ToArray(); receipts[index] = receipt;
        registry.Write(token, "delivery-plan", lease.Id, 1, plan with { Receipts = receipts }, transaction); transaction.Commit();
    }
    public PlannedDelivery? DeliveryPlan(OperationalScope scope, string id) {
        Hash(id); return registry.Read<PlannedDelivery>(registry.Scope(scope), "delivery-plan", id);
    }
    public ReconciliationLease BeginRecovery(OperationalScope scope, string id, int expectedRevision, string sourceSha256, string actorId, string comment, DateTimeOffset now, string action = "check") {
        var token = registry.Scope(scope); Hash(id); Hash(sourceSha256);
        if (string.IsNullOrWhiteSpace(actorId) || actorId.Length > 256 || string.IsNullOrWhiteSpace(comment) || comment.Length > 4000) throw new ProcessingException("RECOVERY_REVIEW_REQUIRED");
        using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.Revision != expectedRevision || item.Input.SourceSha256 != sourceSha256 || item.State is not ("RECONCILIATION_REQUIRED" or "PROCESSING_REVIEW_REQUIRED")) throw new ProcessingException("RECOVERY_REVISION_CONFLICT");
        if (registry.Policy(scope, transaction).Revision != item.Input.PrivacyPolicyRevision) throw new ProcessingException("PRIVACY_POLICY_REVIEW_REQUIRED");
        var leaseId = Guid.NewGuid().ToString("N");
        var after = item with { Revision = item.Revision + 1, State = "RECONCILING", LeaseId = leaseId, LeaseUntil = now.AddMinutes(15) };
        Save(scope, token, after, transaction);
        registry.Write(token, "recovery-history", Guid.NewGuid().ToString("N"), after.Revision,
            new { pendingId = id, item.Input.SourceSha256, actorId, comment, action, leaseId, state = after.State, reviewedAt = now }, transaction);
        transaction.Commit(); return new(id, leaseId, item.Input);
    }
    public RecoveryResult FinishRecovery(OperationalScope scope, ReconciliationLease lease, DeliveryReceipt?[] receipts, bool confirmComplete, bool retryMissing, DateTimeOffset now) {
        var token = registry.Scope(scope); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", lease.Id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.State != "RECONCILING" || item.LeaseId != lease.LeaseId || item.LeaseUntil <= now) throw new ProcessingException("RECOVERY_LEASE_CONFLICT");
        var plan = registry.Read<PlannedDelivery>(token, "delivery-plan", lease.Id, transaction);
        if (receipts.Length != (plan?.Outputs.Length ?? 0)) throw new ProcessingException("RECOVERY_PLAN_MISMATCH");
        if (plan is not null) {
            for (var i = 0; i < receipts.Length; i++) if (receipts[i] is { } receipt && (receipt.State is not ("CREATED" or "ALREADY_PRESENT" or "UPDATED" or "SUPERSEDED") || receipt.ResourceSha256 != (plan.Outputs[i]["_type"]?.GetValue<string>()=="COMPOSITION"?OpenEhrDelivery.PayloadHash(plan.Outputs[i]):FhirDelivery.PayloadHash(plan.Outputs[i])) || receipt.DestinationSha256 != plan.DestinationSha256 || receipt.DestinationReference is null))
                throw new ProcessingException("RECOVERY_EVIDENCE_MISMATCH");
            registry.Write(token, "delivery-plan", lease.Id, 1, plan with { Receipts = receipts }, transaction);
        }
        var present = receipts.Count(receipt => receipt is not null); var missing = receipts.Length - present;
        var state = (confirmComplete || retryMissing) && plan is not null && missing == 0 ? "DELIVERED" : retryMissing ? "READY" : "RECONCILIATION_REQUIRED";
        var after = item with { Revision = item.Revision + 1, State = state, LeaseId = null, LeaseUntil = null, LastEvidenceSha256 = Data.Hash(Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(receipts, Data.Json))) };
        Save(scope, token, after, transaction);
        registry.Write(token, "recovery-history", Guid.NewGuid().ToString("N"), after.Revision, new { pendingId = after.Id, lease.LeaseId, after.State, present, missing, observedAt = now }, transaction);
        transaction.Commit();
        return new(after.Id, after.Revision, after.State, receipts.Length, present, missing, state == "RECONCILIATION_REQUIRED" && (plan is null || missing > 0));
    }
    public void AbortRecovery(OperationalScope scope, ReconciliationLease lease, string code, DateTimeOffset now) {
        var token = registry.Scope(scope); using var transaction = registry.Transaction();
        var item = registry.Read<PendingMessage>(token, "pending", lease.Id, transaction) ?? throw new ProcessingException("PENDING_INPUT_UNAVAILABLE");
        if (item.State != "RECONCILING" || item.LeaseId != lease.LeaseId) throw new ProcessingException("RECOVERY_LEASE_CONFLICT");
        Save(scope, token, item with { Revision = item.Revision + 1, State = "RECONCILIATION_REQUIRED", LeaseId = null, LeaseUntil = null, LastEvidenceSha256 = Data.Hash(code) }, transaction);
        transaction.Commit();
    }
}

/// <summary>Reads the authorised configured destination. Never takes credentials or a URL from a review request.</summary>
public static class RecoveryDestination
{
    public static DestinationConnection Resolve(Configuration configuration, string owner, string project, string id) {
        var destinations = configuration.Destinations.ToList();
        if (configuration.ConnectionsFile is not null) {
            var catalogue = Data.Read<JsonObject>(configuration.ConnectionsFile, 8 * 1048576);
            Data.Keys(catalogue, "sources", "destinations", "requireTerminology");
            foreach (var value in (catalogue["destinations"] as JsonArray ?? []).OfType<JsonObject>()) {
                var owners = value["owners"]?.AsArray().Select(item => item!.GetValue<string>()).ToArray() ?? [];
                var projects = value["projects"]?.AsArray().Select(item => item!.GetValue<string>()).ToArray() ?? [];
                if (value["id"]?.GetValue<string>() != id || !owners.Contains(owner, StringComparer.Ordinal) || !projects.Contains(project, StringComparer.Ordinal)) continue;
                destinations.Add(new(Data.Required(value, "id"), Data.Required(value, "baseUrl"), Data.Required(value, "tokenFile"), projects, owners,
                    value["resourceTypes"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray(),
                    value["readResourceTypes"]?.AsArray().Select(item => item!.GetValue<string>()).ToArray(), value["standard"]?.GetValue<string>() ?? "fhir", value["openEhr"] is JsonObject options ? System.Text.Json.JsonSerializer.Deserialize<OpenEhrDestination>(options,Data.Json) : null));
            }
        }
        return destinations.SingleOrDefault(destination => destination.Id == id && destination.Owners.Contains(owner, StringComparer.Ordinal) && destination.Projects.Contains(project, StringComparer.Ordinal)) ?? throw new ProcessingException("DESTINATION_ACCESS_REJECTED");
    }
}

public static class DeliveryRecovery
{
    public static async Task<RecoveryResult> Check(IdentityRegistry registry, DependencyQueue queue, OperationalScope scope, Configuration configuration,
        JsonObject definition, string id, int expectedRevision, string sourceSha256, string actorId, string comment, string action, CancellationToken cancellation) {
        if (action is not ("check" or "confirm" or "retry-missing")) throw new ProcessingException("RECOVERY_ACTION_INVALID");
        if (definition["mappingConfirmed"]?.GetValue<bool>() != true || definition["current"]?.GetValue<bool>() != true) throw new ProcessingException("CURRENT_HUMAN_CONFIRMATION_REQUIRED");
        var pending = queue.Inspect(scope, id, DateTimeOffset.UtcNow);
        if (pending.Input.MappingSubject != definition["subject"]?.GetValue<string>() || pending.Input.MappingSha256 != definition["mappingSha256"]?.GetValue<string>()) throw new ProcessingException("HELD_MAPPING_CHANGED");
        var plan = queue.DeliveryPlan(scope, id);
        var destination = plan is null ? null : RecoveryDestination.Resolve(configuration, scope.Owner, scope.ProjectId, scope.DestinationId);
        using var client = destination is null ? null : new ClinicalDelivery(configuration, destination);
        if (client is not null && client.DestinationHash != plan!.DestinationSha256) throw new ProcessingException("DELIVERY_DESTINATION_CHANGED");
        var lease = queue.BeginRecovery(scope, id, expectedRevision, sourceSha256, actorId, comment, DateTimeOffset.UtcNow, action);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation); deadline.CancelAfter(TimeSpan.FromMinutes(10));
        cancellation = deadline.Token;
        try {
            var receipts = new DeliveryReceipt?[plan?.Outputs.Length ?? 0];
            if (client is not null) {
                if (client.Fhir is not null && !await new DestinationEvidence(registry, queue, scope, client.Fhir).Refresh(pending, cancellation)) throw new ProcessingException("WAITING_DEPENDENCIES");
                await client.Check(Data.Required((JsonObject)definition["projectConfiguration"]!, "fhirVersion"), cancellation);
                for (var index = 0; index < plan!.Outputs.Length; index++) {
                    cancellation.ThrowIfCancellationRequested();
                    var output = plan.Outputs[index];
                    if(client.OpenEhr is not null) {
                        var patient=pending.Input.PatientIdentity??throw new ProcessingException("PATIENT_IDENTITY_REQUIRED");
                        var outbound=registry.OutboundPatientIdentity(scope,patient,pending.Input.PrivacyPolicyRevision);
                        receipts[index]=await client.OpenEhr.CheckExisting(output,outbound.System,outbound.Value,cancellation);
                        if(receipts[index] is not null && action is "confirm" or "retry-missing") DestinationWriteLease.Reconciled(registry,client.OpenEhr.TargetKey(output,outbound.System,outbound.Value),client.PayloadHash(output));
                        if(receipts[index] is null && action=="retry-missing") DestinationWriteLease.Reconciled(registry,client.OpenEhr.TargetKey(output,outbound.System,outbound.Value),client.PayloadHash(output));
                        continue;
                    }
                    var identifiers = output["identifier"] as JsonArray;
                    if (identifiers?.Count != 1 || identifiers[0] is not JsonObject identifier) throw new ProcessingException("RECOVERY_SINGLE_IDENTIFIER_REQUIRED");
                    var actual = await client.Fhir!.FindExact(Data.Required(output, "resourceType"), Data.Required(identifier, "system"), Data.Required(identifier, "value"), cancellation);
                    if (actual is null) continue;
                    var payload = (JsonObject)output.DeepClone(); payload.Remove("id");
                    if (!FhirDelivery.Equivalent(payload, actual)) throw new ProcessingException("DESTINATION_EXISTING_CONTENT_CONFLICT");
                    receipts[index] = new(FhirDelivery.PayloadHash(output), "ALREADY_PRESENT", 200, Data.Hash(Data.Canonical(actual)), client.DestinationHash, Data.Required(actual, "resourceType") + "/" + Data.Required(actual, "id"));
                }
            }
            return queue.FinishRecovery(scope, lease, receipts, action == "confirm", action == "retry-missing", DateTimeOffset.UtcNow);
        } catch (Exception error) {
            queue.AbortRecovery(scope, lease, error is ProcessingException processing ? processing.Code : "DESTINATION_RECONCILIATION_UNAVAILABLE", DateTimeOffset.UtcNow);
            throw;
        }
    }
}
