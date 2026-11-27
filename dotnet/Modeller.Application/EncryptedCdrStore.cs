using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Modeller.Core;
namespace Modeller.Application;

public sealed class FileGate:IDisposable
{
    private readonly FileStream stream;
    public FileGate(string path,bool wait=true){SnapshotRepository.Safe(path);stream=new FileStream(path,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite);if(!OperatingSystem.IsLinux())throw new ProcessingException("LINUX_RUNTIME_REQUIRED");if(Flock(stream.SafeFileHandle.DangerousGetHandle().ToInt32(),wait?2:6)!=0){stream.Dispose();throw new ProcessingException("STORE_LOCK_BUSY");}}
    public void Dispose(){Flock(stream.SafeFileHandle.DangerousGetHandle().ToInt32(),8);stream.Dispose();}
    [DllImport("libc",EntryPoint="flock",SetLastError=true)]private static extern int Flock(int descriptor,int operation);
}
/// <summary>Encrypted, owner-scoped connection and query metadata. Operational result rows never enter this store.</summary>
public sealed class EncryptedCdrStore
{
    private readonly string root;private readonly string owner;private readonly byte[] key;
    public EncryptedCdrStore(ModellingIdentity actor){if(Environment.GetEnvironmentVariable("CDR_ENABLED")!="true")throw new ProcessingException("CDR_NOT_CONFIGURED");root=Environment.GetEnvironmentVariable("CDR_DATA_DIR")??"/data/cdr";if(!Path.IsPathFullyQualified(root))throw new ProcessingException("CDR_STORAGE_INVALID");SnapshotRepository.Safe(root);Directory.CreateDirectory(root);var file=Environment.GetEnvironmentVariable("CDR_ENCRYPTION_KEY_FILE")??"";if(!Path.IsPathFullyQualified(file)||new FileInfo(file).Length>256)throw new ProcessingException("CDR_ENCRYPTION_NOT_CONFIGURED");var hex=File.ReadAllText(file).Trim();if(!System.Text.RegularExpressions.Regex.IsMatch(hex,"^[a-f0-9]{64}$"))throw new ProcessingException("CDR_ENCRYPTION_NOT_CONFIGURED");key=Convert.FromHexString(hex);owner=Data.Hash(actor.Tenant+"\0"+actor.Id);}
    public JsonObject Read()=>Locked(s=>s,false);
    public JsonObject Update(Func<JsonObject,JsonObject> change)=>Locked(change,true);
    private JsonObject Locked(Func<JsonObject,JsonObject> change,bool write){var file=Path.Combine(root,owner+".json");using var gate=new FileGate(Path.Combine(root,owner+".lock"));SnapshotRepository.Safe(file);var state=new JsonObject{["connections"]=new JsonObject(),["saved"]=new JsonObject(),["history"]=new JsonArray()};
        if(File.Exists(file)){try{if(new FileInfo(file).Length>33554432)throw new ProcessingException("CDR_STORAGE_INVALID");var envelope=JsonNode.Parse(File.ReadAllBytes(file)) as JsonObject??throw new ProcessingException("CDR_STORAGE_INVALID");var data=Convert.FromBase64String(Data.Required(envelope,"data"));var plain=new byte[data.Length];using var aes=new AesGcm(key,16);aes.Decrypt(Convert.FromBase64String(Data.Required(envelope,"iv")),data,Convert.FromBase64String(Data.Required(envelope,"tag")),plain,Encoding.UTF8.GetBytes(owner));state=Data.ParseStrict(plain) as JsonObject??throw new ProcessingException("CDR_STORAGE_INVALID");foreach(var k in new[]{"connections","saved"})if(state[k] is JsonArray{Count:0})state[k]=new JsonObject();if(state["connections"] is not JsonObject||state["saved"] is not JsonObject||state["history"] is not JsonArray)throw new ProcessingException("CDR_STORAGE_INVALID");}catch(Exception e)when(e is CryptographicException or FormatException or System.Text.Json.JsonException){throw new ProcessingException("CDR_STORAGE_INVALID");}}
        state=change(state);if(write){var plain=Encoding.UTF8.GetBytes(state.ToJsonString());if(plain.Length>24000000)throw new ProcessingException("CDR_STORAGE_LIMIT");var iv=RandomNumberGenerator.GetBytes(12);var tag=new byte[16];var data=new byte[plain.Length];using var aes=new AesGcm(key,16);aes.Encrypt(iv,plain,data,tag,Encoding.UTF8.GetBytes(owner));var temporary=file+"."+Guid.NewGuid().ToString("N");try{WritePrivate(temporary,Encoding.UTF8.GetBytes(new JsonObject{["iv"]=Convert.ToBase64String(iv),["tag"]=Convert.ToBase64String(tag),["data"]=Convert.ToBase64String(data)}.ToJsonString()));File.Move(temporary,file,true);}finally{if(File.Exists(temporary))File.Delete(temporary);}}return state;
    }
    public static void WritePrivate(string file,byte[] bytes){var options=new FileStreamOptions{Mode=FileMode.CreateNew,Access=FileAccess.Write,Share=FileShare.None,Options=FileOptions.WriteThrough};if(!OperatingSystem.IsWindows())options.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;using var stream=new FileStream(file,options);stream.Write(bytes);stream.Flush(true);}
    public string Job(string id){if(!System.Text.RegularExpressions.Regex.IsMatch(id,"^[a-f0-9]{32}$"))throw new ProcessingException("CDR_INVALID_JOB");var file=Path.Combine(root,owner+"-job-"+id);SnapshotRepository.Safe(file);return file;}
}
