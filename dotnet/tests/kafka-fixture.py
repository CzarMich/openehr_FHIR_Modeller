#!/usr/bin/env python3
"""Disposable synthetic TLS/SASL broker acceptance. No application images are built."""
import json,os,pathlib,socket,subprocess,tempfile,shutil,sys
r=pathlib.Path(__file__).resolve().parents[2]
root=pathlib.Path(tempfile.mkdtemp(prefix='modeller-kafka-fixture-'));name='modeller-kafka-fixture-'+root.name.rsplit('-',1)[-1]
image='apache/kafka:4.1.2@sha256:5cc2a2fd93fa2687b44015eee04fb2c3edd9e526bd64bf8bec5ff1e268772e0e'
sdk='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'
def run(args,**kwargs):return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
try:
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'ca.crt'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'])
 run(['openssl','pkcs12','-export','-in',str(root/'ca.crt'),'-inkey',str(root/'key.pem'),'-out',str(root/'broker.p12'),'-passout','pass:synthetic-fixture-only'])
 (root/'jaas.conf').write_text('KafkaServer { org.apache.kafka.common.security.plain.PlainLoginModule required username="fixture" password="synthetic-fixture-only" user_fixture="synthetic-fixture-only"; };')
 for file in ['keystore.password','key.password','truststore.password']:(root/file).write_text('synthetic-fixture-only')
 env={'KAFKA_OPTS':'-Djava.security.auth.login.config=/etc/kafka/secrets/jaas.conf','KAFKA_NODE_ID':'1','KAFKA_PROCESS_ROLES':'broker,controller','KAFKA_LISTENERS':'INTERNAL://:9092,CONTROLLER://:9094,SASL_SSL://:9093','KAFKA_ADVERTISED_LISTENERS':f'INTERNAL://localhost:9092,SASL_SSL://localhost:{port}','KAFKA_LISTENER_SECURITY_PROTOCOL_MAP':'INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL','KAFKA_INTER_BROKER_LISTENER_NAME':'INTERNAL','KAFKA_CONTROLLER_LISTENER_NAMES':'CONTROLLER','KAFKA_CONTROLLER_QUORUM_VOTERS':'1@localhost:9094','KAFKA_OFFSETS_TOPIC_NUM_PARTITIONS':'1','KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR':'1','KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR':'1','KAFKA_TRANSACTION_STATE_LOG_MIN_ISR':'1','KAFKA_AUTO_CREATE_TOPICS_ENABLE':'false','KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS':'0','KAFKA_SSL_KEYSTORE_FILENAME':'broker.p12','KAFKA_SSL_KEYSTORE_CREDENTIALS':'keystore.password','KAFKA_SSL_KEY_CREDENTIALS':'key.password','KAFKA_SSL_KEYSTORE_TYPE':'PKCS12','KAFKA_SSL_TRUSTSTORE_FILENAME':'broker.p12','KAFKA_SSL_TRUSTSTORE_CREDENTIALS':'truststore.password','KAFKA_SSL_TRUSTSTORE_TYPE':'PKCS12','KAFKA_SSL_CLIENT_AUTH':'none','KAFKA_SASL_ENABLED_MECHANISMS':'PLAIN','KAFKA_LISTENER_NAME_SASL__SSL_PLAIN_SASL_JAAS_CONFIG':'org.apache.kafka.common.security.plain.PlainLoginModule required username="fixture" password="synthetic-fixture-only" user_fixture="synthetic-fixture-only";','KAFKA_HEAP_OPTS':'-Xms256m -Xmx512m'}
 # Apache image runs as a non-root user; only disposable synthetic material is made readable here.
 root.chmod(0o755)
 for p in root.iterdir():p.chmod(0o644)
 envfile=root/'broker.env';envfile.write_text('\n'.join(k+'='+v for k,v in env.items())+'\n');envfile.chmod(0o600)
 run(['docker','run','-d','--name',name,'--memory','1g','--cpus','2','--env-file',str(envfile),'-p',f'127.0.0.1:{port}:9093','-v',f'{root}:/etc/kafka/secrets:ro',image])
 cmd=['docker','run','--rm','--network','host','-v',f'{r}:/repo','-v',f'{root}:/fixture','-v','/tmp/modeller-dotnet-nuget:/root/.nuget/packages','-w','/repo/dotnet',sdk,'dotnet','run','--project','Modeller.Kafka.Tests','-c','Release','-p:NuGetAudit=false','-p:RestoreLockedMode=true','--','/fixture',str(port),'/repo/dotnet/Modeller.Kafka/bin/Release/net10.0/Modeller.Kafka.dll']
 if os.environ.get('GITHUB_ACTIONS')=='true':
  # Hosted validation already provisions the pinned SDK. Keep generated build files owned by the runner.
  cmd=['dotnet','run','--project',str(r/'dotnet/Modeller.Kafka.Tests'),'-c','Release','-p:NuGetAudit=false','-p:RestoreLockedMode=true','--',str(root),str(port),str(r/'dotnet/Modeller.Kafka/bin/Release/net10.0/Modeller.Kafka.dll')]
 result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=240)
 if result.returncode:print(result.stdout[-8000:]);raise RuntimeError('Synthetic Kafka functional acceptance failed')
 print(result.stdout)
finally:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(["docker","run","--rm","-v",f"{root}:/fixture",sdk,"chown","-R",f"{os.getuid()}:{os.getgid()}","/fixture"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 shutil.rmtree(root)
