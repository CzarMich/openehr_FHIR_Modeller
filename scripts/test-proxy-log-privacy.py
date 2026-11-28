#!/usr/bin/env python3
"""Functional log redaction check using a prebuilt ingress image and synthetic data."""
import json, re, subprocess, sys, tempfile, time, urllib.request, urllib.error, uuid
from pathlib import Path
image=sys.argv[1] if len(sys.argv)>1 else subprocess.check_output(['docker','inspect','openehr-fhir-modeller-ingress-1','--format','{{.Config.Image}}'],text=True).strip()
if len(sys.argv)>1 and sys.argv[1]=='--base-image':
    image=re.search(r'^FROM (caddy:[^\s]+@sha256:[a-f0-9]{64})', (Path(__file__).resolve().parents[1]/'Dockerfile').read_text(), re.M)[1]
name='modeller-log-fixture-'+uuid.uuid4().hex[:10]
canary='synthetic-private-request-'+uuid.uuid4().hex
with tempfile.TemporaryDirectory(prefix='modeller-log-fixture-') as directory:
    root=Path(directory);root.chmod(0o755)
    actual=(Path(__file__).resolve().parents[1]/'.docker/Caddyfile').read_text()
    config=actual.split(':8343 {',1)[0]+'\n:19549 {\n reverse_proxy 127.0.0.1:1\n}\n'
    target=root/'Caddyfile';target.write_text(config);target.chmod(0o644)
    try:
        subprocess.run(['docker','run','--rm','--detach','--name',name,'--entrypoint','caddy','--publish','127.0.0.1:19549:19549','--volume',str(target)+':/fixture/Caddyfile:ro',image,'run','--config','/fixture/Caddyfile','--adapter','caddyfile'],check=True,stdout=subprocess.DEVNULL)
        for attempt in range(40):
            try:
                urllib.request.urlopen('http://127.0.0.1:19549/ready',timeout=1)
            except urllib.error.HTTPError:break
            except OSError:
                if attempt==39:raise
                time.sleep(.25)
        req=urllib.request.Request('http://127.0.0.1:19549/synthetic?private='+canary,headers={'X-Api-Key':canary,'X-Unusual-Clinical-Key':canary})
        try:urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as error:assert error.code==502
        logs=subprocess.check_output(['docker','logs',name],stderr=subprocess.STDOUT,text=True)
        events=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]
        errors=[event for event in events if event.get('level')=='error']
        assert errors,'Fixture must exercise a real upstream failure'
        assert canary not in logs,'Private request content reached the runtime log'
        assert all('request' not in event for event in errors),'Request objects must be omitted before encoding'
        assert any(isinstance(event.get('msg'),str) and event['msg'] for event in errors),'Keep diagnostic error messages'
        print('PASS synthetic proxy error retains diagnostics and omits private request headers/target')
    finally:subprocess.run(['docker','rm','--force',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
