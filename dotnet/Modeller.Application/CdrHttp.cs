using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Application;

/// <summary>Bounded outbound clinical API reads. No direct database driver or arbitrary redirect is exposed.</summary>
public static class CdrHttp
{
    private static HashSet<string> Allowed()=>(Environment.GetEnvironmentVariable("CDR_ALLOWED_HOSTS")??"").Split(',',StringSplitOptions.TrimEntries|StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
    public static Uri Validate(string value){if(value.Length>1000||value.Any(char.IsControl)||!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.UserInfo!=""||uri.Fragment!=""||uri.Query!=""||uri.Scheme!="https"&&!(uri.Scheme=="http"&&Environment.GetEnvironmentVariable("CDR_ALLOW_HTTP")=="true"&&Allowed().Contains(uri.Host)))throw new ProcessingException("CDR_URL_DENIED");var allowed=Allowed();if(allowed.Count>0&&!allowed.Contains(uri.Host))throw new ProcessingException("CDR_URL_DENIED");if(IPAddress.TryParse(uri.Host,out var ip)&&Private(ip)&&!allowed.Contains(uri.Host))throw new ProcessingException("CDR_URL_DENIED");return uri;}
    public static bool Private(IPAddress ip){if(ip.IsIPv4MappedToIPv6)ip=ip.MapToIPv4();var b=ip.GetAddressBytes();if(b.Length==4)return b[0] is 0 or 10 or 127||b[0]>=224||b[0]==169&&b[1]==254||b[0]==172&&b[1] is >=16 and <=31||b[0]==192&&b[1] is 168 or 0||b[0]==100&&b[1] is >=64 and <=127||b[0]==198&&b[1] is 18 or 19;return (b[0]&0xe0)!=0x20||b[0]==0x20&&b[1]==0x01&&b[2]==0x0d&&b[3]==0xb8||b[0]==0x20&&b[1]==0x02;}
    public static async Task<JsonObject> Send(string value,HttpMethod method,JsonNode? body,Dictionary<string,string> headers,int timeout,string ca,CancellationToken cancellation,bool form=false){
        try{return Data.ParseStrict(Encoding.UTF8.GetBytes(await SendText(value,method,body,headers,timeout,ca,cancellation,form))) as JsonObject??throw new ProcessingException("CDR_RESPONSE_INVALID");}
        catch(System.Text.Json.JsonException){throw new ProcessingException("CDR_RESPONSE_INVALID");}
    }
    public static async Task<string> SendText(string value,HttpMethod method,JsonNode? body,Dictionary<string,string> headers,int timeout,string ca,CancellationToken cancellation,bool form=false,string accept="application/json"){
        var uri=Validate(value);var allowPrivate=Allowed().Contains(uri.Host);using var handler=new SocketsHttpHandler{AllowAutoRedirect=false,UseProxy=false,ConnectTimeout=TimeSpan.FromSeconds(5),MaxResponseHeadersLength=32,MaxConnectionsPerServer=2};
        handler.ConnectCallback=async(context,token)=>{if(!context.DnsEndPoint.Host.Equals(uri.Host,StringComparison.OrdinalIgnoreCase)||context.DnsEndPoint.Port!=uri.Port)throw new ProcessingException("CDR_ORIGIN_MISMATCH");var addresses=await Dns.GetHostAddressesAsync(uri.Host,token);if(addresses.Length==0||!allowPrivate&&addresses.Any(Private))throw new ProcessingException("CDR_URL_DENIED");Exception? last=null;foreach(var address in addresses){var socket=new Socket(address.AddressFamily,SocketType.Stream,ProtocolType.Tcp);try{await socket.ConnectAsync(new IPEndPoint(address,uri.Port),token);return new NetworkStream(socket,true);}catch(Exception error){socket.Dispose();last=error;}}throw new HttpRequestException("CDR_CONNECTION_FAILED",last);};
        if(ca!=""){
            if(ca.Length>32768)throw new ProcessingException("CDR_INVALID_CA");var root=X509Certificate2.CreateFromPem(ca);
            handler.SslOptions.RemoteCertificateValidationCallback=(_,certificate,_,errors)=>{if(certificate is null||(errors&SslPolicyErrors.RemoteCertificateNameMismatch)!=0)return false;using var chain=new X509Chain();chain.ChainPolicy.TrustMode=X509ChainTrustMode.CustomRootTrust;chain.ChainPolicy.CustomTrustStore.Add(root);chain.ChainPolicy.RevocationMode=X509RevocationMode.NoCheck;using var leaf=new X509Certificate2(certificate);return chain.Build(leaf);};
        }
        using var client=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(Math.Clamp(timeout,1,120))};using var request=new HttpRequestMessage(method,uri);request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue(accept));
        foreach(var (name,valueHeader)in headers){if(valueHeader.Any(c=>c<' '||c=='\u007f')||new[]{"host","cookie","content-length","content-type","connection","transfer-encoding"}.Contains(name.ToLowerInvariant()))throw new ProcessingException("CDR_INVALID_HEADER");request.Headers.Add(name,valueHeader);}
        if(body is not null)request.Content=form?new FormUrlEncodedContent(((JsonObject)body).Select(p=>new KeyValuePair<string,string>(p.Key,p.Value?.GetValue<string>()??""))):new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");
        using var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);if(!response.IsSuccessStatusCode)throw new ProcessingException((int)response.StatusCode is 401 or 403?"CDR_PERMISSION_DENIED":"CDR_UPSTREAM_FAILED");if(response.Content.Headers.ContentLength>8388608)throw new ProcessingException("CDR_RESPONSE_LIMIT");
        await using var stream=await response.Content.ReadAsStreamAsync(cancellation);using var output=new MemoryStream();var buffer=new byte[16384];int size;
        while((size=await stream.ReadAsync(buffer,cancellation))>0){if(output.Length+size>8388608)throw new ProcessingException("CDR_RESPONSE_LIMIT");output.Write(buffer,0,size);}
        try{return new UTF8Encoding(false,true).GetString(output.ToArray());}catch(DecoderFallbackException){throw new ProcessingException("CDR_RESPONSE_INVALID");}
    }
}
