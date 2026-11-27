using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Modeller.Core;
namespace Modeller.Application;

public sealed record ModellingIdentity(string Id,string Tenant,bool CanWrite,string[] ProjectScopes,bool EnforceProjects=false,string[]? Roles=null,bool Human=false,string Method="mcp")
{
    public bool CanReadProject(string project)=>!EnforceProjects||ProjectScopes.Contains("projects:admin")||ProjectScopes.Contains("project:"+project+":read")||ProjectScopes.Contains("project:"+project+":write");
    public void Write(string project){if(!CanWrite)throw new ProcessingException("WRITES_DISABLED");if(EnforceProjects&&!ProjectScopes.Contains("projects:admin")&&!ProjectScopes.Contains("project:"+project+":write"))throw new ProcessingException("PROJECT_PERMISSION_REQUIRED");}
    public void Create(string project){if(!CanWrite)throw new ProcessingException("WRITES_DISABLED");if(EnforceProjects&&!ProjectScopes.Contains("projects:admin")&&!ProjectScopes.Contains("projects:create")&&!ProjectScopes.Contains("project:"+project+":write"))throw new ProcessingException("PROJECT_PERMISSION_REQUIRED");}
    public void Read(string project){if(!CanReadProject(project))throw new ProcessingException("PROJECT_PERMISSION_REQUIRED");}
}

