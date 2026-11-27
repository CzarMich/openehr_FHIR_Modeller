using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
using Modeller.Database;
namespace Modeller.Application;

public sealed record SourceConnector(string Id,string Label,string Family,string Qualification,string Discovery,string Notes);
public sealed class SourceDiscoveryJobs(SnapshotRepository repository,ModellingIdentity actor)
{
    public static readonly SourceConnector[] Connectors=[
        new("sqlserver","Microsoft SQL Server","database","SYNTHETIC_ACCEPTANCE_PASSED","metadata","Native .NET driver; clinical-row extraction and polling are separate qualification gates."),
        new("oracle","Oracle Database","database","QUALIFICATION_REQUIRED","not-enabled","Requires an Oracle-specific read-only connector, driver licensing/TLS configuration and isolated negative tests."),
        new("postgresql","PostgreSQL","database","QUALIFICATION_REQUIRED","not-enabled","Clinical source access is separate from the platform's internal PostgreSQL audit store."),
        new("mysql","MySQL","database","QUALIFICATION_REQUIRED","not-enabled","Requires qualified MySQL-specific permission checks and read-only operations."),
        new("mariadb","MariaDB","database","QUALIFICATION_REQUIRED","not-enabled","Qualified separately from MySQL despite protocol compatibility."),
        new("sap-hana","SAP HANA","database","QUALIFICATION_REQUIRED","not-enabled","Requires an operator-provided/qualified driver and source-specific read-only checks."),
        new("epic-fhir","Epic FHIR API","platform-api","QUALIFICATION_REQUIRED","not-enabled","Requires organisation-approved endpoint, application registration, authorised read scopes and supported-resource discovery. No Epic database layout is assumed."),
        new("sap-bw","SAP BW","platform-api","QUALIFICATION_REQUIRED","not-enabled","Select an approved query/API and retain grain, dimensions, measures, units, hierarchies and filters; aggregated measures are not assumed to be patient-level events."),
        new("fhir-api","FHIR API","platform-api","QUALIFICATION_REQUIRED","not-enabled","Requires registered endpoint, validated CapabilityStatement, exact FHIR release/profiles and read-only scopes/operations."),
        new("clinical-rest-api","Clinical REST API","platform-api","QUALIFICATION_REQUIRED","not-enabled","Requires an operator-approved API contract and explicitly allowlisted read operations. A GET method alone does not prove freedom from side effects.")
    ];
    private static string S(JsonObject o,string key)=>KnowledgeCorpus.Text(o,key);
    private static string PathFor(string id){if(!Regex.IsMatch(id,"^discovery-[a-f0-9]{32}$"))throw new ProcessingException("SOURCE_JOB_ID_INVALID");return "documentation/source-discovery/"+id+".json";}
    private static SourceConnector Connector(string id)=>Connectors.SingleOrDefault(c=>c.Id==id)??throw new ProcessingException("SOURCE_CONNECTOR_UNKNOWN");
    public async Task<JsonNode> Execute(string name,JsonObject args,CancellationToken cancellation){
        if(name=="source_connectors")return new JsonObject{["connectors"]=JsonSerializer.SerializeToNode(Connectors,JsonSerializerOptions.Web),["clinicalDatabaseReadOnly"]=true,["patientRowsInMcp"]=false,["notice"]="Selection is not proof that a connector is implemented, deployed or clinically qualified. Each connector reports its own status."};
        var project=Data.Required(args,"project");actor.Read(project);repository.Project(project);
        if(name=="source_discovery_job_create"){
            actor.Write(project);var connector=Connector(Data.Required(args,"connector"));var profile=Data.Required(args,"sourceProfile");if(!Regex.IsMatch(profile,"^[a-z][a-z0-9-]{0,63}$"))throw new ProcessingException("SOURCE_PROFILE_INVALID");
            var id="discovery-"+Guid.NewGuid().ToString("N");var purpose=Data.Required(args,"purpose");var narrative=Data.Required(args,"userNarrative");if(purpose.Length>1000||narrative.Length>16000)throw new ProcessingException("SOURCE_JOB_LIMIT");
            var createdJob=new JsonObject{["schemaVersion"]=1,["id"]=id,["project"]=project,["connector"]=connector.Id,["sourceFamily"]=connector.Family,["sourceProfile"]=profile,["purpose"]=purpose,["userNarrative"]=narrative,["createdBy"]=actor.Id,["createdAt"]=DateTimeOffset.UtcNow.ToString("O"),["state"]="PLANNED",["clinicalMeanings"]="UNRESOLVED",["modelConfirmation"]="REQUIRED_BEFORE_MAPPING",["patientRowsIncluded"]=false,["readOnly"]=true};
            return View(repository.Save(project,PathFor(id),createdJob.ToJsonString(),new JsonObject{["kind"]="source_discovery_job"},null));
        }
        if(name=="source_discovery_jobs")return new JsonObject{["items"]=new JsonArray(repository.Artifacts(project).OfType<JsonObject>().Where(a=>S(a,"path").StartsWith("documentation/source-discovery/",StringComparison.Ordinal)).Take(100).Select(a=>(JsonNode)View(repository.Artifact(project,S(a,"path")))).ToArray()),["limit"]=100};
        var artifact=repository.Artifact(project,PathFor(Data.Required(args,"jobId")));var job=Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(S(artifact,"content"))) as JsonObject??throw new ProcessingException("SOURCE_JOB_INVALID");var selected=Connector(Data.Required(job,"connector"));
        if(S(job,"project")!=project||S(job,"id")!=S(args,"jobId")||S(job,"sourceFamily")!=selected.Family)throw new ProcessingException("SOURCE_JOB_INVALID");
        if(name=="source_discovery_job_get")return View(artifact);
        if(name!="source_discovery_job_run")throw new ProcessingException("TOOL_NOT_FOUND");actor.Write(project);
        if(S(artifact,"revision")!=Data.Required(args,"expectedRevision"))throw new ProcessingException("REVISION_CONFLICT");
        if(selected.Id!="sqlserver"||selected.Qualification!="SYNTHETIC_ACCEPTANCE_PASSED")throw new ProcessingException("SOURCE_CONNECTOR_NOT_QUALIFIED");
        if(Environment.GetEnvironmentVariable("SOURCE_DATABASE_ENABLED")!="true")throw new ProcessingException("SOURCE_DATABASE_DISABLED");
        var profileForRun=SqlSourceProfile.Load(Environment.GetEnvironmentVariable("SOURCE_DATABASE_PROFILES_DIR")??"/run/secrets/source-databases",Data.Required(job,"sourceProfile"),actor.Tenant,project);
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellation);timeout.CancelAfter(TimeSpan.FromSeconds(45));await using var source=await SqlServerSource.Open(profileForRun,timeout.Token);var catalogue=await source.Discover(timeout.Token);
        job["state"]="METADATA_DISCOVERED";job["discoveredAt"]=DateTimeOffset.UtcNow.ToString("O");job["schemaFingerprint"]=catalogue.Fingerprint;job["tableCount"]=catalogue.Tables.Length;job["columnCount"]=catalogue.Tables.Sum(t=>t.Columns.Length);job["declaredKeyCount"]=catalogue.Keys.Length;job["clinicalMeanings"]="UNRESOLVED";job["patientRowsIncluded"]=false;
        return View(repository.Save(project,PathFor(S(job,"id")),job.ToJsonString(),new JsonObject{["kind"]="source_discovery_job"},S(artifact,"revision")));
    }
    public static string SqlProfile(SnapshotRepository repository,string project,string jobId){
        var artifact=repository.Artifact(project,PathFor(jobId));var job=Data.ParseStrict(System.Text.Encoding.UTF8.GetBytes(S(artifact,"content"))) as JsonObject??throw new ProcessingException("SOURCE_JOB_INVALID");
        if(S(job,"id")!=jobId||S(job,"project")!=project||S(job,"sourceFamily")!="database"||S(job,"connector")!="sqlserver")throw new ProcessingException("SOURCE_CONNECTOR_NOT_QUALIFIED");return Data.Required(job,"sourceProfile");
    }
    private static JsonObject View(JsonObject artifact){var job=JsonNode.Parse(S(artifact,"content")) as JsonObject??throw new ProcessingException("SOURCE_JOB_INVALID");var connector=Connector(Data.Required(job,"connector"));return new JsonObject{["job"]=job,["revision"]=artifact["revision"]?.DeepClone(),["connectorQualification"]=connector.Qualification,["metadataDiscoveryImplemented"]=connector.Discovery=="metadata",["metadataDiscoveryEnabled"]=connector.Discovery=="metadata"&&Environment.GetEnvironmentVariable("SOURCE_DATABASE_ENABLED")=="true",["executionAuthorised"]=false,["clinicalApproval"]=false,["notice"]="This is a versioned planning/discovery record, not approval evidence. Repository fields cannot authorise data extraction, mapping or delivery."};}
}
