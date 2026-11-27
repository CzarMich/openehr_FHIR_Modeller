using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

public sealed record ClinicalReferencePolicy(string Role, string TargetType, string Path, string Mode, bool RequireDestination = true);
public sealed record ClinicalPublication(string ResourceType, string Role);
public sealed record ClinicalPolicy(int SchemaVersion, string IdentityDomain, string DestinationId, int PrivacyPolicyRevision,
    bool PseudonymisePatientIdentifiers, string? PseudonymSystem, ClinicalReferencePolicy[] References,
    ClinicalPublication[] Publications, int HoldDays = 30)
{
    public static ClinicalPolicy Parse(JsonObject value) {
        var result = JsonSerializer.Deserialize<ClinicalPolicy>(value, Data.Json) ?? throw new ProcessingException("CLINICAL_POLICY_REQUIRED");
        if (result.SchemaVersion != 1 || string.IsNullOrWhiteSpace(result.IdentityDomain) || result.IdentityDomain.Length > 256 || result.IdentityDomain.Any(char.IsControl)
            || string.IsNullOrWhiteSpace(result.DestinationId) || result.DestinationId.Length > 256 || result.DestinationId.Any(char.IsControl)
            || result.PrivacyPolicyRevision < 0 || result.HoldDays is < 1 or > 366 || result.References is null || result.References.Length > 64 || result.Publications is null || result.Publications.Length > 32) throw new ProcessingException("CLINICAL_POLICY_INVALID");
        if (result.PseudonymisePatientIdentifiers != (result.PseudonymSystem is not null)
            || result.PseudonymSystem is not null && (!Uri.TryCreate(result.PseudonymSystem, UriKind.Absolute, out var uri) || uri.Scheme is not ("urn" or "http" or "https") || uri.UserInfo.Length != 0 || result.PseudonymSystem.Any(char.IsWhiteSpace))) throw new ProcessingException("PSEUDONYM_NAMESPACE_REQUIRED");
        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (var reference in result.References) {
            if (reference is null || !Regex.IsMatch(reference.Role ?? "", "^[A-Za-z][A-Za-z0-9_]{0,63}$") || !Regex.IsMatch(reference.TargetType ?? "", "^[A-Z][A-Za-z0-9]{1,63}$")
                || reference.Mode is not ("logical" or "literal" or "resolve-literal") || string.IsNullOrWhiteSpace(reference.Path) || !reference.Path.StartsWith('/') || reference.Path.Length > 2048
                || reference.Path.Any(char.IsControl) || !paths.Add(reference.Path) || reference.Mode != "logical" && !reference.RequireDestination) throw new ProcessingException("CLINICAL_REFERENCE_POLICY_INVALID");
        }
        if (paths.Any(path => paths.Any(other => other != path && other.StartsWith(path + '/', StringComparison.Ordinal)))) throw new ProcessingException("CLINICAL_REFERENCE_PATH_OVERLAP");
        var types = new HashSet<string>(StringComparer.Ordinal);
        foreach (var publication in result.Publications) if (publication is null || !Regex.IsMatch(publication.ResourceType ?? "", "^[A-Z][A-Za-z0-9]{1,63}$") || !Regex.IsMatch(publication.Role ?? "", "^[A-Za-z][A-Za-z0-9_]{0,63}$") || !types.Add(publication.ResourceType!)) throw new ProcessingException("CLINICAL_PUBLICATION_POLICY_INVALID");
        return result;
    }
}
