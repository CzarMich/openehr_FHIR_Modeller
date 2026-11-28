using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Database;
public static class DiscoverySource
{
    public static async Task<IReadOnlySource> Open(string directory,string id,string connector,string tenant,string project,CancellationToken ct){
        var file=VendorProfile.ProfileFile(directory,id);var node=Data.ParseStrict(File.ReadAllBytes(file)) as JsonObject??throw new ProcessingException("SOURCE_PROFILE_INVALID");
        if(connector=="sqlserver"&&!node.ContainsKey("connector"))return new Legacy(await SqlServerSource.Open(SqlSourceProfile.Load(directory,id,tenant,project),ct));
        var profile=VendorProfile.Load(directory,id,tenant,project);if(profile.Connector!=connector)throw new ProcessingException("SOURCE_PROFILE_CONNECTOR_MISMATCH");return await VendorDatabase.Open(profile,ct);
    }
    private sealed class Legacy(SqlServerSource source):IReadOnlySource {
        public Task<SchemaCatalogue> Discover(CancellationToken ct)=>source.Discover(ct);
        public Task<JsonArray> Read(SourcePlan plan,CancellationToken ct)=>throw new ProcessingException("SOURCE_PRIVATE_EXTRACTION_PROFILE_REQUIRED");
        public ValueTask DisposeAsync()=>source.DisposeAsync();
    }
}
