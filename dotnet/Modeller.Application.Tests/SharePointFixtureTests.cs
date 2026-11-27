using System.Text.Json.Nodes;
using Modeller.Application;
using Modeller.Core;

static class SharePointFixtureTests
{
    public static void Run(){
        var checks=0;void Check(bool condition,string label){if(!condition)throw new Exception("SHAREPOINT_FIXTURE_FAILED: "+label);checks++;}
        var repository=new SharePointRepository("/fixture-data/repository","shared");var project="synthetic";
        repository.Create(project,"Synthetic repository","No clinical records");Check(repository.List().Count==1,"OAuth and schema-backed project creation");
        var a=repository.Save(project,"requirements/rules.md","Original user instructions é\n",new JsonObject(),null);
        var b=repository.Save(project,"requirements/rules.md","Revised instructions require confirmation\n",new JsonObject(),a["revision"]!.GetValue<string>());
        Check(repository.Artifact(project,"requirements/rules.md",a["revision"]!.GetValue<string>())["content"]!.GetValue<string>()=="Original user instructions é\n","immutable historical bytes");
        Check(repository.History(project,"requirements/rules.md").Count==2,"conditional snapshot history");
        try{repository.Save(project,"requirements/rules.md","stale",new JsonObject(),a["revision"]!.GetValue<string>());throw new Exception("Stale write accepted");}catch(ProcessingException error){Check(error.Code=="REVISION_CONFLICT","stale expected revision rejected");}
        var binary=repository.Original(project,"source.bin",[0,255,1,2],new JsonObject());Check(Convert.FromBase64String(repository.Artifact(project,binary["path"]!.GetValue<string>(),binary["revision"]!.GetValue<string>())["content_base64"]!.GetValue<string>()).SequenceEqual(new byte[]{0,255,1,2}),"binary import original unchanged");
        var restarted=new SharePointRepository("/fixture-data/repository-restarted","shared");Check(restarted.Artifact(project,"requirements/rules.md")["revision"]!.GetValue<string>()==b["revision"]!.GetValue<string>(),"new adapter reads remote authoritative state");
        Check(!Directory.GetFiles("/fixture-data/repository","*",SearchOption.AllDirectories).Any(),"model snapshots not silently persisted locally");
        Console.WriteLine(new JsonObject{["suite"]="sharepoint-functional-https",["status"]="PASS",["checks"]=checks,["clinicalData"]=false}.ToJsonString());
    }
}
