#!/usr/bin/env python3
"""Actual private worker reads a pinned snapshot after the source disappears."""
import hashlib,json,pathlib,subprocess,tempfile,shutil,os
repo=pathlib.Path(__file__).resolve().parents[2]
sdk='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'
root=pathlib.Path(tempfile.mkdtemp(prefix='modeller-worker-snapshot-'))
try:
 job=root/'job';job.mkdir();(root/'source').mkdir()
 payload=b'[{"patient":"SYNTHETIC-SNAPSHOT-CANARY","value":12}]'
 (job/'source-snapshot.bin').write_bytes(payload)
 config={'modelRoot':'/fixture/models','fhirUrl':'https://unused.invalid','fhirKeyFile':'/fixture/unused','nativeUrl':'https://unused.invalid','nativeKeyFile':'/fixture/unused','sources':[{'id':'synthetic','root':'/fixture/source','format':'json','projects':['lab'],'owners':['a'*64]}],'destinations':[]}
 request={'owner':'a'*64,'projectId':'lab','subject':'b'*64,'sourceId':'synthetic','file':'original-missing.json','sourceSha256':hashlib.sha256(payload).hexdigest(),'mode':'export'}
 (root/'configuration.json').write_text(json.dumps(config));(job/'request.json').write_text(json.dumps(request))
 def invoke():return subprocess.run(['docker','run','--rm','-v',f'{repo}:/repo','-v',f'{root}:/fixture',sdk,'dotnet','/repo/dotnet/Modeller.Processing/bin/Release/net10.0/Modeller.Processing.dll','inspect','/fixture/configuration.json','/fixture/job'],capture_output=True,text=True,timeout=30)
 first=invoke();assert first.returncode==0,first.stderr;assert 'SYNTHETIC-SNAPSHOT-CANARY' not in first.stdout;assert json.loads(first.stdout)['count']==1
 (job/'source-snapshot.bin').write_bytes(b'[{"changed":true}]')
 changed=invoke();assert changed.returncode!=0 and 'SOURCE_CHANGED' in changed.stderr
 print('PASS actual worker snapshot: missing original, metadata-only inspection, exact hash enforcement')
finally:
 subprocess.run(['docker','run','--rm','-v',f'{root}:/fixture',sdk,'chown','-R',f'{os.getuid()}:{os.getgid()}','/fixture'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 shutil.rmtree(root)
