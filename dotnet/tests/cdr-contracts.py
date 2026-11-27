#!/usr/bin/env python3
"""Real C# CDR adapter with a disposable synthetic HTTPS server; no attack/load testing."""
import argparse,json,os,subprocess,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SDK='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'
def run(*args):
    result=subprocess.run(args,capture_output=True,text=True)
    if result.returncode:raise RuntimeError(result.stdout+result.stderr)
    return result.stdout.strip()
def main():
    p=argparse.ArgumentParser();p.add_argument('--sdk-image',default=SDK);p.add_argument('--subnet');p.add_argument('--native-container');p.add_argument('--native-key-file');p.add_argument('--evidence',type=Path);args=p.parse_args()
    if bool(args.native_container)!=bool(args.native_key_file):p.error('Both native container and native key file are required together')
    suffix=uuid.uuid4().hex[:12];network='modeller-cdr-'+suffix;fixture=network+'-fixture'
    created_network=not bool(args.native_container)
    native_address=None
    if args.native_container:
        networks=json.loads(run('docker','inspect','--format','{{json .NetworkSettings.Networks}}',args.native_container));network=next(iter(networks));native_address=networks[network]['IPAddress']
    else:run('docker','network','create',*(['--subnet',args.subnet] if args.subnet else []),network)
    try:
        with tempfile.TemporaryDirectory(prefix='modeller-cdr-') as temp:
            directory=Path(temp);directory.chmod(0o755);(directory/'key').write_text('a'*64);(directory/'key').chmod(0o600)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=cdr-fixture','-addext','subjectAltName=DNS:cdr-fixture','-addext','basicConstraints=critical,CA:TRUE','-addext','extendedKeyUsage=serverAuth','-keyout',str(directory/'tls.key'),'-out',str(directory/'tls.crt'))
            run('docker','run','-d','--name',fixture,'--network',network,'--network-alias','cdr-fixture','--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--cpus','0.5','--sysctl','net.ipv4.ip_unprivileged_port_start=0','-v',f'{directory}:/fixture-data','-v',f'{ROOT}/tests/fixtures/cdr/server.mjs:/fixture/server.mjs:ro','node:22.22.1-bookworm-slim','node','/fixture/server.mjs')
            for _ in range(100):
                if(directory/'ready').exists():break
                time.sleep(.1)
            else:raise AssertionError('CDR HTTPS fixture did not start')
            command=['docker','run','--rm','--network',network,'--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--tmpfs','/tmp:mode=1777,size=64m','-v',f'{ROOT}:/repo:ro','-v',f'{directory}:/fixture-data','-e','CDR_ENABLED=true','-e','CDR_ALLOWED_HOSTS=cdr-fixture','-e','CDR_DATA_DIR=/fixture-data/cdr','-e','CDR_ENCRYPTION_KEY_FILE=/fixture-data/key']
            if args.native_container:
                address=native_address
                command+=['--add-host','app:'+address,'-v',f'{Path(args.native_key_file).resolve()}:/run/engine-key:ro','-e','OPENEHR_ENGINE_URL=http://app:8090','-e','OPENEHR_ENGINE_KEY_FILE=/run/engine-key']
            command +=[args.sdk_image,'dotnet','/repo/dotnet/Modeller.Application.Tests/bin/Release/net10.0/Modeller.Application.Tests.dll','--cdr-fixture']
            report=json.loads(run(*command));assert report.get('suite')=='cdr-functional-https' and report.get('status')=='PASS' and report.get('nativeQueryExecuted')==bool(args.native_container), 'Wrong or stale fixture binary';report['scope']='Synthetic HTTPS adapter acceptance; query acceptance only when nativeQueryExecuted is true. No hospital qualification or clinical approval.'
            if args.evidence:args.evidence.parent.mkdir(parents=True,exist_ok=True);args.evidence.write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report))
    finally:
        subprocess.run(['docker','rm','-f',fixture],capture_output=True)
        if created_network:subprocess.run(['docker','network','rm',network],capture_output=True)
if __name__=='__main__':main()
