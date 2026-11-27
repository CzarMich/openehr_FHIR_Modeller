using Modeller.Application;
using System.Collections.Concurrent;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Protocol;
using Modeller.Core;
namespace Modeller.Mcp;

public static class ApplicationHost
{
    public static async Task Run(string[] arguments){
        var stdio=arguments.Contains("--stdio")||arguments.Contains("--transport=stdio")||ApplicationAuthentication.Env("MCP_TRANSPORT")=="stdio";var args=arguments.Where(a=>a is not("--stdio" or "--transport=stdio" or "--transport=streamable-http")).ToArray();
        var root=ApplicationAuthentication.Env("MODELLER_RESOURCE_ROOT","/app/resources");var guides=new GuideRepository(Path.Combine(root,"guides"));var instructions=File.ReadAllText(Path.Combine(root,"server-instructions.md"))+"\nClinical/source database connections are strictly read-only. SQL Server discovery exposes metadata only through operator-registered read-only profiles; it does not expose clinical rows or arbitrary SQL. User confirmation of exact model revisions is mandatory for mapping. Technical validation and clinical approval are separate. Patient records remain in private processing and the authenticated browser; never place them in prompts, knowledge stores or general MCP calls.";
        var version=File.Exists("/app/VERSION")?File.ReadAllText("/app/VERSION").Trim():"0.21.0";
        if(stdio){var host=Host.CreateApplicationBuilder(args);host.Logging.ClearProviders();var protocol=new ApplicationProtocol(root,guides,ApplicationAuthentication.Stdio);host.Services.AddMcpServer(options=>{options.ServerInfo=new Implementation{Name=ApplicationAuthentication.Env("MCP_SERVER_NAME","openehr-fhir-modeller"),Version=version};options.ServerInstructions=instructions;}).WithStdioServerTransport().AddApplication(protocol);await host.Build().RunAsync();return;}
        var web=WebApplication.CreateBuilder(args);web.Logging.ClearProviders();web.WebHost.ConfigureKestrel(o=>{o.AddServerHeader=false;o.Limits.MaxRequestBodySize=16777216;o.Limits.MaxRequestHeadersTotalSize=16384;o.Limits.RequestHeadersTimeout=TimeSpan.FromSeconds(10);o.Limits.MaxConcurrentConnections=128;});
        if(ApplicationAuthentication.Env("AUTH_MODE","api_key")=="api_key"&&ApplicationAuthentication.Env("AUTH_API_KEY").Length<32)throw new InvalidOperationException("A configured API credential is required.");if(!new[]{"api_key","oidc","none"}.Contains(ApplicationAuthentication.Env("AUTH_MODE","api_key"),StringComparer.Ordinal))throw new InvalidOperationException("Unknown authentication mode.");
        var accessor=new HttpContextAccessor();web.Services.AddSingleton<IHttpContextAccessor>(accessor);web.Services.AddAuthentication();ApplicationAuthentication.Configure(web.Services);
        var api=new ModellingApplication(root);var protocolHttp=new ApplicationProtocol(root,guides,()=>ApplicationAuthentication.Current(accessor.HttpContext));web.Services.AddMcpServer(options=>{options.ServerInfo=new Implementation{Name=ApplicationAuthentication.Env("MCP_SERVER_NAME","openehr-fhir-modeller"),Version=version};options.ServerInstructions=instructions;}).WithHttpTransport(o=>o.SessionMode=HttpServerSessionMode.Stateful).AddApplication(protocolHttp);
        var app=web.Build();var hosts=ApplicationAuthentication.Csv("MCP_ALLOWED_HOSTS","localhost,127.0.0.1,[::1]").ToHashSet(StringComparer.OrdinalIgnoreCase);var origins=ApplicationAuthentication.Csv("CORS_ALLOWED_ORIGINS").ToHashSet(StringComparer.Ordinal);var sessions=new ConcurrentDictionary<string,(string Actor,DateTimeOffset Expires)>(StringComparer.Ordinal);
        app.Use(async(context,next)=>{
            if(!hosts.Contains(context.Request.Host.Host)&&!hosts.Contains(context.Request.Host.Value??"")){context.Response.StatusCode=400;return;}
            if(context.Request.Headers.TryGetValue("Origin",out var origin)&&(origin.Count!=1||!origins.Contains(origin.ToString()))){context.Response.StatusCode=403;return;}
            context.Response.Headers.XContentTypeOptions="nosniff";context.Response.Headers.CacheControl="no-store";context.Response.Headers["Referrer-Policy"]="no-referrer";
            if(context.Request.Method=="OPTIONS"){if(origin.Count==1){context.Response.Headers.AccessControlAllowOrigin=origin.ToString();context.Response.Headers.AccessControlAllowMethods="POST, GET, PUT, DELETE, OPTIONS";context.Response.Headers.AccessControlAllowHeaders="Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, "+ApplicationAuthentication.Env("AUTH_API_KEY_HEADER","X-API-Key");context.Response.Headers.Vary="Origin";}context.Response.StatusCode=204;return;}await next();
        });
        app.UseAuthentication();
        app.Use(async(context,next)=>{
            var path=context.Request.Path.Value??"";var publicPath=path is "/health" or "/ready" or "/health/status"||path.StartsWith("/.well-known/",StringComparison.Ordinal);var human=path.StartsWith("/api/v1/reviews",StringComparison.Ordinal)||path.StartsWith("/api/v1/cdr/",StringComparison.Ordinal);
            if(!publicPath&&!human){var actor=ApplicationAuthentication.Authenticate(context);if(actor is null){context.Response.StatusCode=401;if(ApplicationAuthentication.Env("AUTH_MODE")=="oidc")context.Response.Headers.WWWAuthenticate="Bearer resource_metadata=\""+Metadata(context)+"\"";return;}context.Items["ModellingIdentity"]=actor;var session=context.Request.Headers["Mcp-Session-Id"];var fingerprint=actor.Tenant+":"+actor.Id;if(session.Count>1||session.ToString().Length>256){context.Response.StatusCode=400;return;}if(session.Count==1&&sessions.TryGetValue(session.ToString(),out var binding)&&(binding.Actor!=fingerprint||binding.Expires<DateTimeOffset.UtcNow)){context.Response.StatusCode=403;return;}
                if(path=="/mcp"){
                    foreach(var old in sessions.Where(s=>s.Value.Expires<DateTimeOffset.UtcNow).Take(100).ToArray())sessions.TryRemove(old.Key,out _);
                    if(session.Count==0&&sessions.Count>=512){context.Response.StatusCode=503;return;}
                    context.Response.OnStarting(()=>{var id=context.Response.Headers["Mcp-Session-Id"].ToString();if(id!="")sessions.TryAdd(id,(fingerprint,DateTimeOffset.UtcNow.AddHours(2)));return Task.CompletedTask;});
                    await next();if(context.Request.Method=="DELETE"&&session.Count==1)sessions.TryRemove(session.ToString(),out _);return;
                }
            }await next();
        });
        app.MapGet("/health",()=>Results.Json(new{status="ok"}));app.MapGet("/health/status",()=>Results.Json(new{status="ok"}));
        app.MapGet("/ready",async(CancellationToken cancellation)=>{
            try{using var client=Network.Client(TimeSpan.FromSeconds(3));var checks=await Task.WhenAll(new[]{("OPENEHR_ENGINE_URL","OPENEHR_ENGINE_KEY_FILE"),("FHIR_ENGINE_URL","FHIR_ENGINE_KEY_FILE")}.Select(async names=>{var url=ApplicationAuthentication.Env(names.Item1);if(url=="")return true;Network.Key(ApplicationAuthentication.Env(names.Item2));using var response=await client.GetAsync(url.TrimEnd('/')+"/health",HttpCompletionOption.ResponseHeadersRead,cancellation);return response.IsSuccessStatusCode;}));return Results.Json(new{status=checks.All(v=>v)?"ready":"not-ready",runtime="dotnet",guides=guides.Resources.Count},statusCode:checks.All(v=>v)?200:503);}catch{return Results.Json(new{status="not-ready"},statusCode:503);}
        });
        app.MapGet("/.well-known/oauth-protected-resource/mcp",(HttpContext context)=>Results.Json(new{resource=Resource(context),authorization_servers=ApplicationAuthentication.Env("AUTH_MODE")=="oidc"?new[]{ApplicationAuthentication.Env("OIDC_ISSUER")}:Array.Empty<string>(),bearer_methods_supported=new[]{"header"},scopes_supported=new[]{"modelling.read","modelling.write"}}));
        app.MapGet("/.well-known/oauth-protected-resource",(HttpContext context)=>Results.Redirect(Metadata(context),false));app.MapMcp("/mcp");app.MapApplication(api);app.Lifetime.ApplicationStopped.Register(api.Dispose);await app.RunAsync();
    }
    private static string Resource(HttpContext context)=>ApplicationAuthentication.Env("PRODUCT_URL") is {Length:>0} origin?origin.TrimEnd('/')+"/mcp":"https://"+context.Request.Host+"/mcp";
    private static string Metadata(HttpContext context)=>Resource(context)[..^4]+"/.well-known/oauth-protected-resource/mcp";
}
