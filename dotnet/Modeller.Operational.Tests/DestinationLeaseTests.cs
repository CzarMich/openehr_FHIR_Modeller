using Modeller.Core;
using Modeller.Operational;
internal static class DestinationLeaseTests {
 public static void Run() {
  var root=Path.Combine(Path.GetTempPath(),"destination-leases-"+Guid.NewGuid().ToString("N"));var key=System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);var now=DateTimeOffset.UtcNow;
  try {
   using(var registry=new IdentityRegistry(root,key)) {
    using(var lease=DestinationWriteLease.Acquire(registry,"same-physical-target","payload",now)) {
     using var another=new IdentityRegistry(root,key);Reject(()=>DestinationWriteLease.Acquire(another,"same-physical-target","payload",now),"DESTINATION_TARGET_BUSY");lease.BeforeWrite();
     Reject(()=>DestinationWriteLease.Acquire(another,"same-physical-target","payload",now.AddMinutes(16)),"DESTINATION_TARGET_RECONCILIATION_REQUIRED");
    }
   }
   using(var restarted=new IdentityRegistry(root,key)) {
    Reject(()=>DestinationWriteLease.Acquire(restarted,"same-physical-target","payload",now.AddHours(1)),"DESTINATION_TARGET_RECONCILIATION_REQUIRED");
    Reject(()=>DestinationWriteLease.Reconciled(restarted,"same-physical-target","different-payload"),"DESTINATION_TARGET_RECONCILIATION_CONFLICT");
    DestinationWriteLease.Reconciled(restarted,"same-physical-target","payload");
    using var retried=DestinationWriteLease.Acquire(restarted,"same-physical-target","payload",now.AddHours(1));retried.BeforeWrite();retried.Confirm();
   }
   Console.WriteLine("PASS durable destination fences: cross-connection exclusion, restart and explicit reconciliation");
  }finally {System.Security.Cryptography.CryptographicOperations.ZeroMemory(key);Directory.Delete(root,true);}
 }
 private static void Reject(Action action,string code) {try{action();}catch(ProcessingException e)when(e.Code==code){return;}throw new Exception("Expected "+code);}
}
