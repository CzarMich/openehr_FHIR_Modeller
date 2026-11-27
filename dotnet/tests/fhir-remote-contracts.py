#!/usr/bin/env python3
"""Real C# FHIR remote adapter with a disposable synthetic HTTPS server; no attack/load testing."""
import argparse,json,os,subprocess,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SDK='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'
def run(*args):
    result=subprocess.run(args,capture_output=True,text=True)
    if result.returncode:raise RuntimeError(result.stdout+result.stderr)
    return result.stdout.strip()
def main():
    p=argparse.ArgumentParser();p.add_argument('--sdk-image',default=SDK);p.add_argument('--subnet');p.add_argument('--evidence',type=Path);args=p.parse_args()
    suffix=uuid.uuid4().hex[:12];network='modeller-fhir-remote-'+suffix;fixture=network+'-fixture'
    run('docker','network','create',*(['--subnet',args.subnet] if args.subnet else []),network)
    try:
        with tempfile.TemporaryDirectory(prefix='modeller-fhir-remote-') as temp:
            directory=Path(temp);directory.chmod(0o755);(directory/'key').write_text('a'*64);(directory/'key').chmod(0o600)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fhir-remote-fixture','-addext','subjectAltName=DNS:fhir-remote-fixture','-addext','basicConstraints=critical,CA:TRUE','-addext','extendedKeyUsage=serverAuth','-keyout',str(directory/'tls.key'),'-out',str(directory/'tls.crt'))
            run('docker','run','-d','--name',fixture,'--network',network,'--network-alias','fhir-remote-fixture','--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--cpus','0.5','--sysctl','net.ipv4.ip_unprivileged_port_start=0','-v',f'{directory}:/fixture-data','-v',f'{ROOT}/tests/fixtures/fhir-remote/server.mjs:/fixture/server.mjs:ro','node:22.22.1-bookworm-slim','node','/fixture/server.mjs')
            for _ in range(100):
                if(directory/'ready').exists():break
                time.sleep(.1)
            else:raise AssertionError('FHIR remote HTTPS fixture did not start')
            (directory/'token').write_text('fixture-definition-token')
            (directory/'login.json').write_text(json.dumps({'email':'fixture@example.org','password':'synthetic-secret'}))
            (directory/'connections.json').write_text(json.dumps({'ig':{'type':'ig','baseUrl':'https://fhir-remote-fixture/ig','loginFile':'/fixture-data/login.json'},'definitions':{'type':'runtime','baseUrl':'https://fhir-remote-fixture','credentialFile':'/fixture-data/token'}}))
            command=['docker','run','--rm','--network',network,'--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--tmpfs','/tmp:mode=1777,size=64m','-v',f'{ROOT}:/repo:ro','-v',f'{directory}:/fixture-data','-e','FHIR_CONNECTIONS_FILE=/fixture-data/connections.json','-e','FHIR_ALLOWED_HOSTS=fhir-remote-fixture','-e','HTTP_CA_BUNDLE=/fixture-data/tls.crt']
            command +=[args.sdk_image,'dotnet','/repo/dotnet/Modeller.Application.Tests/bin/Release/net10.0/Modeller.Application.Tests.dll','--fhir-remote-fixture']
            report=json.loads(run(*command));assert report.get('suite')=='fhir-remote-functional-https' and report.get('status')=='PASS', 'Wrong or stale fixture binary';report['scope']='Synthetic HTTPS FHIR definitions, IG authentication and synthetic validation; no live-provider qualification or clinical approval.'
            if args.evidence:args.evidence.parent.mkdir(parents=True,exist_ok=True);args.evidence.write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report))
    finally:
        subprocess.run(['docker','rm','-f',fixture],capture_output=True)
        subprocess.run(['docker','network','rm',network],capture_output=True)
if __name__=='__main__':main()
