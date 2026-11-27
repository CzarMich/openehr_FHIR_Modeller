using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

using Modeller.Core;
namespace Modeller.Application;

/// <summary>Atomic, revision-preserving modelling metadata storage. Never connects to clinical databases.</summary>
public partial class SnapshotRepository
{
    private readonly string root;
    public SnapshotRepository(string directory) { root = Path.GetFullPath(directory); Safe(root); Directory.CreateDirectory(root); }
    public static void Safe(string path) {
        var current = Path.GetPathRoot(path)!;
        foreach (var segment in path[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)) {
            if (segment is "." or "..") throw new ProcessingException("INVALID_REPOSITORY_PATH");
            current = Path.Combine(current, segment);
            if (new FileInfo(current).LinkTarget is not null || new DirectoryInfo(current).LinkTarget is not null) throw new ProcessingException("REPOSITORY_SYMLINK_FORBIDDEN");
        }
    }
    private string FilePath(string id) { if (!Regex.IsMatch(id, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")) throw new ProcessingException("INVALID_PROJECT_ID"); var p=Path.Combine(root,id+".json"); Safe(p);return p; }
    public virtual JsonObject Read(string id) {
        var file=FilePath(id);if(!File.Exists(file))throw new ProcessingException("PROJECT_NOT_FOUND");
        if(new FileInfo(file).Length>33554432)throw new ProcessingException("PROJECT_SIZE_LIMIT");
        var value=Data.ParseStrict(File.ReadAllBytes(file)) as JsonObject ?? throw new ProcessingException("REPOSITORY_INVALID_SNAPSHOT");
        if(value["project"] is not JsonObject || value["artifacts"] is not (JsonObject or JsonArray) || value["history"] is not (JsonObject or JsonArray))throw new ProcessingException("REPOSITORY_INVALID_SNAPSHOT");
        if(value["artifacts"] is JsonArray {Count:0})value["artifacts"]=new JsonObject();
        if(value["history"] is JsonArray {Count:0})value["history"]=new JsonObject();
        return value;
    }
    public virtual JsonArray List() => new(Directory.EnumerateFiles(root,"*.json").Order(StringComparer.Ordinal).Select(f=>Read(Path.GetFileNameWithoutExtension(f))["project"]!.DeepClone()).ToArray());
    public virtual JsonObject Project(string id)=>(JsonObject)Read(id)["project"]!.DeepClone();
    public virtual JsonArray Artifacts(string id)=>new(((JsonObject)Read(id)["artifacts"]!).Select(p=>p.Value!.DeepClone()).ToArray());
    public virtual JsonObject Create(string id,string name,string description) {
        if(string.IsNullOrWhiteSpace(name)||name.Length>200||description.Length>10000)throw new ProcessingException("INVALID_PROJECT");
        return Transaction(id,state=>{
            if(state.Count!=0)throw new ProcessingException("PROJECT_ALREADY_EXISTS");
            var now=DateTimeOffset.UtcNow.ToString("O");var project=new JsonObject {["id"]=id,["name"]=name,["description"]=description,["status"]="ACTIVE",["revision"]=Revision(),["created_at"]=now,["updated_at"]=now};
            state["project"]=project;state["artifacts"]=new JsonObject();state["history"]=new JsonObject();return (JsonObject)project.DeepClone();
        },true);
    }
    public virtual JsonObject Archive(string id,string expectedRevision)=>Transaction(id,state=>{var project=(JsonObject)state["project"]!;if(project["revision"]?.GetValue<string>()!=expectedRevision)throw new ProcessingException("REVISION_CONFLICT");project["status"]="ARCHIVED";project["revision"]=Revision();return(JsonObject)project.DeepClone();});
    public virtual JsonObject Artifact(string id,string path,string? revision=null) {
        ArtifactPath(path);var state=Read(id);
        if(revision is null)return state["artifacts"]?[path]?.DeepClone() as JsonObject ?? throw new ProcessingException("ARTIFACT_NOT_FOUND");
        return ((JsonArray?)state["history"]?[path])?.OfType<JsonObject>().FirstOrDefault(a=>a["revision"]?.GetValue<string>()==revision)?.DeepClone() as JsonObject ?? throw new ProcessingException("VERSION_NOT_FOUND");
    }
    public virtual JsonArray History(string id,string path) { ArtifactPath(path);return Read(id)["history"]?[path]?.DeepClone() as JsonArray ?? new JsonArray(); }
    public virtual JsonObject Save(string id,string path,string content,JsonObject metadata,string? expectedRevision) {
        ArtifactPath(path);if(path.StartsWith("originals/",StringComparison.Ordinal))throw new ProcessingException("IMPORT_ORIGINAL_IMMUTABLE");
        if(Encoding.UTF8.GetByteCount(content)>2097152)throw new ProcessingException("ARTIFACT_TOO_LARGE");Metadata(metadata);
        return Transaction(id,state=>{
            if(state["project"]?["status"]?.GetValue<string>()!="ACTIVE")throw new ProcessingException("PROJECT_ARCHIVED");
            var artifacts=(JsonObject)state["artifacts"]!;var history=(JsonObject)state["history"]!;var old=artifacts[path] as JsonObject;
            if(old?["revision"]?.GetValue<string>()!=expectedRevision)throw new ProcessingException("REVISION_CONFLICT");
            if(old?["metadata"]?["representation"]?.GetValue<string>()=="imported")throw new ProcessingException("FHIR_ORIGINAL_IMMUTABLE");
            if(old is not null &&old["content"]?.GetValue<string>()==content&&Data.Canonical(old["metadata"])==Data.Canonical(metadata))return (JsonObject)old.DeepClone();
            var item=new JsonObject{["path"]=path,["content"]=content,["metadata"]=metadata.DeepClone(),["status"]="DRAFT",["revision"]=Revision(),["sha256"]=Data.Hash(content),["updated_at"]=DateTimeOffset.UtcNow.ToString("O"),["provider"]="filesystem"};
            artifacts[path]=item;var versions=history[path] as JsonArray??new JsonArray();if(history[path] is null)history[path]=versions;versions.Add(item.DeepClone());return (JsonObject)item.DeepClone();
        });
    }
    public virtual JsonObject Original(string id,string filename,byte[] bytes,JsonObject metadata,string? importId=null) {
        if(filename.Length is <1 or >128 || filename is "." or ".." ||filename.Any(c=>char.IsControl(c)||c is '/' or '\\' or '%')||bytes.Length>2097152)throw new ProcessingException("IMPORT_FILENAME_OR_ID_INVALID");Metadata(metadata);
        var hash=Convert.ToHexStringLower(SHA256.HashData(bytes));if(importId is not null&&!Regex.IsMatch(importId,"^[a-f0-9]{64}$"))throw new ProcessingException("IMPORT_ID_INVALID");var path="originals/"+(importId??hash)+"/"+filename;
        return Transaction(id,state=>{
            if(state["project"]?["status"]?.GetValue<string>()!="ACTIVE")throw new ProcessingException("PROJECT_ARCHIVED");
            var artifacts=(JsonObject)state["artifacts"]!;if(artifacts.ContainsKey(path))throw new ProcessingException("IMPORT_ORIGINAL_EXISTS");
            string? content=null;try{content=new UTF8Encoding(false,true).GetString(bytes);if(content.Contains('\0'))content=null;}catch(DecoderFallbackException){}
            var item=new JsonObject{["path"]=path,["content"]=content,["content_base64"]=content is null?Convert.ToBase64String(bytes):null,["content_encoding"]=content is null?"base64":"utf8",["sha256"]=hash,["size_bytes"]=bytes.Length,["metadata"]=metadata.DeepClone(),["status"]="DRAFT",["revision"]=Revision(),["updated_at"]=DateTimeOffset.UtcNow.ToString("O"),["provider"]="filesystem"};
            artifacts[path]=item;state["history"]![path]=new JsonArray(item.DeepClone());return (JsonObject)item.DeepClone();
        });
    }
    public static void ArtifactPath(string path) {
        if(path.Length>240||path.Contains("..",StringComparison.Ordinal)||path.Contains("//",StringComparison.Ordinal)||path.EndsWith('/'))throw new ProcessingException("INVALID_ARTIFACT_PATH");
        if(!Regex.IsMatch(path,"^(requirements|archetypes|templates|terminology|aql|tests|validation|decisions|documentation|fhir|mappings)/[A-Za-z0-9_./-]+$")&&!Regex.IsMatch(path,"^originals/[a-f0-9]{64}/[^/\\\\%\\x00-\\x1f\\x7f]{1,128}$"))throw new ProcessingException("INVALID_ARTIFACT_PATH");
    }
    private static void Metadata(JsonObject metadata) {
        if(Encoding.UTF8.GetByteCount(metadata.ToJsonString())>65536)throw new ProcessingException("INVALID_ARTIFACT_METADATA");
        if(metadata.Any(p=>new[]{"status","validation","approved_by","released_by","revision","created_by"}.Contains(p.Key)))throw new ProcessingException("RESERVED_METADATA_FIELD");
    }
    protected virtual JsonObject Transaction(string id,Func<JsonObject,JsonObject> operation,bool create=false) {
        var file=FilePath(id);Safe(file+".lock");
        using var handle=LockHandle(file+".lock");
        if(OperatingSystem.IsLinux()&&Flock(handle.SafeFileHandle.DangerousGetHandle().ToInt32(),2)!=0)throw new ProcessingException("REPOSITORY_LOCK_FAILED");
        string? temporary=null;
        try {
            var state=create&&!File.Exists(file)?new JsonObject():Read(id);var result=operation(state);state["project"]!["updated_at"]=DateTimeOffset.UtcNow.ToString("O");
            var bytes=Encoding.UTF8.GetBytes(state.ToJsonString());if(bytes.Length>33554432)throw new ProcessingException("PROJECT_SIZE_LIMIT");temporary=file+"."+Guid.NewGuid().ToString("N")+".tmp";
            var options=new FileStreamOptions{Mode=FileMode.CreateNew,Access=FileAccess.Write,Share=FileShare.None,Options=FileOptions.WriteThrough};if(!OperatingSystem.IsWindows())options.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;using(var stream=new FileStream(temporary,options)){stream.Write(bytes);stream.Flush(true);}
            Safe(file);File.Move(temporary,file,true);temporary=null;return result;
        } finally {if(temporary is not null)File.Delete(temporary);if(OperatingSystem.IsLinux())Flock(handle.SafeFileHandle.DangerousGetHandle().ToInt32(),8);}
    }
    private static FileStream LockHandle(string path){
        // FileShare.None and flock use the same exclusive Linux lock. A shared FileStream
        // followed by a flock upgrade can make a concurrent FileStream open fail prematurely.
        var deadline=System.Diagnostics.Stopwatch.StartNew();
        while(true){try{var options=new FileStreamOptions{Mode=FileMode.OpenOrCreate,Access=FileAccess.ReadWrite,Share=FileShare.None};if(!OperatingSystem.IsWindows())options.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;return new FileStream(path,options);}catch(IOException){if(deadline.Elapsed>TimeSpan.FromSeconds(5))throw new ProcessingException("REPOSITORY_LOCK_TIMEOUT");Thread.Sleep(20);}}
    }
    private static string Revision()=>Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
    [DllImport("libc",EntryPoint="flock",SetLastError=true)]private static extern int Flock(int fd,int operation);
}