public sealed class ModellingApplication:IDisposable
{
    private readonly StandardsGateway engines=new();private readonly RemoteDefinitions remote=new();
    private readonly KnowledgeCorpus corpus;
    public ModellingApplication(string resourceRoot){corpus=new KnowledgeCorpus(resourceRoot);}
    public void Dispose(){engines.Dispose();remote.Dispose();}
    public SnapshotRepository Repository(ModellingIdentity actor,bool fhir=false){var root=Environment.GetEnvironmentVariable(fhir?"FHIR_REPOSITORY_PATH":"MODEL_REPOSITORY_PATH")??(fhir?"/data/models/fhir":"/data/models");if(actor.Tenant!="shared"){if(!Regex.IsMatch(actor.Tenant,"^[a-f0-9]{64}$"))throw new ProcessingException("INVALID_TENANT");root=Path.Combine(root,"tenants",actor.Tenant);}if(fhir)return new SnapshotRepository(root);var provider=Environment.GetEnvironmentVariable("MODEL_REPOSITORY_PROVIDER")??"filesystem";if(provider is "git" or "github" or "gitlab"){string? configuredRemote=null;if(actor.Tenant!="shared"){configuredRemote=RemoteDefinitions.EnvironmentObject("OIDC_TENANT_GIT_REMOTES")[actor.Tenant]?.GetValue<string>()??throw new ProcessingException("TENANT_REPOSITORY_NOT_CONFIGURED");}return new GitRepository(root,configuredRemote);}if(provider=="sharepoint")return new SharePointRepository(root,actor.Tenant);if(provider!="filesystem")throw new ProcessingException("REPOSITORY_PROVIDER_UNSUPPORTED");return new SnapshotRepository(root);}
    private static string S(JsonObject o,string key,string fallback="")=>KnowledgeCorpus.Text(o,key,fallback);
    public async Task<JsonNode> Execute(string name,JsonObject args,ModellingIdentity actor,CancellationToken cancellation){
        var project=S(args,"project");if(project!="")actor.Read(project);var repository=Repository(actor);var operations=new RepositoryOperations(repository,remote);
        if(name=="source_connectors"||name.StartsWith("source_discovery_job",StringComparison.Ordinal))return await new SourceDiscoveryJobs(repository,actor).Execute(name,args,cancellation);
        if(name.StartsWith("source_database_",StringComparison.Ordinal))return await DatabaseDiscovery.Execute(name,args,actor,repository,cancellation);
        if(name.StartsWith("ckm_",StringComparison.Ordinal))return await remote.Ckm(name,args,cancellation);
        if(name is "guide_search" or "examples_search" or "type_specification_search")return corpus.Search(name,args);
        if(name=="type_specification_get")return corpus.Type(args);
        if(name=="terminology_resolve")return corpus.Resolve(args);
        if(name=="guide_adl_idiom_lookup")return corpus.Idioms(S(args,"pattern"));
        if(name=="examples_get"){var uri=S(args,"uri");if(uri=="")uri="openehr://examples/"+S(args,"kind")+"/"+S(args,"name");return corpus.Resource(uri);}
        if(name.StartsWith("fhir_",StringComparison.Ordinal)){var id=S(args,"projectId");if(id!=""&&!(name=="fhir_project"&&S(args,"action")=="create"))actor.Read(id);return await new FhirWorkspace(Repository(actor,true),engines,actor.Write,actor.Tenant,remote,new MappingSelections(repository,Repository(actor,true),actor),actor).Execute(name,args,cancellation);}
        if(name is "archetype_validate" or "template_validate" or "template_compile" or "opt_validate" or "model_inspect" or "aql_validate"){
            var operation=name switch{"archetype_validate"=>"validate/archetype","template_validate"=>"validate/template","template_compile"=>"compile/template","opt_validate"=>"validate/opt","aql_validate"=>"validate/aql",_=>S(args,"format") is "opt14" or "opt2"?"inspect/opt":"inspect/archetype"};
            return await engines.Native(operation,S(args,"content"),args[name=="aql_validate"?"templates":"dependencies"] as JsonArray,cancellation);
        }
        switch(name){
            case "model_projects":{var items=new JsonArray(repository.List().OfType<JsonObject>().Where(p=>actor.CanReadProject(S(p,"id"))).Select(p=>(JsonNode)p.DeepClone()).ToArray());return new JsonObject{["projects"]=items,["capabilities"]=RepositoryOperations.Capabilities()};}
            case "model_project_get":return new JsonObject{["project"]=repository.Project(project),["artifacts"]=repository.Artifacts(project)};
            case "model_project_create":actor.Create(S(args,"id"));return repository.Create(S(args,"id"),S(args,"name"),S(args,"description"));
            case "model_artifact_get":return repository.Artifact(project,S(args,"path"),args["revision"]?.GetValue<string>());
            case "model_artifact_save":actor.Write(project);return repository.Save(project,S(args,"path"),S(args,"content"),args["metadata"] as JsonObject??new JsonObject(),args["expectedRevision"]?.GetValue<string>());
            case "model_artifact_history":return new JsonObject{["versions"]=repository.History(project,S(args,"path"))};
            case "model_artifact_provenance":return Imports.Provenance(repository,project,S(args,"importId"),actor);
            case "model_import_inspect":return Imports.Inspect(args);
            case "model_artifact_import":actor.Write(project);return Imports.Import(repository,args,actor);
            case "model_validate":return await ModelChecks.Validate(args,engines,cancellation);
            case "model_qa":return await ModelChecks.Quality(args,engines,cancellation);
            case "model_diff":return ModelChecks.Diff(S(args,"before"),S(args,"after"));
            case "template_build_oet":return await new TemplateAuthoring(engines,remote).Build(args,cancellation);
            case "template_compile_project":actor.Write(project);return await new TemplateAuthoring(engines,remote).CompileProject(repository,args,cancellation);
            case "model_project_qa":return await new ProjectQuality(repository,actor,engines,remote).Evaluate(args,cancellation);
            case "model_requirements_coverage":return Traceability.Coverage(args,repository.Artifacts(project));
            case "model_repository_info":return operations.Info();
            case "model_repository_branches":return await operations.Branches(args,cancellation);
            case "model_repository_diff":return await operations.Diff(args,cancellation);
            case "model_branch_create":actor.Write("");return await operations.Branch(args,cancellation);
            case "model_review_request":actor.Write("");return await operations.RequestReview(args,cancellation);
            case "model_review_get":return await operations.GetReview(args,cancellation);
        }
        if(name.StartsWith("model_traceability_",StringComparison.Ordinal))return await new Traceability(repository,actor,engines).Execute(name,args,cancellation);
        if(name.StartsWith("governance_",StringComparison.Ordinal))return await new ReviewGovernance(repository,actor,engines).Execute(name,args,cancellation);
        if(name.StartsWith("terminology_",StringComparison.Ordinal)||name=="model_terminology_inspect")return await new TerminologyWorkspace(repository,actor,remote).Execute(name,args,cancellation);
        if(name.StartsWith("cdr_",StringComparison.Ordinal)||name.StartsWith("aql_",StringComparison.Ordinal)||name=="model_generate_aql")return await new CdrWorkspace(engines,actor).Execute(name,args,cancellation);
        throw new ProcessingException("TOOL_NOT_FOUND");
    }
}
