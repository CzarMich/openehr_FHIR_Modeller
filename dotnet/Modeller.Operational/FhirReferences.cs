using System.Text.Json.Nodes;
using Modeller.Core;

namespace Modeller.Operational;

public sealed record ReferenceChoice(string Mode, string TargetType);
public sealed record ReferenceResolution(string State, JsonObject? Reference = null, EntityKey? Dependency = null);

public static class FhirReferences
{
    // The caller must still validate the emitted resource against its exact confirmed profiles.
    public static ReferenceResolution Resolve(IdentityRegistry identities, DependencyQueue dependencies, OperationalScope scope,
        int confirmedPrivacyRevision, ClinicalIdentity? patientIdentity, ReferenceChoice choice, ClinicalIdentity? targetIdentity,
        string? literalReference = null) {
        if (choice.Mode is not ("logical" or "literal" or "resolve-literal") || !System.Text.RegularExpressions.Regex.IsMatch(choice.TargetType, "^[A-Z][A-Za-z0-9]{1,63}$")) throw new ProcessingException("REFERENCE_POLICY_INVALID");
        if (patientIdentity is null || identities.FindPatient(scope, patientIdentity)?.State != "VERIFIED") return new("WAITING_PATIENT_IDENTITY");
        var outboundPatientIdentity = identities.OutboundPatientIdentity(scope, patientIdentity, confirmedPrivacyRevision);
        if (targetIdentity is null) return new("WAITING_IDENTIFIER");
        IdentityRegistry.Identity(targetIdentity);
        if (choice.TargetType == "Patient" && targetIdentity != patientIdentity) return new("IDENTITY_CONFLICT");
        var patient = identities.FindPatient(scope, patientIdentity)!;
        var key = new EntityKey(choice.TargetType, targetIdentity.System, targetIdentity.Value);
        var knownTarget = dependencies.ResolveEntity(scope, key);
        if (knownTarget is not null && (knownTarget.State != "VERIFIED" || knownTarget.PatientRegistryId != patient.RegistryId)) return new("IDENTITY_CONFLICT", Dependency: key);
        if (choice.Mode == "logical") {
            var emittedIdentity = choice.TargetType == "Patient" ? outboundPatientIdentity : targetIdentity;
            if (!Uri.TryCreate(emittedIdentity.System, UriKind.Absolute, out var authority) || authority.Scheme is not ("urn" or "http" or "https") || string.IsNullOrWhiteSpace(emittedIdentity.Value)) throw new ProcessingException("REFERENCE_IDENTIFIER_INVALID");
            return new("RESOLVED", new JsonObject { ["type"] = choice.TargetType, ["identifier"] = new JsonObject { ["system"] = emittedIdentity.System, ["value"] = emittedIdentity.Value } });
        }
        var evidence = dependencies.ResolveEntity(scope, key);
        if (evidence is null) return new("WAITING_DEPENDENCIES", Dependency: key);
        if (evidence.State != "VERIFIED") return new("IDENTITY_CONFLICT", Dependency: key);
        if (choice.Mode == "literal" && (literalReference is null || literalReference != evidence.Reference)) return new("WAITING_REFERENCE_VERIFICATION", Dependency: key);
        return new("RESOLVED", new JsonObject { ["reference"] = evidence.Reference, ["type"] = choice.TargetType });
    }
}
