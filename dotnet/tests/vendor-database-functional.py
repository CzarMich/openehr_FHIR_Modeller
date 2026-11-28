#!/usr/bin/env python3
"""Disposable synthetic READ integration. No source write probes or clinical endpoints."""
import argparse,json,os,subprocess,tempfile,time,secrets,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--sdk-image',required=True);p.add_argument('--connector');args=p.parse_args()
repo=Path(__file__).resolve().parents[2]
def run(cmd,**kw):
 kw.setdefault('timeout',300)
 return subprocess.run(cmd,check=True,capture_output=True,text=True,**kw)
checks=0;images=[]
with tempfile.TemporaryDirectory(prefix='modeller-vendor-databases-') as directory:
 root=Path(directory);root.chmod(0o755)
 run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'ca.key'),'-out',str(root/'ca.pem'),'-days','2','-subj','/CN=Synthetic Vendor Fixture CA'])
 run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(root/'server.key'),'-out',str(root/'server.csr'),'-subj','/CN=localhost'])
 (root/'extensions').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
 run(['openssl','x509','-req','-in',str(root/'server.csr'),'-CA',str(root/'ca.pem'),'-CAkey',str(root/'ca.key'),'-CAcreateserial','-out',str(root/'server.pem'),'-days','2','-extfile',str(root/'extensions')])
 for item in root.iterdir():item.chmod(0o644 if item.suffix not in ['.key'] else 0o600)
 for kind,image,port in [('postgresql','postgres:17-bookworm',19541),('mysql','mysql:8.4',19542),('mariadb','mariadb:11.4',19543)]:
  if args.connector and args.connector!=kind:continue
  name='modeller-vendor-functional-'+secrets.token_hex(5);password='SYN-'+secrets.token_hex(20);admin='ROOT-'+secrets.token_hex(20)
  try:
   run(['docker','pull',image]);digest=run(['docker','image','inspect',image,'--format','{{index .RepoDigests 0}}']).stdout.strip();images.append({'connector':kind,'image':digest})
   (root/'admin.cnf').write_text('[client]\nuser=root\npassword='+admin+'\n');(root/'admin.cnf').chmod(0o600)
   if kind=='postgresql':
    command=['docker','run','-d','--rm','--name',name,'--memory=768m','--cpus=1','-p',f'127.0.0.1:{port}:5432','-e','POSTGRES_PASSWORD='+admin,'-e','POSTGRES_DB=clinical','-v',str(root)+':/fixture:ro','--entrypoint','sh',image,'-c','cp /fixture/server.key /tmp/server.key; cp /fixture/server.pem /tmp/server.pem; chown postgres:postgres /tmp/server.key /tmp/server.pem; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.pem -c ssl_key_file=/tmp/server.key']
   else:
    user='mysql';program='mysqld' if kind=='mysql' else 'mariadbd'
    command=['docker','run','-d','--rm','--name',name,'--memory=1g','--cpus=1','-p',f'127.0.0.1:{port}:3306','-e','MYSQL_ROOT_PASSWORD='+admin,'-e','MYSQL_DATABASE=clinical','-v',str(root)+':/fixture:ro','--entrypoint','sh',image,'-c',f'cp /fixture/server.key /tmp/server.key; cp /fixture/server.pem /tmp/server.pem; cp /fixture/ca.pem /tmp/ca.pem; chown {user}:{user} /tmp/server.key /tmp/server.pem /tmp/ca.pem; chmod 600 /tmp/server.key; exec docker-entrypoint.sh {program} --ssl-ca=/tmp/ca.pem --ssl-cert=/tmp/server.pem --ssl-key=/tmp/server.key']
   # Never print command arguments containing synthetic fixture passwords.
   try:run(command)
   except subprocess.CalledProcessError:raise RuntimeError('Synthetic database container could not start') from None
   def sql(text):
    cmd=['docker','exec','-i',name]+(['psql','-U','postgres','-d','clinical','-v','ON_ERROR_STOP=1'] if kind=='postgresql' else [('mysql' if kind=='mysql' else 'mariadb'),'--defaults-extra-file=/fixture/admin.cnf','--database=clinical'])
    return run(cmd,input=text)
   for attempt in range(180):
    try:sql('SELECT 1;');break
    except subprocess.CalledProcessError:time.sleep(1)
   else:raise RuntimeError('Synthetic database startup timed out')
   if kind=='postgresql':
    sql("CREATE ROLE reader LOGIN PASSWORD '"+password+"'; REVOKE TEMP ON DATABASE clinical FROM PUBLIC; CREATE SCHEMA vendor; CREATE TABLE vendor.events (id bigint PRIMARY KEY,patient_ref varchar(32),value decimal(12,3)); INSERT INTO vendor.events VALUES (1,'000001',12.300),(2,'000002',NULL); GRANT CONNECT ON DATABASE clinical TO reader; GRANT USAGE ON SCHEMA vendor TO reader; GRANT SELECT ON ALL TABLES IN SCHEMA vendor TO reader;")
    schemas=['vendor']
   else:
    sql("CREATE TABLE events (id bigint PRIMARY KEY,patient_ref varchar(32),value decimal(12,3)) ENGINE=InnoDB; INSERT INTO events VALUES (1,'000001',12.300),(2,'000002',NULL); CREATE USER 'reader'@'%' IDENTIFIED BY '"+password+"'; GRANT SELECT ON clinical.* TO 'reader'@'%';")
    schemas=['clinical']
   profile={'connector':kind,'host':'127.0.0.1','port':port,'database':'clinical','user':'reader','password':password,'tenant':'synthetic','projects':['fixture'],'schemas':schemas}
   call_count=[0]
   def adapter(operation,extra=None):
    call_count[0]+=1
    request=root/(kind+'-'+operation+'.json');request.write_text(json.dumps({'profile':profile,**(extra or {})}));request.chmod(0o600);output=root/(kind+'-'+operation+'-'+str(call_count[0]))
    cmd=['docker','run','--rm','--user',str(os.getuid())+':'+str(os.getgid()),'--network','host','-e','HTTP_CA_BUNDLE='+str(root/'ca.pem'),'-v',str(root)+':'+str(root),'-v',str(repo)+':'+str(repo)+':ro',args.sdk_image,'dotnet',str(repo/'dotnet/Modeller.Extraction/bin/Release/net10.0/Modeller.Extraction.dll'),operation,str(request),str(output)]
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=90)
    if result.returncode:
     diagnostic=cmd[:cmd.index(args.sdk_image)]+['-e','MODELLER_VENDOR_SYNTHETIC_FIXTURE=ephemeral-loopback-only',args.sdk_image,'dotnet',str(repo/'dotnet/Modeller.Vendor.Tests/bin/Release/net10.0/Modeller.Vendor.Tests.dll'),'--synthetic-database-diagnostic',str(request)]
     detail=subprocess.run(diagnostic,capture_output=True,text=True,timeout=60)
     raise RuntimeError(kind+' '+operation+': '+result.stderr.strip()+' '+detail.stderr.strip())
    assert '000001' not in result.stdout and password not in result.stdout
    return json.loads((output/'result.json').read_text()),output
   metadata,_=adapter('discover');table=next(t for t in metadata['tables'] if t['name']=='events');columns={c['name']:c['id'] for c in table['columns']}
   plan={'schemaFingerprint':metadata['schemaFingerprint'],'root':table['id'],'fields':[{'table':table['id'],'column':columns['id'],'field':'recordId','representation':'string'},{'table':table['id'],'column':columns['patient_ref'],'field':'patientId'},{'table':table['id'],'column':columns['value'],'field':'value'}],'joins':[],'filters':[],'limit':10}
   adapter('check-plan',{'plan':plan});result,output=adapter('extract',{'plan':plan});records=json.loads((output/'records.json').read_text())
   assert result['complete'] and result['readOnly'] and result['records']==2
   assert records[0]['patientId']=='000001' and records[0]['recordId']=='1' and records[0]['value']==12.3 and records[1]['value'] is None
   assert hashlib.sha256((output/'records.json').read_bytes()).hexdigest()==result['sha256']
   sql("INSERT INTO "+("vendor.events" if kind=="postgresql" else "events")+" VALUES (9223372036854775806,'000003',13.000),(9223372036854775807,'000004',14.000);")
   append_plan=dict(plan,fields=[dict(field,representation='native') if field['field']=='recordId' else field for field in plan['fields']],limit=1)
   cursor={'table':table['id'],'column':columns['id'],'field':'recordId'}
   first,_=adapter('extract',{'plan':append_plan,'cursor':cursor,'afterJson':'9223372036854775805'})
   assert first['records']==1 and first['hasMore'] and first['nextCursorJson']=='9223372036854775806',first
   second,_=adapter('extract',{'plan':append_plan,'cursor':cursor,'afterJson':first['nextCursorJson']})
   assert second['records']==1 and not second['hasMore'] and second['nextCursorJson']=='9223372036854775807',second
   checks+=2
   checks+=5;print(json.dumps({'connector':kind,'functionalReads':'PASS','tlsVerified':True,'syntheticRecords':2}),flush=True)
  finally:subprocess.run(['docker','rm','-f',name],capture_output=True)
print(json.dumps({'suite':'vendor-native-database-functional','status':'PASS','checks':checks,'images':images,'clinicalData':False,'sourceWriteProbes':False}))
