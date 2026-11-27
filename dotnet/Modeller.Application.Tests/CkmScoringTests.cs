using System.Text.Json.Nodes;
using Modeller.Application;
static class CkmScoringTests
{
    public static void Run(Action<bool,string> check){
        JsonObject Row(string name="Blood pressure",string status="PUBLISHED",string project="Custom")=>new(){["resourceMainDisplayName"]=name,["resourceMainId"]="openEHR-EHR-OBSERVATION.blood_pressure.v1",["status"]=status,["projectName"]=project};
        int Score(JsonObject row,bool archetype=true)=>RemoteDefinitions.CkmScore(row,"blood pressure",archetype);
        check(Score(Row(),false)>Score(Row("Blood pressure trend"),false),"CKM exact concept outranks broader name");
        check(Score(Row(status:"PUBLISHED"))>Score(Row(status:"DRAFT")),"CKM published status retained");
        check(Score(Row(project:"Common resources"))>Score(Row()),"CKM shared resource ranking retained");
        var old=Row(status:"DRAFT");old["creationTime"]="2020-01-01T00:00:00Z";old["modificationTime"]="2021-01-01T00:00:00Z";check(Score(old)<Score(Row(status:"DRAFT")),"CKM old draft penalty retained");
        var template=Row("Other");var baseline=Score(template,false);template["resourceMainId"]="unrelated";check(baseline==Score(template,false),"CKM template ranking ignores archetype identity");
        var numeric=Row(status:"INITIAL");numeric["creationTime"]=1577836800000L;check(Score(numeric)<Score(Row(status:"INITIAL")),"CKM numeric epoch dates retain age evidence");
        var shape=Row();shape["resourceMainDisplayName"]=new JsonObject();check(Score(shape)<Score(Row()),"CKM non-scalar fields are not invented text");
    }
}
