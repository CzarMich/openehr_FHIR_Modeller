using Modeller.Core;
namespace Modeller.Operational;
internal sealed record TargetReservation(int Revision,string Holder,string State,DateTimeOffset Until,string PayloadSha256);
/// <summary>Cross-process reservation in internal encrypted state, never a clinical source database.</summary>
public sealed class DestinationWriteLease : IDisposable {
    private readonly IdentityRegistry registry;private readonly string scope;private readonly string target;private readonly string holder;private readonly string payload;private bool writing;private bool finished;
    private DestinationWriteLease(IdentityRegistry store,string key,string hash) {registry=store;scope=registry.Index("destination-target/v1");target=registry.Index(key);holder=Guid.NewGuid().ToString("N");payload=hash;}
    public static DestinationWriteLease Acquire(IdentityRegistry registry,string target,string payload,DateTimeOffset now) {
        var lease=new DestinationWriteLease(registry,target,payload);using var tx=registry.Transaction();
        var before=registry.Read<TargetReservation>(lease.scope,"target",lease.target,tx);
        if(before?.State=="WRITING"||before?.State=="UNCERTAIN")throw new ProcessingException("DESTINATION_TARGET_RECONCILIATION_REQUIRED");
        if(before?.State=="RESERVED"&&before.Until>now)throw new ProcessingException("DESTINATION_TARGET_BUSY");
        registry.Write(lease.scope,"target",lease.target,(before?.Revision??0)+1,new TargetReservation((before?.Revision??0)+1,lease.holder,"RESERVED",now.AddMinutes(15),payload),tx);tx.Commit();return lease;
    }
    private void Change(string state) {
        using var tx=registry.Transaction();var before=registry.Read<TargetReservation>(scope,"target",target,tx)??throw new ProcessingException("DESTINATION_TARGET_LEASE_REQUIRED");
        if(before.Holder!=holder)throw new ProcessingException("DESTINATION_TARGET_LEASE_CONFLICT");
        registry.Write(scope,"target",target,before.Revision+1,before with{Revision=before.Revision+1,State=state,Until=DateTimeOffset.UtcNow.AddMinutes(15)},tx);tx.Commit();
    }
    public void BeforeWrite() {Change("WRITING");writing=true;}
    public void Confirm() {Change("IDLE");finished=true;}
    public void KnownRejected() {Change("IDLE");finished=true;}
    public void Dispose() {if(!finished){Change(writing?"UNCERTAIN":"IDLE");finished=true;}}
    public static void Reconciled(IdentityRegistry registry,string target,string payload,DateTimeOffset? observedAt=null) {
        var scope=registry.Index("destination-target/v1");var id=registry.Index(target);using var tx=registry.Transaction();
        var before=registry.Read<TargetReservation>(scope,"target",id,tx);
        if(before is not null && before.State is "WRITING" or "UNCERTAIN") {
            if(before.State=="WRITING" && before.Until>(observedAt??DateTimeOffset.UtcNow))throw new ProcessingException("DESTINATION_TARGET_BUSY");
            if(before.PayloadSha256!=payload)throw new ProcessingException("DESTINATION_TARGET_RECONCILIATION_CONFLICT");
            registry.Write(scope,"target",id,before.Revision+1,before with{Revision=before.Revision+1,State="IDLE"},tx);
        }
        tx.Commit();
    }
}
