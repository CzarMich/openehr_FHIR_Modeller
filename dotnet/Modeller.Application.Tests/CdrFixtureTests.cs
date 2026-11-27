using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class CdrFixtureTests
{
    public static async Task Run(){
        var checks=0;void Check(bool condition,string label){if(!condition)throw new Exception("CDR_FIXTURE_FAILED: "+label);checks++;}
        var actor=new ModellingIdentity("fixture-human","synthetic",true,[],false,["modeller"],true,"interactive_local");using var engine=new StandardsGateway();var workspace=new CdrWorkspace(engine,actor);
        var connection=workspace.SaveConnection(new JsonObject{["name"]="Synthetic CDR",["baseUrl"]="https://cdr-fixture",["auth"]="bearer",["secrets"]=new JsonObject{["token"]="fixture-cdr-token"},["caCertificate"]=File.ReadAllText("/fixture-data/tls.crt")});var id=connection["id"]!.GetValue<string>();
        Check(connection["hasCredentials"]!.GetValue<bool>()&&!connection.ToJsonString().Contains("fixture-cdr-token"),"save redacts credentials");
        var templates=await workspace.Templates(id,null,CancellationToken.None);Check(templates["source"]!.GetValue<string>()=="remote_cdr"&&templates["items"]?[0]?["identifier"]?.GetValue<string>()=="Synthetic","HTTPS catalogue array normalized");
        var template=await workspace.Templates(id,"Synthetic",CancellationToken.None);Check(template["format"]!.GetValue<string>()=="opt14"&&template["sha256"]!.GetValue<string>()==Data.Hash(template["content"]!.GetValue<string>()),"XML original bytes and hash preserved");
        Check((await workspace.Execute("cdr_connection_test",new JsonObject{["connection_id"]=id},CancellationToken.None))["connected"]!.GetValue<bool>(),"connection test accepts array");
        var agent=actor with{Human=false};try{await new CdrWorkspace(engine,agent).Execute("aql_execute",new JsonObject(),CancellationToken.None);throw new Exception("MCP query accepted");}catch(ProcessingException error){Check(error.Code=="CDR_BROWSER_ONLY","MCP does not expose results");}
        var native=!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("OPENEHR_ENGINE_URL"));
        if(native){
            var result=await workspace.Query(new JsonObject{["connection_id"]=id,["query"]="SELECT e/ehr_id/value FROM EHR e WHERE e/ehr_id/value = $ehr",["parameters"]=new JsonObject{["ehr"]="00000000-0000-0000-0000-000000000000"},["fetch"]=1,["offset"]=0},CancellationToken.None);
            Check(result["count"]!.GetValue<int>()==0&&result["results_persisted"]!.GetValue<bool>()==false&&result["results_sent_to_ai"]!.GetValue<bool>()==false,"actual native grammar and portable parameter request");
            var history=workspace.History();Check(history["items"]?[0]?["status"]?.GetValue<string>()=="SUCCEEDED"&&!history.ToJsonString().Contains("00000000-0000-0000-0000-000000000000")&&!history.ToJsonString().Contains("\"rows\""),"history excludes parameter values and rows");
        }
        Check(!File.ReadAllText(Directory.GetFiles("/fixture-data/cdr","*.json").Single()).Contains("fixture-cdr-token"),"stored credentials encrypted");
        Console.WriteLine(new JsonObject{["suite"]="cdr-functional-https",["status"]="PASS",["checks"]=checks,["nativeQueryExecuted"]=native,["clinicalData"]=false}.ToJsonString());
    }
}
