using System.Text.Json;
using System.Text.Json.Nodes;
using Modeller.Core;
using Modeller.Database;
namespace Modeller.Application;

public static class DatabaseDiscovery
{
    public static async Task<JsonNode> Execute(string name,JsonObject args,ModellingIdentity actor,CancellationToken cancellation){
        if(Environment.GetEnvironmentVariable("SOURCE_DATABASE_ENABLED")!="true")throw new ProcessingException("SOURCE_DATABASE_DISABLED");
        var project=Data.Required(args,"project");actor.Read(project);
        var id=Data.Required(args,"sourceProfile");var root=Environment.GetEnvironmentVariable("SOURCE_DATABASE_PROFILES_DIR")??"/run/secrets/source-databases";
        var profile=SqlSourceProfile.Load(root,id,actor.Tenant,project);using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellation);timeout.CancelAfter(TimeSpan.FromSeconds(45));
        await using var source=await SqlServerSource.Open(profile,timeout.Token);var catalogue=await source.Discover(timeout.Token);
        var fingerprint=catalogue.Fingerprint;
        if(name=="source_database_discover"){
            var query=KnowledgeCorpus.Text(args,"query");var after=args["afterTableId"]?.GetValue<int>()??0;var limit=args["limit"]?.GetValue<int>()??25;
            var page=catalogue.Search(query,after,limit);
            var items=new JsonArray(page.Select(t=>(JsonNode)new JsonObject{["id"]=t.Id,["schema"]=t.Schema,["name"]=t.Name,["columnCount"]=t.Columns.Length,["hasPrimaryKey"]=t.Columns.Any(c=>c.KeyOrdinal>0)}).ToArray());
            return new JsonObject{["sourceProfile"]=id,["schemaFingerprint"]=fingerprint,["tables"]=items,["nextAfterTableId"]=page.Length==limit?page[^1].Id:null,["metadataOnly"]=true,["readOnly"]=true,["clinicalMeaningConfirmed"]=false};
        }
        if(Data.Required(args,"schemaFingerprint")!=fingerprint)throw new ProcessingException("SOURCE_SCHEMA_CHANGED");
        if(name=="source_database_table"){
            var table=catalogue.Table(args["tableId"]!.GetValue<int>());var after=args["afterColumnId"]?.GetValue<int>()??0;var page=table.Columns.Where(c=>c.Id>after).Take(100).ToArray();
            return new JsonObject{["schemaFingerprint"]=fingerprint,["id"]=table.Id,["schema"]=table.Schema,["name"]=table.Name,["columns"]=JsonSerializer.SerializeToNode(page,JsonSerializerOptions.Web),["nextAfterColumnId"]=page.Length==100?page[^1].Id:null,["keys"]=JsonSerializer.SerializeToNode(catalogue.Keys.Where(k=>k.FromTable==table.Id||k.ToTable==table.Id).Take(100),JsonSerializerOptions.Web),["metadataOnly"]=true,["clinicalMeaningConfirmed"]=false};
        }
        if(name=="source_database_plan_check"){
            var plan=args["plan"]!.Deserialize<SourcePlan>(JsonSerializerOptions.Web)??throw new ProcessingException("SOURCE_PLAN_INVALID");
            if(plan.Filters is null||plan.Fields is null||plan.Joins is null||plan.Filters.Length!=0)throw new ProcessingException("SOURCE_PLAN_INVALID");
            var compiled=SourcePlanCompiler.Compile(catalogue,plan);
            return new JsonObject{["schemaFingerprint"]=fingerprint,["sqlShape"]=compiled.Sql,["metadataOnly"]=true,["executable"]=false,["requiresHumanConfirmation"]=true,["clinicalApproval"]=false,["notice"]="This checks structural compatibility only. Confirm clinical meanings, joins, selection criteria, narrative rules and exact destination profiles before any private extraction or mapping. Patient-specific filter values must stay in the private workspace."};
        }
        throw new ProcessingException("TOOL_NOT_FOUND");
    }
}
