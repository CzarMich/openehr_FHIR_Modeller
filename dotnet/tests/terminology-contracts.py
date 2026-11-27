#!/usr/bin/env python3
"""Functional terminology compatibility through actual MCP and an isolated synthetic HTTPS server."""
import argparse, json, os, socket, subprocess, tempfile, time, urllib.error, urllib.request, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SDK='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'

def run(*args, **kwargs):
    result=subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--image'); parser.add_argument('--sdk-image', default=SDK); parser.add_argument('--evidence', type=Path); parser.add_argument('--subnet')
    args=parser.parse_args(); suffix=uuid.uuid4().hex[:12]; network='modeller-terms-'+suffix; fixture='modeller-terms-fixture-'+suffix; app='modeller-terms-app-'+suffix
    run('docker','network','create',*(['--subnet',args.subnet] if args.subnet else []),network)
    try:
        with tempfile.TemporaryDirectory(prefix='modeller-terms-') as temporary:
            directory=Path(temporary); directory.chmod(0o755)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=terminology-fixture','-addext','subjectAltName=DNS:terminology-fixture','-addext','basicConstraints=critical,CA:TRUE','-addext','extendedKeyUsage=serverAuth','-keyout',str(directory/'tls.key'),'-out',str(directory/'tls.crt'))
            run('docker','run','-d','--name',fixture,'--network',network,'--network-alias','terminology-fixture','--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--cpus','0.5','--sysctl','net.ipv4.ip_unprivileged_port_start=0','-v',f'{directory}:/fixture-data','-v',f'{ROOT}/tests/fixtures/terminology/server.mjs:/fixture/server.mjs:ro','node:22.22.1-bookworm-slim','node','/fixture/server.mjs')
            for _ in range(100):
                if (directory/'ready').exists(): break
                time.sleep(.1)
            else: raise AssertionError('Synthetic terminology fixture failed to start')
            key='a'*64
            environment={'MODELLER_APPLICATION_ENABLED':'true','MODELLER_RESOURCE_ROOT':'/repo/resources','ASPNETCORE_URLS':'http://0.0.0.0:9000','APP_ENV':'testing','MCP_ALLOWED_HOSTS':'localhost,127.0.0.1','AUTH_MODE':'api_key','AUTH_API_KEY':key,'MODEL_REPOSITORY_PATH':'/fixture-data/models','GOVERNANCE_DATABASE_PATH':'/fixture-data/audit.sqlite','FHIR_REPOSITORY_PATH':'/fixture-data/fhir','FHIR_AUDIT_PATH':'/fixture-data/fhir.sqlite','TERMINOLOGY_FHIR_BASE_URL':'https://terminology-fixture/fhir/','TERMINOLOGY_API_KEY':'fixture-terminology-key','HTTP_CA_BUNDLE':'/fixture-data/tls.crt'}
            command=['docker','run','-d','--name',app,'--network',network,'-p','127.0.0.1::9000','--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--tmpfs','/tmp:mode=1777,size=64m','-v',f'{ROOT}:/repo:ro','-v',f'{directory}:/fixture-data']
            for key_name,value in environment.items(): command+=['-e',key_name+'='+value]
            command+= [args.image] if args.image else [args.sdk_image,'dotnet','/repo/dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll']
            run(*command)
            try: address=run('docker','port',app,'9000/tcp')
            except RuntimeError:
                print(run('docker','logs',app))
                print(run('docker','inspect','--format','{{json .State}} {{json .NetworkSettings.Ports}}',app))
                raise
            for _ in range(100):
                try:
                    urllib.request.urlopen('http://'+address+'/health',timeout=1);break
                except (urllib.error.URLError,TimeoutError,OSError): time.sleep(.1)
            else: raise AssertionError('C# terminology MCP fixture failed to start')
            evidence=directory/'acceptance.json'
            result=subprocess.run(['python3',str(ROOT/'scripts/terminology-fixture-smoke.py'),'--url','http://'+address+'/mcp','--evidence',str(evidence)],env={**os.environ,'AUTH_API_KEY':key},capture_output=True,text=True)
            if result.returncode: raise AssertionError(result.stdout+result.stderr)
            report=json.loads(evidence.read_text()); report['scope']='Actual C# MCP with authenticated synthetic HTTPS terminology fixture; no hospital acceptance or clinical approval asserted.'
            if args.evidence: args.evidence.parent.mkdir(parents=True,exist_ok=True);args.evidence.write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report))
            run('docker','rm','-f',app); app=None
            run('docker','rm','-f',fixture); fixture=None
    finally:
        for container in [app,fixture]:
            if container: subprocess.run(['docker','rm','-f',container],capture_output=True)
        subprocess.run(['docker','network','rm',network],capture_output=True)
if __name__=='__main__':main()
