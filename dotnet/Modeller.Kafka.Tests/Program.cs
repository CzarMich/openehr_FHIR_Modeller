using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.Text;
using Confluent.Kafka;
using Confluent.Kafka.Admin;
using Modeller.Core;
var root=args[0];var port=args[1];var reader=Path.GetFullPath(args[2]);var ca=File.ReadAllText(Path.Combine(root,"ca.crt"));
var topic="synthetic-"+Guid.NewGuid().ToString("N");
var config=new ClientConfig{BootstrapServers="127.0.0.1:"+port,SecurityProtocol=SecurityProtocol.SaslSsl,SaslMechanism=SaslMechanism.Plain,SaslUsername="fixture",SaslPassword="synthetic-fixture-only",SslCaPem=ca,SslEndpointIdentificationAlgorithm=SslEndpointIdentificationAlgorithm.Https,EnableSslCertificateVerification=true,SocketTimeoutMs=10000};
using var admin=new AdminClientBuilder(new AdminClientConfig(config)).SetLogHandler((_,_)=>{}).Build();
for(var attempt=0;;attempt++){try{await admin.CreateTopicsAsync([new TopicSpecification{Name=topic,NumPartitions=2,ReplicationFactor=1}],new(){RequestTimeout=TimeSpan.FromSeconds(5)});break;}catch(KafkaException)when(attempt<20){await Task.Delay(1000);}}
using(var producer=new ProducerBuilder<byte[],byte[]>(new ProducerConfig(config)).SetLogHandler((_,_)=>{}).Build())for(var i=0;i<6;i++)await producer.ProduceAsync(new TopicPartition(topic,i%2),new(){Key=Encoding.UTF8.GetBytes("synthetic-key"),Value=Encoding.UTF8.GetBytes("{\"synthetic\":"+i+"}")});
var group="modeller-"+new string('b',64);
var profile=new JsonObject{["brokers"]=new JsonArray("127.0.0.1:"+port),["topic"]=topic,["groupId"]=group,["authentication"]="plain",["username"]="fixture",["password"]="synthetic-fixture-only",["caPem"]=ca,["maximumMessages"]=2,["startPosition"]="earliest",["maximumBytes"]=16777216};
async Task<(Process Process,string Directory,JsonObject Reply)> Start(string operation,JsonObject? offsets=null){var dir=Path.Combine(root,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);var start=new ProcessStartInfo("dotnet"){RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};start.ArgumentList.Add(reader);start.ArgumentList.Add(operation);start.ArgumentList.Add(dir);var p=Process.Start(start)!;await p.StandardInput.WriteLineAsync(new JsonObject{["profile"]=profile.DeepClone(),["afterOffsets"]=offsets?.DeepClone()}.ToJsonString());var line=await p.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(90));if(line is null){var safe=await p.StandardError.ReadToEndAsync();throw new Exception("Reader did not return: "+safe);}return(p,dir,JsonNode.Parse(line)!.AsObject());}
async Task<JsonObject> Manifest((Process Process,string Directory,JsonObject Reply) capture){var m=JsonNode.Parse(File.ReadAllText(Path.Combine(capture.Directory,"manifest.json")))!.AsObject();foreach(var item in m["items"]!.AsArray()){var file=item!["file"]!.GetValue<string>();var bytes=File.ReadAllBytes(Path.Combine(capture.Directory,file));if(Convert.ToHexStringLower(SHA256.HashData(bytes))!=item["sha256"]!.GetValue<string>())throw new Exception("Raw capture mismatch");var envelope=JsonNode.Parse(File.ReadAllBytes(Path.Combine(capture.Directory,"envelope-"+item["eventId"]!.GetValue<string>()+".json")))!.AsArray();if(envelope.Count!=1||envelope[0]!["transport"]!["offset"]!.GetValue<string>()!=item["offset"]!.GetValue<string>())throw new Exception("Transport envelope mismatch");}await Task.CompletedTask;return m;}
using var verifier=new ConsumerBuilder<byte[],byte[]>(new ConsumerConfig(config){GroupId=group,EnableAutoCommit=false}).SetLogHandler((_,_)=>{}).Build();
List<TopicPartitionOffset> Committed()=>verifier.Committed([new(topic,0),new(topic,1)],TimeSpan.FromSeconds(10));
var discovery=await Start("discover");await discovery.Process.WaitForExitAsync();profile["clusterId"]=discovery.Reply["clusterId"]!.DeepClone();profile["topicId"]=discovery.Reply["topicId"]!.DeepClone();
var first=await Start("capture");var m1=await Manifest(first);if(Committed().Any(p=>p.Offset.Value>=0))throw new Exception("Offsets committed before durable acknowledgment");first.Process.Kill(true);await first.Process.WaitForExitAsync();if(Committed().Any(p=>p.Offset.Value>=0))throw new Exception("Killed unacknowledged capture advanced offsets");
// Different partitions may be interleaved differently after restart. Verify the full source-position set, not a global first-message order.
var expected=new HashSet<string>(StringComparer.Ordinal);
for(var partition=0;partition<2;partition++)for(var offset=0;offset<3;offset++)expected.Add(Data.Hash(Data.Canonical(new JsonArray(profile["clusterId"]!.GetValue<string>(),profile["topicId"]!.GetValue<string>(),topic,partition.ToString(),offset.ToString()))));
var seen=new HashSet<string>(StringComparer.Ordinal);
JsonObject? offsets=null;
for(var batch=0;batch<8 && seen.Count<expected.Count;batch++) {
    var capture=await Start("capture",offsets);var manifest=await Manifest(capture);
    foreach(var item in manifest["items"]!.AsArray()) {
        var identity=item!["eventId"]!.GetValue<string>();
        if(!expected.Contains(identity)||!seen.Add(identity))throw new Exception("Durable resume skipped or duplicated a source position");
    }
    await capture.Process.StandardInput.WriteLineAsync("DURABLY_ACCEPTED");await capture.Process.WaitForExitAsync();
    if(capture.Process.ExitCode!=0)throw new Exception("Explicit durable commit failed: "+await capture.Process.StandardError.ReadToEndAsync());
    offsets=manifest["nextOffsets"]!.AsObject();
    foreach(var value in Committed())if(value.Offset.Value.ToString()!=offsets[value.Partition.Value.ToString()]!.GetValue<string>())throw new Exception("Committed prefetched rather than accepted offset");
}
if(!seen.SetEquals(expected)||m1["items"]!.AsArray().Any(item=>!seen.Contains(item!["eventId"]!.GetValue<string>())))throw new Exception("Unacknowledged source messages were not replayed completely");
async Task Denied(string code,JsonObject checkpoint){var dir=Path.Combine(root,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(dir);var start=new ProcessStartInfo("dotnet"){RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var arg in new[]{reader,"capture",dir})start.ArgumentList.Add(arg);using var child=Process.Start(start)!;await child.StandardInput.WriteLineAsync(new JsonObject{["profile"]=profile.DeepClone(),["afterOffsets"]=checkpoint.DeepClone()}.ToJsonString());await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(90));var error=await child.StandardError.ReadToEndAsync();if(child.ExitCode==0||!error.Contains(code,StringComparison.Ordinal))throw new Exception("Expected safe refusal "+code+": "+error);}
await Denied("KAFKA_BROKER_CHECKPOINT_AHEAD_OF_DURABLE_INTAKE",new JsonObject{["0"]="0",["1"]="0"});
profile["groupId"]="modeller-"+new string('c',64);
await admin.DeleteRecordsAsync([new TopicPartitionOffset(topic,0,1)]);
await Denied("KAFKA_RETENTION_GAP",new JsonObject{["0"]="0",["1"]="0"});
profile["topicId"]="wrong-topic-uuid";
await Denied("KAFKA_CLUSTER_OR_TOPIC_CHANGED",new JsonObject{["0"]="0",["1"]="0"});
Console.WriteLine("PASS native Kafka TLS/SASL: pinned source, lossless envelopes, no early commit, crash replay, accepted offsets only, durable cursor resume");
