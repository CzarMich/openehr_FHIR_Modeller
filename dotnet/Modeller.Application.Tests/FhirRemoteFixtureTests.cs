using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class FhirRemoteFixtureTests
{
    public static async Task Run(){
        var checks=0;void Check(bool condition,string label){if(!condition)throw new Exception("FHIR_REMOTE_FIXTURE_FAILED: "+label);checks++;}
        async Task Reject(Func<Task> operation,string code){try{await operation();throw new Exception("Expected "+code);}catch(ProcessingException error){Check(error.Code==code,code);}}
        using var remote=new RemoteDefinitions();Check(!remote.Connections().ToJsonString().Contains("synthetic-secret")&&!remote.Connections().ToJsonString().Contains("loginFile"),"connection summaries redact credentials");
        var health=await remote.Connection("ig","test",new JsonObject(),CancellationToken.None);Check(health["connected"]!.GetValue<bool>()&&health["capabilities"]?["status"]?.GetValue<string>()=="ok","IG accessToken login and health contract");
        var search=await remote.Connection("definitions","search",new JsonObject{["resourceType"]="StructureDefinition",["url"]="https://example.org/StructureDefinition/Synthetic"},CancellationToken.None);Check(search["returned"]!.GetValue<int>()==1&&search["hasMore"]!.GetValue<bool>()&&search["items"]?[0]?["id"]?.GetValue<string>()=="Synthetic"&&search["items"]?[0]?["type"] is null,"definition search normalization and minimal metadata");
        var read=await remote.Connection("definitions","read",new JsonObject{["resourceType"]="StructureDefinition",["resourceId"]="Synthetic"},CancellationToken.None);var content=read["content"]!.GetValue<string>();Check(content.StartsWith(' ')&&content.EndsWith('\n')&&Data.Hash(content)==read["sha256"]!.GetValue<string>()&&read["provenance"]?["clinicalApproval"]?.GetValue<bool>()==false,"original profile bytes and unapproved provenance");
        await Reject(async()=>{await remote.Connection("definitions","read",new JsonObject{["resourceType"]="StructureDefinition",["resourceId"]="WrongType"},CancellationToken.None);},"FHIR_DEFINITION_RESPONSE_INVALID");
        await Reject(async()=>{await remote.Connection("definitions","search",new JsonObject{["resourceType"]="Patient"},CancellationToken.None);},"FHIR_DEFINITION_TYPE_REQUIRED");
        await Reject(async()=>{await remote.Connection("definitions","validate",new JsonObject{["content"]=new JsonObject{["resourceType"]="Patient"}},CancellationToken.None);},"SYNTHETIC_INPUT_REQUIRED");
        var validation=await remote.Connection("definitions","validate",new JsonObject{["synthetic"]=true,["content"]=new JsonObject{["resourceType"]="Patient"}},CancellationToken.None);Check(validation["resourceType"]!.GetValue<string>()=="OperationOutcome","explicit synthetic validation");
        var stats=await remote.RequestConnection(new JsonObject{["baseUrl"]="https://fhir-remote-fixture",["credentialFile"]="/fixture-data/token"},"/stats",HttpMethod.Get,null,CancellationToken.None);Check(JsonNode.Parse(stats)?["unexpected"]?.GetValue<int>()==0,"external next link and patient endpoint never requested");
        using var engine=new StandardsGateway();var actor=new ModellingIdentity("synthetic","shared",true,[],false,["modeller"]);var repository=new SnapshotRepository("/fixture-data/projects");repository.Create("synthetic","Synthetic","");repository.Save("synthetic",FhirWorkspace.ProjectPath,new JsonObject{["connections"]=new JsonObject{["ig"]="ig"}}.ToJsonString(),new JsonObject(),null);
        var workspace=new FhirWorkspace(repository,engine,_=>{},"shared",remote,new MappingSelections(repository,repository,actor),actor);var projects=await workspace.Execute("fhir_ig",new JsonObject{["action"]="projects",["projectId"]="synthetic"},CancellationToken.None);Check(projects["total"]!.GetValue<int>()==1,"IG project array normalized without publishing");
        Console.WriteLine(new JsonObject{["suite"]="fhir-remote-functional-https",["status"]="PASS",["checks"]=checks,["clinicalData"]=false}.ToJsonString());
    }
}
