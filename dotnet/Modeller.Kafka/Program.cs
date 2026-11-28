using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Confluent.Kafka;
using Confluent.Kafka.Admin;
using Modeller.Core;

try {
    if(args.Length!=2 || args[0] is not("discover" or "capture"))throw new ProcessingException("KAFKA_OPERATION_INVALID");
    var directory=Path.GetFullPath(args[1]);if(!Directory.Exists(directory)||new DirectoryInfo(directory).LinkTarget is not null)throw new ProcessingException("PRIVATE_CAPTURE_DIRECTORY_REQUIRED");
    var input=await Console.In.ReadLineAsync();if(input is null||Encoding.UTF8.GetByteCount(input)>262144)throw new ProcessingException("KAFKA_PROFILE_REQUIRED");
    var request=JsonSerializer.Deserialize<KafkaRequest>(Data.ParseStrict(Encoding.UTF8.GetBytes(input)),Data.Json)??throw new ProcessingException("KAFKA_PROFILE_REQUIRED");
    var profile=request.Profile;
    if(profile.Brokers.Length is <1 or >8 || profile.Brokers.Any(b=>!Uri.TryCreate("tcp://"+b,UriKind.Absolute,out var u)||u.UserInfo.Length>0||u.AbsolutePath!="/"||u.Query.Length>0||u.Fragment.Length>0||u.Port is <1 or >65535) || !Regex.IsMatch(profile.Topic,"^[a-zA-Z0-9._-]{1,249}$")||profile.Topic is "." or ".."||profile.Topic.StartsWith("__",StringComparison.Ordinal)||!Regex.IsMatch(profile.GroupId,"^modeller-[a-f0-9]{32,64}$")||profile.MaximumMessages is <1 or >100 || profile.MaximumBytes is <1048576 or >16777216 || profile.StartPosition!="earliest")throw new ProcessingException("KAFKA_PROFILE_INVALID");
    if(profile.Authentication is not("tls" or "plain" or "scram-sha-256" or "scram-sha-512") || profile.Authentication!="tls" && (string.IsNullOrWhiteSpace(profile.Username)||string.IsNullOrEmpty(profile.Password)))throw new ProcessingException("KAFKA_AUTHENTICATION_REQUIRED");
    var config=new ConsumerConfig {
        BootstrapServers=string.Join(',',profile.Brokers),GroupId=profile.GroupId,ClientId="openfhir-private-intake",
        SecurityProtocol=profile.Authentication=="tls"?SecurityProtocol.Ssl:SecurityProtocol.SaslSsl,
        SslEndpointIdentificationAlgorithm=SslEndpointIdentificationAlgorithm.Https,EnableSslCertificateVerification=true,
        SslCaPem=profile.CaPem,SslCertificatePem=profile.CertificatePem,SslKeyPem=profile.KeyPem,
        SaslMechanism=profile.Authentication switch{"plain"=>SaslMechanism.Plain,"scram-sha-256"=>SaslMechanism.ScramSha256,_=>SaslMechanism.ScramSha512},SaslUsername=profile.Username,SaslPassword=profile.Password,
        EnableAutoCommit=false,EnableAutoOffsetStore=false,AllowAutoCreateTopics=false,AutoOffsetReset=AutoOffsetReset.Error,
        EnablePartitionEof=true,IsolationLevel=IsolationLevel.ReadCommitted,QueuedMaxMessagesKbytes=8192,
        FetchMaxBytes=1048576,MaxPartitionFetchBytes=1048576,ReceiveMessageMaxBytes=17825792,
        SocketTimeoutMs=15000,SessionTimeoutMs=10000,ApiVersionRequestTimeoutMs=10000
    };
    using var consumer=new ConsumerBuilder<byte[],byte[]>(config).SetLogHandler((_,_)=>{}).SetErrorHandler((_,_)=>{}).Build();
    using var admin=new AdminClientBuilder(new AdminClientConfig(config)).SetLogHandler((_,_)=>{}).Build();
    var cluster=consumer.ClusterId(TimeSpan.FromSeconds(15));
    var topic=(await admin.DescribeTopicsAsync(TopicCollection.OfTopicNames([profile.Topic]),new(){RequestTimeout=TimeSpan.FromSeconds(15)})).TopicDescriptions.Single();
    if(topic.Error.IsError||topic.IsInternal||topic.Partitions.Count is <1 or >256)throw new ProcessingException("KAFKA_TOPIC_UNAVAILABLE");
    var topicId=topic.TopicId.ToString();
    if(args[0]=="discover") {Console.WriteLine(JsonSerializer.Serialize(new{clusterId=cluster,topicId,partitions=topic.Partitions.Count,tlsVerified=true,autoCommit=false,readCommitted=true},Data.Json));return;}
    if(profile.ClusterId!=cluster || profile.TopicId!=topicId)throw new ProcessingException("KAFKA_CLUSTER_OR_TOPIC_CHANGED");
    var partitions=topic.Partitions.Select(p=>new TopicPartition(profile.Topic,p.Partition)).ToArray();
    List<TopicPartitionOffset>? brokerOffsets=null;
    for(var attempt=0;brokerOffsets is null;attempt++)try{brokerOffsets=consumer.Committed(partitions,TimeSpan.FromSeconds(15));}catch(KafkaException error)when(attempt<3 && error.Error.Code is ErrorCode.NotCoordinatorForGroup or ErrorCode.GroupCoordinatorNotAvailable or ErrorCode.GroupLoadInProgress or ErrorCode.Local_TimedOut or ErrorCode.RequestTimedOut or ErrorCode.Local_WaitCoord){await Task.Delay(500*(attempt+1));}
    var committed=brokerOffsets.ToDictionary(p=>p.Partition.Value,p=>p.Offset.Value);
    var positions=new Dictionary<string,string>(StringComparer.Ordinal);var assigned=new List<TopicPartitionOffset>();
    foreach(var partition in partitions) {
        var marks=consumer.QueryWatermarkOffsets(partition,TimeSpan.FromSeconds(15));var key=partition.Partition.Value.ToString(CultureInfo.InvariantCulture);long offset;
        if(request.AfterOffsets?.TryGetValue(key,out var after)==true) {
            if(!long.TryParse(after,NumberStyles.None,CultureInfo.InvariantCulture,out offset)||offset<0)throw new ProcessingException("KAFKA_CHECKPOINT_INVALID");
            if(committed[partition.Partition.Value]>offset)throw new ProcessingException("KAFKA_BROKER_CHECKPOINT_AHEAD_OF_DURABLE_INTAKE");
        } else {
            if(committed[partition.Partition.Value]>=0)throw new ProcessingException("KAFKA_GROUP_ALREADY_HAS_UNOWNED_OFFSETS");
            offset=marks.Low.Value;
        }
        if(offset<marks.Low.Value)throw new ProcessingException("KAFKA_RETENTION_GAP");if(offset>marks.High.Value)throw new ProcessingException("KAFKA_LOG_TRUNCATED");
        positions[key]=offset.ToString(CultureInfo.InvariantCulture);assigned.Add(new(partition,new Offset(offset)));
    }
    consumer.Assign(assigned);
    var manifest=new KafkaManifest(cluster,topicId,profile.Topic,[],positions);Data.Write(Path.Combine(directory,"manifest.json"),manifest);
    var deadline=DateTimeOffset.UtcNow.AddSeconds(10);var total=0;
    while(manifest.Items.Count<profile.MaximumMessages&&total<profile.MaximumBytes&&DateTimeOffset.UtcNow<deadline) {
        var record=consumer.Consume(TimeSpan.FromMilliseconds(500));if(record is null)continue;if(record.IsPartitionEOF){if(manifest.Items.Count>0)break;continue;}
        var value=record.Message.Value??[];var key=record.Message.Key??[];
        if(value.Length>8388608||key.Length>4096||record.Message.Headers?.Count>64||record.Message.Headers?.Sum(h=>Encoding.UTF8.GetByteCount(h.Key)+(h.GetValueBytes()?.Length??0))>16384)throw new ProcessingException("KAFKA_MESSAGE_LIMIT");
        if(total+value.Length>profile.MaximumBytes)break; // This record is not acknowledged and is fetched again from the previous durable offset.
        var offset=record.Offset.Value.ToString(CultureInfo.InvariantCulture);var partition=record.Partition.Value.ToString(CultureInfo.InvariantCulture);
        var identity=Data.Hash(Data.Canonical(new JsonArray(cluster,topicId,profile.Topic,partition,offset)));
        var file="message-"+identity+".bin";
        var payload=Path.Combine(directory,file);var fileOptions=new FileStreamOptions{Mode=FileMode.CreateNew,Access=FileAccess.Write,Options=FileOptions.WriteThrough};if(!OperatingSystem.IsWindows())fileOptions.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;using(var output=new FileStream(payload,fileOptions)){output.Write(value);output.Flush(true);}
        var digest=Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(value));
        var headers=(record.Message.Headers??new Headers()).Select(h=>new KafkaHeader(h.Key,h.GetValueBytes() is byte[] bytes?Convert.ToBase64String(bytes):null)).ToArray();
        JsonNode? parsed=null;var kind=record.Message.Value is null?"tombstone":"binary";
        if(record.Message.Value is not null)try{parsed=Data.ParseStrict(value);kind="json";}catch(Exception error)when(error is System.Text.Json.JsonException or ProcessingException){try{parsed=JsonValue.Create(new UTF8Encoding(false,true).GetString(value));kind="text";}catch(DecoderFallbackException){parsed=new JsonObject{["base64"]=Convert.ToBase64String(value)};}}
        var metadata=new JsonObject{["eventId"]=identity,["clusterId"]=cluster,["topicId"]=topicId,["topic"]=profile.Topic,["partition"]=record.Partition.Value,["offset"]=offset,["keyBase64"]=record.Message.Key is null?null:Convert.ToBase64String(key),["headers"]=JsonSerializer.SerializeToNode(headers,Data.Json),["tombstone"]=record.Message.Value is null,["timestampUnixMs"]=record.Message.Timestamp.UnixTimestampMs.ToString(CultureInfo.InvariantCulture),["timestampKind"]=record.Message.Timestamp.Type.ToString(),["payloadKind"]=kind};
        var envelope=Path.Combine(directory,"envelope-"+identity+".json");Data.Write(envelope,new JsonArray(new JsonObject{["transport"]=metadata,["payload"]=parsed}));
        var envelopeDigest=Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(envelope)));
        manifest.Items.Add(new(identity,file,digest,value.Length,record.Partition.Value,offset,record.Message.Key is null?null:Convert.ToBase64String(key),headers,record.Message.Value is null,record.Message.Timestamp.UnixTimestampMs,record.Message.Timestamp.Type.ToString(),envelopeDigest,kind));
        positions[partition]=checked(record.Offset.Value+1).ToString(CultureInfo.InvariantCulture);total+=value.Length;
        Data.Write(Path.Combine(directory,"manifest.json"),manifest);
    }
    // No offset is stored or committed until the supervisor acknowledges durable private publication.
    Console.WriteLine(JsonSerializer.Serialize(new{ready=true,records=manifest.Items.Count,bytes=total,manifest="manifest.json"},Data.Json));
    var acknowledgment=await Console.In.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(60));
    if(acknowledgment!="DURABLY_ACCEPTED")throw new ProcessingException("KAFKA_DURABLE_INTAKE_ACKNOWLEDGMENT_REQUIRED");
    consumer.Commit(positions.Select(p=>new TopicPartitionOffset(profile.Topic,int.Parse(p.Key,CultureInfo.InvariantCulture),long.Parse(p.Value,CultureInfo.InvariantCulture))));
    consumer.Close();Console.WriteLine("{\"committed\":true}");
} catch(ProcessingException error) {Console.Error.WriteLine(error.Code);Environment.ExitCode=2;}
catch(KafkaException error) {Console.Error.WriteLine("KAFKA_"+Regex.Replace(error.Error.Code.ToString().ToUpperInvariant(),"[^A-Z0-9_]","_"));Environment.ExitCode=2;}
catch {Console.Error.WriteLine("KAFKA_CAPTURE_UNAVAILABLE");Environment.ExitCode=2;}

public sealed record KafkaProfile(string[] Brokers,string Topic,string GroupId,string Authentication,string? Username=null,string? Password=null,string? CaPem=null,string? CertificatePem=null,string? KeyPem=null,string? ClusterId=null,string? TopicId=null,string StartPosition="earliest",int MaximumMessages=16,int MaximumBytes=16777216);
public sealed record KafkaRequest(KafkaProfile Profile,Dictionary<string,string>? AfterOffsets=null);
public sealed record KafkaHeader(string Name,string? ValueBase64);
public sealed record KafkaItem(string EventId,string File,string Sha256,int Bytes,int Partition,string Offset,string? KeyBase64,KafkaHeader[] Headers,bool Tombstone,long TimestampUnixMs,string TimestampKind,string EnvelopeSha256,string PayloadKind);
public sealed record KafkaManifest(string ClusterId,string TopicId,string Topic,List<KafkaItem> Items,Dictionary<string,string> NextOffsets);
