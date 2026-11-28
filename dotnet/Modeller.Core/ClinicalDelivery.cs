using System.Text.Json.Nodes;
namespace Modeller.Core;
public sealed class ClinicalDelivery : IDisposable {
    public FhirDelivery? Fhir {get;}
    public OpenEhrDelivery? OpenEhr {get;}
    public ClinicalDelivery(Configuration configuration,DestinationConnection destination) {
        if(destination.Standard=="fhir")Fhir=new(configuration,destination);
        else if(destination.Standard=="openehr")OpenEhr=new(configuration,destination);
        else throw new ProcessingException("DESTINATION_STANDARD_UNSUPPORTED");
    }
    public string DestinationHash=>Fhir?.DestinationHash??OpenEhr!.DestinationHash;
    public static string Hash(JsonObject resource)=>resource["_type"]?.GetValue<string>()=="COMPOSITION"?OpenEhrDelivery.PayloadHash(resource):FhirDelivery.PayloadHash(resource);
    public string PayloadHash(JsonObject resource)=>OpenEhr is null?FhirDelivery.PayloadHash(resource):OpenEhrDelivery.PayloadHash(resource);
    public Task Check(string version,CancellationToken cancellation)=>Fhir?.Check(version,cancellation)??Task.CompletedTask;
    public async Task<DeliveryReceipt> Send(JsonObject resource,string patientSystem,string patientValue,Action beforeWrite,Func<JsonObject,CancellationToken,Task> validateFinal,CancellationToken cancellation) {
        if(OpenEhr is not null)return await OpenEhr.Send(resource,patientSystem,patientValue,beforeWrite,validateFinal,cancellation);
        beforeWrite();return await Fhir!.Send(resource,cancellation);
    }
    public void Dispose(){Fhir?.Dispose();OpenEhr?.Dispose();}
}
