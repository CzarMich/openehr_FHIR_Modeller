using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Numerics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Modeller.Core;

/// <summary>Version-aware REST delivery. Querying AQL does not itself make create atomic.</summary>
public sealed class OpenEhrDelivery : IDisposable
{
    private readonly DestinationConnection destination;
    private readonly OpenEhrDestination options;
    private readonly Uri root;
    private readonly HttpClient http = Network.Client(TimeSpan.FromSeconds(45));
    public OpenEhrDelivery(Configuration configuration,DestinationConnection target) {
        destination=target; root=Network.DestinationUri(target.BaseUrl,configuration);
        options=target.OpenEhr ?? throw new ProcessingException("OPENEHR_DESTINATION_CONFIGURATION_REQUIRED");
        if(options.VersionKind is not("integer" or "utc-timestamp"))throw new ProcessingException("OPENEHR_VERSION_KIND_INVALID");
        if(options.IdentifierType==options.VersionType || options.ClientAssignedIdsQualified && (options.TargetNamespace is null || !Uri.TryCreate(options.TargetNamespace,UriKind.Absolute,out _)))throw new ProcessingException("OPENEHR_TARGET_NAMESPACE_REQUIRED");
        if(target.Standard!="openehr" || options.TemplateIds.Length is <1 or >100 || new[]{options.IdentifierIssuer,options.IdentifierType,options.VersionType}.Any(value=>string.IsNullOrWhiteSpace(value)||value.Length>256||value.Any(char.IsControl))) throw new ProcessingException("OPENEHR_DESTINATION_CONFIGURATION_INVALID");
    }
    public void Dispose()=>http.Dispose();
    public string DestinationHash=>Data.Hash(Data.Canonical(System.Text.Json.JsonSerializer.SerializeToNode(new{destination.Id,root=root.AbsoluteUri,destination.Standard,options},Data.Json)));
    public static string PayloadHash(JsonObject resource) {var body=(JsonObject)resource.DeepClone();body.Remove("uid");return Data.Hash(Data.Canonical(body));}
    public static bool Equivalent(JsonObject expected,JsonObject actual) {var left=(JsonObject)expected.DeepClone();var right=(JsonObject)actual.DeepClone();left.Remove("uid");right.Remove("uid");return JsonNode.DeepEquals(left,right);}
    private HttpRequestMessage Request(HttpMethod method,string relative,JsonObject? content=null) {
        var request=new HttpRequestMessage(method,new Uri(root,relative));
        request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",Network.Key(destination.TokenFile));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if(content is not null)request.Content=JsonContent.Create(content);
        return request;
    }
    private string Business(JsonObject resource) {
        if(resource["_type"]?.GetValue<string>()!="COMPOSITION" || !options.TemplateIds.Contains(resource["archetype_details"]?["template_id"]?["value"]?.GetValue<string>(),StringComparer.Ordinal))throw new ProcessingException("DESTINATION_TEMPLATE_SCOPE_REJECTED");
        var items=(resource["feeder_audit"]?["originating_system_item_ids"] as JsonArray)?.OfType<JsonObject>().Where(id=>id["issuer"]?.GetValue<string>()==options.IdentifierIssuer && id["type"]?.GetValue<string>()==options.IdentifierType).ToArray()??[];
        if(items.Length!=1)throw new ProcessingException("RECORD_SINGLE_COMPOSITION_BUSINESS_IDENTIFIER_REQUIRED");
        var value=Data.Required(items[0],"id");if(value.Length>256||value.Any(char.IsControl))throw new ProcessingException("RECORD_COMPOSITION_IDENTIFIER_INVALID");return value;
    }
    private BigInteger? Version(JsonObject resource) {
        var items=(resource["feeder_audit"]?["originating_system_item_ids"] as JsonArray)?.OfType<JsonObject>().Where(id=>id["issuer"]?.GetValue<string>()==options.IdentifierIssuer && id["type"]?.GetValue<string>()==options.VersionType).ToArray()??[];
        if(items.Length==0&&!options.UpdateExisting)return null;
        if(items.Length!=1 || items[0]["id"]?.GetValue<string>() is not string value)throw new ProcessingException("RECORD_MONOTONIC_SOURCE_VERSION_REQUIRED");
        if(options.VersionKind=="utc-timestamp") {
            if(!Regex.IsMatch(value,"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,7})?(?:Z|[+-][0-9]{2}:[0-9]{2})$")||!DateTimeOffset.TryParse(value,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out var timestamp))throw new ProcessingException("RECORD_EXPLICIT_SOURCE_VERSION_TIME_REQUIRED");
            return new BigInteger(timestamp.UtcTicks);
        }
        if(!Regex.IsMatch(value,"^(0|[1-9][0-9]{0,99})$"))throw new ProcessingException("RECORD_MONOTONIC_SOURCE_VERSION_REQUIRED");
        return BigInteger.Parse(value,System.Globalization.CultureInfo.InvariantCulture);
    }
    public string TargetKey(JsonObject resource,string patientSystem,string patientValue)=>Data.Hash(Data.Canonical(new JsonArray("openehr-composition-target/v1",options.TargetNamespace??root.AbsoluteUri,patientSystem,patientValue,options.IdentifierIssuer,options.IdentifierType,Business(resource))));
    private string StableUuid(JsonObject resource,string patientSystem,string patientValue) {var h=TargetKey(resource,patientSystem,patientValue);return h[..8]+"-"+h[8..12]+"-8"+h[13..16]+"-8"+h[17..20]+"-"+h[20..32];}
    private static string VersionUid(JsonObject resource) {
        var value=resource["uid"]?["value"]?.GetValue<string>()??"";
        if(!Regex.IsMatch(value,"^[a-fA-F0-9-]{36}::[A-Za-z0-9._-]{1,128}::[1-9][0-9]*(?:\\.[1-9][0-9]*)*$")||!Guid.TryParse(value.Split("::")[0],out _))throw new ProcessingException("DESTINATION_COMPOSITION_VERSION_REQUIRED");return value;
    }
    private async Task<string> Ehr(string system,string value,CancellationToken cancellation) {
        using var request=Request(HttpMethod.Get,"ehr?subject_id="+Uri.EscapeDataString(value)+"&subject_namespace="+Uri.EscapeDataString(system));
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);
        if(response.StatusCode==HttpStatusCode.NotFound)throw new ProcessingException("DESTINATION_PATIENT_EHR_REQUIRED");
        if(response.StatusCode!=HttpStatusCode.OK)throw new ProcessingException("DESTINATION_EHR_LOOKUP_UNAVAILABLE");
        var body=await Network.Object(response,cancellation);var id=body["ehr_id"]?["value"]?.GetValue<string>();
        if(!Guid.TryParse(id,out _))throw new ProcessingException("DESTINATION_EHR_ID_INVALID");
        using var status=Request(HttpMethod.Get,"ehr/"+id+"/ehr_status");using var verified=await http.SendAsync(status,HttpCompletionOption.ResponseHeadersRead,cancellation);
        if(verified.StatusCode!=HttpStatusCode.OK)throw new ProcessingException("DESTINATION_PATIENT_EVIDENCE_REQUIRED");
        var subject=(await Network.Object(verified,cancellation))["subject"]?["external_ref"];
        if(subject?["id"]?["value"]?.GetValue<string>()!=value||subject?["namespace"]?.GetValue<string>()!=system)throw new ProcessingException("DESTINATION_PATIENT_IDENTITY_MISMATCH");return id!;
    }
    private async Task<(JsonObject? Body,string? Etag)> Read(string ehr,string uid,CancellationToken cancellation) {
        if(!Guid.TryParse(uid.Split("::")[0],out _))throw new ProcessingException("DESTINATION_COMPOSITION_ID_INVALID");
        using var request=Request(HttpMethod.Get,"ehr/"+ehr+"/composition/"+Uri.EscapeDataString(uid.Split("::")[0]));
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);
        if(response.StatusCode==HttpStatusCode.NotFound)return(null,null);
        if(response.StatusCode!=HttpStatusCode.OK)throw new ProcessingException("DESTINATION_COMPOSITION_LOOKUP_UNAVAILABLE");
        var body=await Network.Object(response,cancellation);var version=VersionUid(body);
        if(version.Split("::")[0]!=uid.Split("::")[0])throw new ProcessingException("DESTINATION_COMPOSITION_ID_MISMATCH");
        return(body,response.Headers.ETag?.ToString());
    }
    private async Task<(string Ehr,JsonObject? Body,string? Etag)> Locate(JsonObject expected,string patientSystem,string patientValue,CancellationToken cancellation) {
        var business=Business(expected);_=Version(expected);var ehr=await Ehr(patientSystem,patientValue,cancellation);
        const string query="SELECT TOP 2 c/uid/value AS version_uid FROM EHR e CONTAINS COMPOSITION c WHERE e/ehr_id/value = $ehr_id AND c/feeder_audit/originating_system_item_ids/id = $source_id AND c/feeder_audit/originating_system_item_ids/issuer = $issuer AND c/feeder_audit/originating_system_item_ids/type = $identifier_type";
        using var request=Request(HttpMethod.Post,"query/aql",new(){["q"]=query,["query_parameters"]=new JsonObject{["ehr_id"]=ehr,["source_id"]=business,["issuer"]=options.IdentifierIssuer,["identifier_type"]=options.IdentifierType}});
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);
        if(response.StatusCode!=HttpStatusCode.OK)throw new ProcessingException("DESTINATION_AQL_LOOKUP_UNAVAILABLE");
        var result=await Network.Object(response,cancellation);if(result["rows"] is not JsonArray rows)throw new ProcessingException("DESTINATION_AQL_RESULT_INVALID");
        if(rows.Count>1)throw new ProcessingException("DESTINATION_COMPOSITION_IDENTIFIER_AMBIGUOUS");
        string uid;
        if(rows.Count==0)uid=StableUuid(expected,patientSystem,patientValue);
        else if(rows[0] is not JsonArray {Count:1} row || row[0]?.GetValue<string>() is not string found)throw new ProcessingException("DESTINATION_AQL_RESULT_INVALID");else uid=found;
        var actual=await Read(ehr,uid,cancellation);
        if(rows.Count==1&&actual.Body is null)throw new ProcessingException("DESTINATION_COMPOSITION_LOOKUP_INCONSISTENT");
        if(actual.Body is not null && Business(actual.Body)!=business)throw new ProcessingException("DESTINATION_COMPOSITION_IDENTITY_MISMATCH");
        return(ehr,actual.Body,actual.Etag);
    }
    private DeliveryReceipt Receipt(JsonObject expected,string state,int? status,JsonObject? actual=null)=>new(PayloadHash(expected),state,status,actual is null?null:Data.Hash(Data.Canonical(actual)),DestinationHash,actual is null?null:VersionUid(actual));
    public async Task<DeliveryReceipt?> CheckExisting(JsonObject expected,string patientSystem,string patientValue,CancellationToken cancellation) {
        var found=await Locate(expected,patientSystem,patientValue,cancellation);
        if(found.Body is null)return null;
        if(Equivalent(expected,found.Body))return Receipt(expected,"ALREADY_PRESENT",200,found.Body);
        var incoming=Version(expected);var current=Version(found.Body);
        if(incoming is not null && current is not null && current>incoming)return Receipt(expected,"SUPERSEDED",200,found.Body);
        throw new ProcessingException("DESTINATION_EXISTING_CONTENT_CONFLICT");
    }
    public async Task<DeliveryReceipt> Send(JsonObject resource,string patientSystem,string patientValue,Action beforeWrite,Func<JsonObject,CancellationToken,Task> validateFinal,CancellationToken cancellation) {
        var found=await Locate(resource,patientSystem,patientValue,cancellation);
        var body=(JsonObject)resource.DeepClone();body.Remove("uid");
        HttpMethod method;string relative;
        if(found.Body is not null) {
            if(Equivalent(body,found.Body))return Receipt(resource,"ALREADY_PRESENT",200,found.Body);
            if(!options.UpdateExisting)return Receipt(resource,"EXISTING_CONTENT_CONFLICT",200);
            var incoming=Version(resource);var current=Version(found.Body);
            if(incoming is null || current is null)throw new ProcessingException("RECORD_MONOTONIC_SOURCE_VERSION_REQUIRED");
            if(incoming<current)return Receipt(resource,"SUPERSEDED",200,found.Body);
            if(incoming==current)return Receipt(resource,"SOURCE_VERSION_CONTENT_CONFLICT",200);
            var uid=VersionUid(found.Body);
            if(found.Etag!="\""+uid+"\"")throw new ProcessingException("DESTINATION_STRONG_VERSION_ETAG_REQUIRED");
            method=HttpMethod.Put;relative="ehr/"+found.Ehr+"/composition/"+uid.Split("::")[0];
        } else {
            if(!options.ClientAssignedIdsQualified)throw new ProcessingException("DESTINATION_COMPOSITION_UUID_QUALIFICATION_REQUIRED");
            body["uid"]=new JsonObject{["_type"]="HIER_OBJECT_ID",["value"]=StableUuid(resource,patientSystem,patientValue)};
            method=HttpMethod.Post;relative="ehr/"+found.Ehr+"/composition";
        }
        using var request=Request(method,relative,body);request.Headers.Add("Prefer","return=representation");
        if(method==HttpMethod.Put)request.Headers.TryAddWithoutValidation("If-Match",found.Etag);
        await validateFinal(body,cancellation);
        beforeWrite();
        try {
            using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);var status=(int)response.StatusCode;
            if(status==429)return Receipt(resource,"RETRYABLE_NOT_SENT",status);
            if(status==412||status==409)return Receipt(resource,"VERSION_CONFLICT",status);
            if(status>=400&&status<500)return Receipt(resource,"REJECTED",status);
            if(status is not(200 or 201 or 204))return Receipt(resource,"UNCERTAIN",status);
            JsonObject? actual=null;
            if(status!=204)try{actual=await Network.Object(response,cancellation);}catch(ProcessingException){}
            if(actual is null) {
                string uid;
                if(method==HttpMethod.Put)uid=VersionUid(found.Body!);
                else if(response.Headers.Location is Uri location && root.IsBaseOf(location.IsAbsoluteUri?location:new Uri(root,location))) {
                    var uri=location.IsAbsoluteUri?location:new Uri(root,location);var prefix=new Uri(root,"ehr/"+found.Ehr+"/composition/").AbsolutePath;
                    if(!uri.AbsolutePath.StartsWith(prefix,StringComparison.Ordinal)||uri.Query.Length>0||uri.Fragment.Length>0)return Receipt(resource,"UNCERTAIN",status);
                    uid=Uri.UnescapeDataString(uri.AbsolutePath[prefix.Length..]);
                } else uid=StableUuid(resource,patientSystem,patientValue);
                actual=(await Read(found.Ehr,uid,cancellation)).Body;
            }
            if(actual is null||Business(actual)!=Business(resource)||!Equivalent(resource,actual))return Receipt(resource,"UNCERTAIN",status);
            if(method==HttpMethod.Post&&VersionUid(actual).Split("::")[0]!=StableUuid(resource,patientSystem,patientValue))return Receipt(resource,"UNCERTAIN",status);
            return Receipt(resource,method==HttpMethod.Post?"CREATED":"UPDATED",status,actual);
        }catch(Exception error) when(error is HttpRequestException or OperationCanceledException or ProcessingException or System.Text.Json.JsonException or InvalidOperationException) {return Receipt(resource,"UNCERTAIN",null);}
    }
}
