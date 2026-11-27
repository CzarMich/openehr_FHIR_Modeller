using Modeller.Application;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;
using Modeller.Core;
namespace Modeller.Mcp;

public static class ApplicationAuthentication
{
    public static string Env(string key,string fallback="")=>Environment.GetEnvironmentVariable(key)??fallback;
    public static int Integer(string key,int fallback,int minimum,int maximum){var text=Env(key);var value=text==""?fallback:int.TryParse(text,out var n)?n:throw new InvalidOperationException("Invalid authentication configuration.");if(value<minimum||value>maximum)throw new InvalidOperationException("Invalid authentication configuration.");return value;}
    public static string[] Csv(string key,string fallback="")=>Env(key,fallback).Split(',',StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries);
    public static void Configure(IServiceCollection services){
        if(Env("AUTH_MODE","api_key")!="oidc")return;var issuer=Https(Env("OIDC_ISSUER"));var audience=Env("OIDC_AUDIENCE");if(audience=="")throw new InvalidOperationException("Explicit audience required.");var jwks=Https(Env("OIDC_JWKS_URI"));
        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options=>{
            options.MapInboundClaims=false;options.IncludeErrorDetails=false;options.RequireHttpsMetadata=true;options.RefreshOnIssuerKeyNotFound=true;options.ConfigurationManager=new PinnedJwks(issuer,jwks);
            options.TokenValidationParameters=new TokenValidationParameters{ValidateIssuer=true,ValidIssuer=issuer,ValidateAudience=true,ValidAudience=audience,ValidateLifetime=true,RequireExpirationTime=true,RequireSignedTokens=true,ValidateIssuerSigningKey=true,ValidAlgorithms=[SecurityAlgorithms.RsaSha256],TryAllIssuerSigningKeys=false,ClockSkew=TimeSpan.FromSeconds(Integer("OIDC_CLOCK_SKEW",60,0,120))};
            options.Events=new JwtBearerEvents{OnMessageReceived=context=>{
                var authorization=context.Request.Headers.Authorization;if(authorization.Count==0||!authorization.ToString().StartsWith("Bearer ",StringComparison.Ordinal)){context.NoResult();return Task.CompletedTask;}
                try{if(authorization.Count!=1)throw new ProcessingException("AUTHENTICATION_REQUIRED");var token=authorization.ToString()[7..];if(token.Length>16384)throw new ProcessingException("AUTHENTICATION_REQUIRED");var parts=token.Split('.');if(parts.Length!=3)throw new ProcessingException("AUTHENTICATION_REQUIRED");var header=Data.ParseStrict(Base64UrlEncoder.DecodeBytes(parts[0])) as JsonObject??throw new ProcessingException("AUTHENTICATION_REQUIRED");var payload=Data.ParseStrict(Base64UrlEncoder.DecodeBytes(parts[1])) as JsonObject??throw new ProcessingException("AUTHENTICATION_REQUIRED");
                    if(header["alg"]?.GetValue<string>()!="RS256"||header["kid"]?.GetValue<string>() is not{Length:>0 and <=200}||payload["iat"] is not JsonValue iat||!iat.TryGetValue<long>(out _)||payload["exp"] is not JsonValue exp||!exp.TryGetValue<long>(out _)||payload["nbf"] is JsonValue nbf&&!nbf.TryGetValue<long>(out _))throw new ProcessingException("AUTHENTICATION_REQUIRED");context.Token=token;
                }catch{context.Fail("AUTHENTICATION_REQUIRED");}return Task.CompletedTask;
            },OnTokenValidated=context=>{try{var principal=context.Principal??throw new ProcessingException("AUTHENTICATION_REQUIRED");VerifyClaims(principal);}catch{context.Fail("AUTHENTICATION_REQUIRED");}return Task.CompletedTask;}};
        });
    }
    private static string Https(string value){if(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.Fragment!=""||uri.Query!="")throw new InvalidOperationException("An explicit HTTPS identity endpoint is required.");return value;}
    private static JsonNode?[] ClaimNodes(ClaimsPrincipal user,string path){
        var parts=path.Split('.');var result=new List<JsonNode?>();foreach(var claim in user.FindAll(parts[0])){
            JsonNode? node=parts.Length>1||claim.ValueType is "JSON" or "JSON_ARRAY"?Data.ParseStrict(Encoding.UTF8.GetBytes(claim.Value)):JsonValue.Create(claim.Value);
            for(var i=1;i<parts.Length;i++)node=(node as JsonObject)?[parts[i]];
            if(node is JsonArray array)result.AddRange(array.Select(v=>v?.DeepClone()));else if(node is not null)result.Add(node);
        }return result.ToArray();
    }
    private static string Claim(ClaimsPrincipal user,string path){var values=ClaimNodes(user,path);if(values.Length>1)throw new ProcessingException("AUTHENTICATION_REQUIRED");return values.Length==0?"":values[0]!.GetValue<string>();}
    private static string[] Claims(ClaimsPrincipal user,string path){var values=ClaimNodes(user,path).Select(v=>v!.GetValue<string>()).ToArray();if(values.Length>100||values.Any(v=>v.Length>1000))throw new ProcessingException("AUTHENTICATION_REQUIRED");return values;}
    private static void VerifyClaims(ClaimsPrincipal user){
        var now=DateTimeOffset.UtcNow.ToUnixTimeSeconds();var skew=Integer("OIDC_CLOCK_SKEW",60,0,120);if(!long.TryParse(Claim(user,"iat"),out var issued)||!long.TryParse(Claim(user,"exp"),out var expiry)||issued>now+skew||issued<now-Integer("OIDC_MAX_TOKEN_AGE",7200,60,86400)-skew||expiry<=issued||Claim(user,"sub").Length is <1 or >300)throw new ProcessingException("AUTHENTICATION_REQUIRED");
        var clients=Csv("OIDC_ALLOWED_CLIENT_IDS");if(clients.Length>0&&!clients.Contains(Claim(user,"azp")==""?Claim(user,"appid"):Claim(user,"azp"),StringComparer.Ordinal))throw new ProcessingException("AUTHENTICATION_REQUIRED");var scopes=(Claim(user,"scope")==""?Claim(user,"scp"):Claim(user,"scope")).Split(' ',StringSplitOptions.RemoveEmptyEntries);if(Csv("OIDC_REQUIRED_SCOPES","modelling.read").Any(s=>!scopes.Contains(s,StringComparer.Ordinal)))throw new ProcessingException("AUTHENTICATION_REQUIRED");var roles=Claims(user,Env("OIDC_ROLES_CLAIM","roles"));if(Csv("OIDC_REQUIRED_ROLES").Length>0&&!Csv("OIDC_REQUIRED_ROLES").Intersect(roles,StringComparer.Ordinal).Any())throw new ProcessingException("AUTHENTICATION_REQUIRED");var tenantClaim=Env("OIDC_TENANT_CLAIM");var tenant=tenantClaim==""?Env("OIDC_ISSUER"):Claim(user,tenantClaim);if(tenant.Length is <1 or >300||Csv("OIDC_ALLOWED_TENANTS").Length>0&&!Csv("OIDC_ALLOWED_TENANTS").Contains(tenant,StringComparer.Ordinal))throw new ProcessingException("AUTHENTICATION_REQUIRED");
    }
    public static ModellingIdentity Stdio()=>new("local-stdio","shared",Env("MODEL_REPOSITORY_WRITE_ENABLED")=="true",[],false,Env("MODEL_REPOSITORY_WRITE_ENABLED")=="true"?["modeller"]:[]);
    public static ModellingIdentity Current(HttpContext? context)=>context?.Items["ModellingIdentity"] as ModellingIdentity??throw new ProcessingException("AUTHENTICATION_REQUIRED");
    public static ModellingIdentity? Authenticate(HttpContext context){
        var writes=Env("MODEL_REPOSITORY_WRITE_ENABLED")=="true";var mode=Env("AUTH_MODE","api_key");
        if(mode=="none")return Env("APP_ENV")=="production"?null:new ModellingIdentity("local-development","shared",writes,[],false,writes?["modeller"]:[]);
        if(mode=="api_key"){
            var secret=Env("AUTH_API_KEY");if(secret.Length<32||secret.Length>8192)return null;var provided=context.Request.Headers[Env("AUTH_API_KEY_HEADER","X-API-Key")];if(provided.Count!=1||!CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(secret)),SHA256.HashData(Encoding.UTF8.GetBytes(provided.ToString()))))return null;return new ModellingIdentity("api-key-service","shared",writes,[],false,writes?["modeller"]:[]);
        }
        if(mode!="oidc"||context.User.Identity?.IsAuthenticated!=true)return null;try{VerifyClaims(context.User);var issuer=Env("OIDC_ISSUER");var rawTenant=Env("OIDC_TENANT_CLAIM")==""?issuer:Claim(context.User,Env("OIDC_TENANT_CLAIM"));var subject=Claim(context.User,"sub");var scope=(Claim(context.User,"scope")==""?Claim(context.User,"scp"):Claim(context.User,"scope")).Split(' ',StringSplitOptions.RemoveEmptyEntries);var roles=Claims(context.User,Env("OIDC_ROLES_CLAIM","roles"));var canWrite=writes&&(scope.Contains("modelling.write",StringComparer.Ordinal)||Csv("OIDC_WRITE_ROLES","modeller,administrator").Intersect(roles,StringComparer.Ordinal).Any());var namespaceJson=JsonSerializer.Serialize(new[]{issuer,rawTenant},new JsonSerializerOptions{Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping});var id="oidc:"+Data.Hash(HistoricJson.Encode(new JsonArray(issuer,rawTenant,subject)));return new ModellingIdentity(id,Data.Hash(namespaceJson),canWrite,scope,Env("PROJECT_RBAC_ENABLED")=="true",canWrite?["modeller"]:[]);}catch{return null;}
    }
    private sealed class PinnedJwks(string issuer,string endpoint):IConfigurationManager<OpenIdConnectConfiguration>
    {
        private readonly SemaphoreSlim gate=new(1,1);private OpenIdConnectConfiguration? current;private DateTimeOffset expires;private long refreshVersion,loadedVersion,lastRefresh;
        public void RequestRefresh(){var now=DateTimeOffset.UtcNow.ToUnixTimeSeconds();var old=Interlocked.Read(ref lastRefresh);if(now-old>=30&&Interlocked.CompareExchange(ref lastRefresh,now,old)==old)Interlocked.Increment(ref refreshVersion);}
        public async Task<OpenIdConnectConfiguration> GetConfigurationAsync(CancellationToken cancellationToken){await gate.WaitAsync(cancellationToken);try{if(current is not null&&expires>DateTimeOffset.UtcNow&&loadedVersion==Interlocked.Read(ref refreshVersion))return current;using var client=Network.Client(TimeSpan.FromSeconds(15));using var response=await client.GetAsync(endpoint,HttpCompletionOption.ResponseHeadersRead,cancellationToken);if(!response.IsSuccessStatusCode)throw new ProcessingException("IDENTITY_UNAVAILABLE");var document=await Network.Object(response,cancellationToken,262144);if(document["keys"] is not JsonArray{Count:>0 and <=32} keys)throw new ProcessingException("IDENTITY_KEYS_INVALID");var kids=new HashSet<string>(StringComparer.Ordinal);var result=new OpenIdConnectConfiguration{Issuer=issuer};foreach(var key in keys.OfType<JsonObject>()){var id=Data.Required(key,"kid");if(key["kty"]?.GetValue<string>()!="RSA"||key["use"]?.GetValue<string>() is not(null or "sig")||key["alg"]?.GetValue<string>() is not(null or "RS256"))continue;if(id.Length>200||!kids.Add(id)||key["d"] is not null||key["p"] is not null||key["q"] is not null)throw new ProcessingException("IDENTITY_KEYS_INVALID");var jwk=new JsonWebKey(key.ToJsonString());if(jwk.KeySize<2048)throw new ProcessingException("IDENTITY_KEY_SIZE_INVALID");result.SigningKeys.Add(jwk);}if(result.SigningKeys.Count==0)throw new ProcessingException("IDENTITY_KEYS_INVALID");current=result;loadedVersion=Interlocked.Read(ref refreshVersion);expires=DateTimeOffset.UtcNow.AddMinutes(5);return result;}finally{gate.Release();}}
    }
}
