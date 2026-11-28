using System.Text.Json.Nodes;
using Modeller.Core;

namespace Modeller.Operational;

/// <summary>Authenticated destination reads establish exact identities. No demographic/fuzzy matching.</summary>
public sealed class DestinationEvidence(IdentityRegistry registry, DependencyQueue queue, OperationalScope scope, FhirDelivery destination)
{
    private static bool Identifier(JsonObject resource, ClinicalIdentity identity) => (resource["identifier"] as JsonArray)?.Any(item => item?["system"]?.GetValue<string>() == identity.System && item?["value"]?.GetValue<string>() == identity.Value) == true;
    public async Task<bool> Refresh(PendingMessage message, CancellationToken cancellation) {
        if (message.Input.PatientIdentity is not { } identity) return false;
        var patient = registry.FindPatient(scope, identity);
        if (patient?.State != "VERIFIED") return false;
        var outbound = registry.OutboundPatientIdentity(scope, identity, message.Input.PrivacyPolicyRevision);
        JsonObject? targetPatient = null;
        foreach (var dependency in message.Input.Dependencies.OrderBy(item => item.Type == "Patient" ? 0 : 1)) {
            var keyIdentity = dependency.Type == "Patient" ? outbound : new ClinicalIdentity(dependency.System, dependency.Value);
            var actual = await destination.FindExact(dependency.Type, keyIdentity.System, keyIdentity.Value, cancellation);
            if (actual is null) { queue.InvalidateEntity(scope, dependency, Data.Hash("destination-not-found\n" + DateTimeOffset.UtcNow.ToString("O"))); return false; }
            if (dependency.Type != "Patient") {
                targetPatient ??= await destination.FindExact("Patient", outbound.System, outbound.Value, cancellation);
                if (targetPatient is null || !PatientBinding(actual, targetPatient, outbound)) throw new ProcessingException("DESTINATION_ENTITY_PATIENT_MISMATCH");
            } else targetPatient = actual;
            queue.PublishVerifiedEntity(scope, new(dependency, dependency.Type + "/" + Data.Required(actual, "id"), Data.Hash(Data.Canonical(actual)), "VERIFIED", patient.RegistryId));
        }
        return true;
    }
    public static bool PatientBinding(JsonObject resource, JsonObject patient, ClinicalIdentity outbound) {
        // Direct subject/patient proof is required; relationships are never assumed transitive.
        var subject = resource["subject"] as JsonObject ?? resource["patient"] as JsonObject;
        if (subject is null || resource["active"]?.GetValueKind() == System.Text.Json.JsonValueKind.False) return false;
        var reference = subject["reference"]?.GetValue<string>();
        var identifier = subject["identifier"] as JsonObject;
        return reference == "Patient/" + patient["id"]?.GetValue<string>() || reference is null && identifier?["system"]?.GetValue<string>() == outbound.System && identifier?["value"]?.GetValue<string>() == outbound.Value;
    }
    public async Task Publish(ProcessingLease lease, string resourceType, ClinicalIdentity sourceIdentity, DeliveryReceipt receipt, CancellationToken cancellation) {
        if (receipt.State is not ("CREATED" or "ALREADY_PRESENT" or "UPDATED" or "SUPERSEDED") || receipt.DestinationSha256 != destination.DestinationHash || receipt.DestinationReference is null) throw new ProcessingException("VERIFIED_DESTINATION_RECEIPT_REQUIRED");
        var actual = await destination.ReadExact(receipt.DestinationReference, cancellation) ?? throw new ProcessingException("DESTINATION_RECEIPT_RESOURCE_UNAVAILABLE");
        var outboundIdentity = resourceType == "Patient" ? lease.OutboundPatientIdentity : sourceIdentity;
        if (actual["resourceType"]?.GetValue<string>() != resourceType || !Identifier(actual, outboundIdentity)) throw new ProcessingException("DESTINATION_RECEIPT_IDENTITY_MISMATCH");
        if (resourceType != "Patient") {
            var patient = await destination.FindExact("Patient", lease.OutboundPatientIdentity.System, lease.OutboundPatientIdentity.Value, cancellation);
            if (patient is null || !PatientBinding(actual, patient, lease.OutboundPatientIdentity)) throw new ProcessingException("DESTINATION_ENTITY_PATIENT_MISMATCH");
        }
        var registered = registry.FindPatient(scope, lease.Input.PatientIdentity!) ?? throw new ProcessingException("WAITING_PATIENT_IDENTITY");
        queue.PublishVerifiedEntity(scope, new(new(resourceType, sourceIdentity.System, sourceIdentity.Value), resourceType + "/" + Data.Required(actual, "id"), Data.Hash(Data.Canonical(actual)), "VERIFIED", registered.RegistryId));
    }
}
