#!/usr/bin/env python3
"""Exact-byte internal audit cutover against disposable SQLite/PostgreSQL; no clinical DB/profile."""
import argparse,hashlib,json,os,secrets,sqlite3,subprocess,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SDK='mcr.microsoft.com/dotnet/sdk:10.0.404@sha256:8c6edfb26c85153f236d26efebd9ad349aec403583f343f201ee67838b23658d'
POSTGRES='postgres:16-alpine@sha256:44c4ee9810eff91f7eab4d822642e01115b1a9eccce4bcbdde7604752d68eac6'
def run(*arguments,check=True,**kwargs):
    result=subprocess.run(arguments,capture_output=True,text=True,**kwargs)
    if check and result.returncode:raise RuntimeError(result.stderr.strip() or 'Internal storage fixture command failed')
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--sdk-image',default=SDK);parser.add_argument('--image');parser.add_argument('--evidence',type=Path);args=parser.parse_args()
    suffix=uuid.uuid4().hex[:12];container='modeller-audit-'+suffix;volume='modeller-audit-data-'+suffix;checks=[]
    run('docker','volume','create',volume)
    try:
        with tempfile.TemporaryDirectory(prefix='modeller-audit-') as temporary:
            directory=Path(temporary)
            for filename in ['owner-password','app-password']:
                path=directory/filename;path.write_text(secrets.token_hex(32));path.chmod(0o644)
            run('docker','run','--rm','--network','none','--mount',f'type=volume,src={volume},dst=/var/lib/postgresql/data',POSTGRES,'chown','70:70','/var/lib/postgresql/data')
            run('docker','run','-d','--name',container,'--user','70:70','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:mode=1777,size=32m','--tmpfs','/var/run/postgresql:uid=70,gid=70,mode=0775,size=8m','-p','127.0.0.1::5432','--mount',f'type=volume,src={volume},dst=/var/lib/postgresql/data','-v',f'{directory}/owner-password:/run/secrets/owner-password:ro','-v',f'{directory}/app-password:/run/secrets/governance-password:ro','-v',f'{ROOT}/deploy/postgres/010-roles.sh:/docker-entrypoint-initdb.d/010-roles.sh:ro','-e','POSTGRES_DB=modelling','-e','POSTGRES_USER=modelling_owner','-e','POSTGRES_PASSWORD_FILE=/run/secrets/owner-password','-e','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',POSTGRES)
            def ready():
                for _ in range(100):
                    if run('docker','exec',container,'pg_isready','-h','127.0.0.1','-U','modelling_owner','-d','modelling',check=False).returncode==0:return
                    time.sleep(.1)
                raise AssertionError('Disposable internal PostgreSQL did not become ready')
            ready();port=run('docker','port',container,'5432/tcp').stdout.strip().rsplit(':',1)[1]
            source=directory/'audit.sqlite';nonce=secrets.token_hex(32);subject='a'*64
            def create_source(path,changed=False):
                raw=[];previous='0'*64
                for sequence in [1,2]:
                    event={'tenant':'shared','subject':subject,'sequence':sequence,'project':'synthetic','timestamp':'2026-11-27T00:00:00+00:00','previous_hash':previous,'type':'SYNTHETIC_EVENT','comment':('changed / naïve' if changed else 'retained / naïve')+str(sequence)}
                    text=json.dumps(event,separators=(',',':'),ensure_ascii=True);digest=hashlib.sha256(text.encode()).hexdigest();raw.append((text,digest));previous=digest
                with sqlite3.connect(path) as db:
                    db.executescript('CREATE TABLE governance_events(tenant TEXT,subject TEXT,sequence INTEGER,project TEXT,event TEXT,hash TEXT,PRIMARY KEY(tenant,subject,sequence)); CREATE TABLE governance_nonces(nonce TEXT PRIMARY KEY,expires INTEGER);')
                    for sequence,(text,digest) in enumerate(raw,1):db.execute('INSERT INTO governance_events VALUES(?,?,?,?,?,?)',('shared',subject,sequence,'synthetic',text,digest))
                    db.execute('INSERT INTO governance_nonces VALUES(?,?)',(nonce,int(time.time())+120))
                path.chmod(0o600);return raw
            expected=create_source(source);original=hashlib.sha256(source.read_bytes()).hexdigest()
            environment={'MODELLER_APPLICATION_ENABLED':'true','DOTNET_EnableDiagnostics':'0','GOVERNANCE_DATABASE_DRIVER':'postgres','GOVERNANCE_POSTGRES_DSN':f'pgsql:host=127.0.0.1;port={port};dbname=modelling;sslmode=disable','GOVERNANCE_POSTGRES_USER':'modelling_owner','GOVERNANCE_POSTGRES_PASSWORD_FILE':str(directory/'owner-password'),'GOVERNANCE_DATABASE_PATH':str(source)}
            def cli(action,*extra,role='owner',expected_status=0):
                values=dict(environment)
                if role=='app':values['GOVERNANCE_POSTGRES_USER']='modelling_app';values['GOVERNANCE_POSTGRES_PASSWORD_FILE']=str(directory/'app-password')
                command=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--cpus','1','--tmpfs','/tmp:mode=1777,size=64m','-v',f'{ROOT}:{ROOT}:ro','-v',f'{directory}:{directory}']
                for key,value in values.items():command+=['-e',key+'='+value]
                command+=([args.image] if args.image else [args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll')])+['storage',action,*extra]
                result=run(*command,check=False)
                if result.returncode!=expected_status:raise AssertionError('Internal maintenance result: '+result.stdout+result.stderr)
                return json.loads(result.stdout)
            first=cli('cutover');assert first['events']==2 and first['inserted']==2 and first['activeNoncesPreserved']==1 and first['hashChainsVerified'];assert Path(first['backup']).is_file();assert hashlib.sha256(source.read_bytes()).hexdigest()==original
            checks.append('consistent backup and exact source retention')
            def sql(query):return run('docker','exec',container,'psql','-XAt','-U','modelling_owner','-d','modelling','-c',query).stdout.strip()
            copied=sql('SELECT event FROM governance_events ORDER BY sequence').splitlines();assert copied==[event for event,_ in expected]
            assert sql('SELECT hash FROM governance_events ORDER BY sequence').splitlines()==[digest for _,digest in expected]
            assert sql('SELECT count(*) FROM governance_nonces')=='1'
            checks.append('event bytes, Unicode escapes, hashes and live replay nonces preserved')
            second=cli('cutover');assert second['events']==2 and second['inserted']==0 and second['existingIdentical']==2;checks.append('idempotent repeated cutover')
            app=cli('verify',role='app');assert app['events']==2 and app['subjects']==1 and app['hashChainsVerified'];checks.append('ordinary application identity reads verified migrated store')
            conflict=directory/'different.sqlite';create_source(conflict,True);failed=cli('import-sqlite',str(conflict),expected_status=1);assert failed['error']=='GOVERNANCE_MIGRATION_CONFLICT';assert sql('SELECT count(*) FROM governance_events')=='2';assert sql('SELECT event FROM governance_events ORDER BY sequence').splitlines()==copied;checks.append('conflicting history rolls back without rewriting destination')
            run('docker','restart',container);ready();port=run('docker','port',container,'5432/tcp').stdout.strip().rsplit(':',1)[1];environment['GOVERNANCE_POSTGRES_DSN']=f'pgsql:host=127.0.0.1;port={port};dbname=modelling;sslmode=disable';assert cli('verify',role='app')['events']==2;checks.append('PostgreSQL restart retains verified history')
            report={'status':'PASS','scope':'Disposable internal application audit stores only; no clinical source connection or attack testing.','checks':checks}
            if args.evidence:args.evidence.parent.mkdir(parents=True,exist_ok=True);args.evidence.write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report))
    finally:
        run('docker','rm','-f',container,check=False);run('docker','volume','rm',volume,check=False)
if __name__=='__main__':main()
