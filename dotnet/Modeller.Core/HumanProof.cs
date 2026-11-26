using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

/** Fixed-purpose, request-bound assertion from the verified browser backend. */
public sealed class HumanProof(Dictionary<string, string> keys, string browserOrigin, string[] identityIssuers, ModelStore store)
{
    private static JsonObject Decode(string value) {
        var raw = value.Replace('-', '+').Replace('_', '/'); raw = raw.PadRight((raw.Length + 3) / 4 * 4, '=');
        return Data.ParseStrict(Convert.FromBase64String(raw)) as JsonObject ?? throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
    }
    public ModelActor Verify(string token, string method, string target, string body, int maximumSessionAge = 600) {
        try {
            if (token.Length > 16384 || !Regex.IsMatch(token, "^[A-Za-z0-9_.-]+$")) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var parts = token.Split('.'); if (parts.Length != 3) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var header = Decode(parts[0]); Data.Keys(header, "alg", "typ", "kid");
            if (header["alg"]?.GetValue<string>() != "HS256" || header["typ"]?.GetValue<string>() != "openehr-integration+jwt" || !keys.TryGetValue(Data.Required(header, "kid"), out var key)) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var expected = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(parts[2]))) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var claims = Decode(parts[1]); var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var issued = claims["iat"]!.GetValue<long>(); var expiry = claims["exp"]!.GetValue<long>(); var started = claims["session_started"]!.GetValue<long>();
            if (claims["iss"]?.GetValue<string>() != browserOrigin || claims["aud"]?.GetValue<string>() != "openehr-modelling-integration" || !identityIssuers.Contains(Data.Required(claims, "identity_issuer"), StringComparer.Ordinal)
                || claims["tenant"]?.GetValue<string>() != claims["identity_issuer"]?.GetValue<string>()
                || claims["identity_method"]?.GetValue<string>() is not ("interactive_local" or "interactive_oidc")
                || issued > now + 5 || issued < now - 60 || expiry <= now || expiry <= issued || expiry > issued + 60 || started > issued || started < now - maximumSessionAge
                || claims["method"]?.GetValue<string>() != method || claims["target"]?.GetValue<string>() != target || claims["body_sha256"]?.GetValue<string>() != Data.Hash(body)) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var roles = claims["roles"] as JsonArray ?? throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var scopes = claims["project_scopes"] as JsonArray ?? throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            if (roles.Count > 100 || scopes.Count > 100 || roles.Any(r => r?.GetValueKind() != System.Text.Json.JsonValueKind.String || r.GetValue<string>().Length > 200)
                || scopes.Any(s => s?.GetValueKind() != System.Text.Json.JsonValueKind.String || !Regex.IsMatch(s.GetValue<string>(), "^(?:projects:admin|projects:create|project:[A-Za-z0-9._-]{1,100}:(?:read|write))$"))) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var owner = Data.Required(claims, "owner_hash"); if (!Regex.IsMatch(owner, "^[a-f0-9]{64}$")) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var subject = Data.Required(claims, "sub"); if (subject.Length > 300) throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED");
            var actor = new ModelActor(Data.Hash(Data.Required(claims, "identity_issuer") + "\n" + subject), owner, true, roles.Select(r => r!.GetValue<string>()).ToArray(), scopes.Select(s => s!.GetValue<string>()).ToArray());
            store.ConsumeNonce(Data.Required(claims, "jti"), expiry);
            return actor;
        } catch (ProcessingException) { throw; }
        catch { throw new ProcessingException("INTERACTIVE_ASSERTION_REQUIRED"); }
    }
}
