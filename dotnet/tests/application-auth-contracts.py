#!/usr/bin/env python3
"""Isolated .NET application OIDC/JWKS/TLS and request-bound human assertion contracts."""
import argparse,base64,hashlib,hmac,http.server,importlib.util,json,os,socket,ssl,subprocess,tempfile,threading,time,urllib.error,urllib.request,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('smoke',ROOT/'scripts/mcp-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
def encode(value):return base64.urlsafe_b64encode(value if isinstance(value,bytes) else json.dumps(value,separators=(',',':')).encode()).rstrip(b'=')
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def request(base,path,token=None,method='GET',body=None,headers=None):
    data=None if body is None else body if isinstance(body,bytes) else json.dumps(body,separators=(',',':')).encode()
    hs={'Content-Type':'application/json',**(headers or {})}
    if token:hs['Authorization']='Bearer '+token
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers=hs,method=method),timeout=15) as r:return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--dll');parser.add_argument('--sdk-image');parser.add_argument('--image');args=parser.parse_args();checks=0
    def check(value,label):
        nonlocal checks
        assert value,label;checks+=1
    with tempfile.TemporaryDirectory(prefix='modeller-app-auth-') as directory:
        fixture=Path(directory);key=fixture/'rsa.key';cert=fixture/'tls.crt'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-addext','basicConstraints=critical,CA:TRUE'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        modulus=subprocess.check_output(['openssl','rsa','-in',str(key),'-noout','-modulus'],stderr=subprocess.DEVNULL).decode().strip().split('=',1)[1]
        jwk={'kty':'RSA','kid':'synthetic-key','use':'sig','alg':'RS256','n':encode(bytes.fromhex(modulus)).decode(),'e':'AQAB'}
        state={'keys':[jwk],'requests':0};issuer_port=port();issuer=f'https://127.0.0.1:{issuer_port}'
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                state['requests']+=1;data=json.dumps({'keys':state['keys']}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def log_message(self,*a):pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',issuer_port),Handler);context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key);server.socket=context.wrap_socket(server.socket,server_side=True);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def jwt(overrides=None,header=None,raw=None):
            now=int(time.time());claims={'iss':issuer,'aud':'synthetic-api','sub':'writer','iat':now,'exp':now+300,'azp':'synthetic-client','scope':'modelling.read projects:create project:fixture:write','realm_access':{'roles':['modeller']},'organisation':{'id':'one'}};claims.update(overrides or {})
            unsigned=encode(header or {'alg':'RS256','kid':'synthetic-key','typ':'JWT'})+b'.'+encode(raw if raw is not None else claims)
            signature=subprocess.check_output(['openssl','dgst','-sha256','-sign',str(key)],input=unsigned,stderr=subprocess.DEVNULL)
            return (unsigned+b'.'+encode(signature)).decode()
        app_port=port();base=f'http://127.0.0.1:{app_port}';hmac_key='synthetic-browser-key-'+'c'*44;api_key='d'*64
        env={'MODELLER_APPLICATION_ENABLED':'true','MODELLER_RESOURCE_ROOT':str(ROOT/'resources'),'AUTH_MODE':'oidc','APP_ENV':'testing','OIDC_ISSUER':issuer,'OIDC_JWKS_URI':issuer+'/keys','OIDC_AUDIENCE':'synthetic-api','OIDC_REQUIRED_SCOPES':'modelling.read','OIDC_TENANT_CLAIM':'organisation.id','OIDC_ROLES_CLAIM':'realm_access.roles','OIDC_ALLOWED_TENANTS':'one,two','OIDC_ALLOWED_CLIENT_IDS':'synthetic-client','OIDC_CLOCK_SKEW':'0','HTTP_CA_BUNDLE':str(cert),'MODEL_REPOSITORY_PATH':str(fixture/'models'),'FHIR_REPOSITORY_PATH':str(fixture/'fhir'),'MODEL_REPOSITORY_WRITE_ENABLED':'true','PROJECT_RBAC_ENABLED':'true','GOVERNANCE_DATABASE_DRIVER':'sqlite','GOVERNANCE_DATABASE_PATH':str(fixture/'audit.sqlite'),'GOVERNANCE_ENABLED':'true','GOVERNANCE_BROWSER_KEYS':json.dumps({'fixture':hmac_key}),'GOVERNANCE_BROWSER_ORIGIN':'https://browser.example.invalid','GOVERNANCE_LOCAL_IDENTITY_ISSUER':'http://localhost:18350/identity/local','GOVERNANCE_OIDC_ISSUER':issuer,'CDR_ENABLED':'false','SOURCE_DATABASE_ENABLED':'false','ASPNETCORE_URLS':base,'AUTH_API_KEY':api_key}
        dll=str(Path(args.dll or ROOT/'dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll').resolve());command=['dotnet',dll]
        if args.sdk_image:command=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{ROOT}:{ROOT}:ro','-v',f'{fixture}:{fixture}']+sum((['-e',k+'='+v] for k,v in env.items()),[])+[args.sdk_image]+command
        if args.image:
            env['MODELLER_RESOURCE_ROOT']='/app/resources'
            command=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{fixture}:{fixture}']+sum((['-e',k+'='+v] for k,v in env.items()),[])+['--entrypoint','dotnet',args.image,'/app/Modeller.Mcp.dll']
        process=subprocess.Popen(command,env={**os.environ,**env},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        try:
            for _ in range(150):
                if process.poll() is not None:raise AssertionError('Fixture application stopped: '+process.stderr.read()[-1000:])
                try:
                    if request(base,'/health')[0]==200:break
                except urllib.error.URLError:pass
                time.sleep(.1)
            else:raise AssertionError('Fixture startup timeout')
            writer=jwt();status,body=request(base,'/api/v1/projects',writer);check(status==200,('Valid signed OIDC token and custom CA',status,body))
            check(state['requests']==1,'JWKS retrieval cached')
            cases=[({'iss':'https://wrong.invalid'},None),({'aud':'wrong'},None),({'exp':int(time.time())-5},None),({'iat':int(time.time())+300},None),({'iat':int(time.time())-9000},None),({'iat':'123'},None),({'exp':'123'},None),({'scope':'other'},None),({'azp':'wrong'},None),({'organisation':{'id':'unknown'}},None),({'organisation':{}},None),({'sub':''},None),({'realm_access':{'roles':[1]}},None),({}, {'alg':'HS256','kid':'synthetic-key'}),({}, {'alg':'none','kid':'synthetic-key'}),({}, {'alg':'RS256'})]
            for claims,header in cases:check(request(base,'/api/v1/projects',jwt(claims,header))[0]==401,'Invalid token rejected')
            duplicate=b'{"iss":"wrong","iss":"'+issuer.encode()+b'","aud":"synthetic-api","sub":"writer","iat":1,"exp":9999999999}'
            check(request(base,'/api/v1/projects',jwt(raw=duplicate))[0]==401,'Duplicate JSON claims rejected')
            check(request(base,'/api/v1/projects',writer[:-5]+'AAAAA')[0]==401,'Bad signature rejected')
            check(request(base,'/api/v1/projects',None,headers={'X-API-Key':api_key})[0]==401,'API key cannot bypass OIDC')
            check(request(base,'/api/v1/projects',writer,'POST',{'id':'fixture','name':'Synthetic authenticated project'})[0]==201,'Writer can create project')
            reader=jwt({'sub':'reader','realm_access':{'roles':['reader']}})
            check(request(base,'/api/v1/projects',reader,'POST',{'id':'forbidden','name':'Synthetic'})[0]==403,'Reader cannot write')
            restricted=jwt({'sub':'restricted','scope':'modelling.read','realm_access':{'roles':['modeller']}})
            check(request(base,'/api/v1/projects/fixture',restricted)[0]==403,'Project scopes enforced')
            other=jwt({'sub':'other','organisation':{'id':'two'}})
            check(request(base,'/api/v1/projects/fixture',other)[0]==404,'Tenant repositories isolated')
            first=smoke.Client(base+'/mcp',bearer=writer);first.rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'synthetic-auth','version':'1'}})
            check(bool(first.session),'MCP session issued')
            fhir_config={'name':'Synthetic FHIR project','fhirVersion':'4.0.1','canonical':'https://example.org/synthetic','packageId':'org.example.synthetic','version':'1.0.0','publisher':'Synthetic fixture','dependencies':[]}
            created=first.tool('fhir_project',{'action':'create','projectId':'fhir-created','document':json.dumps(fhir_config)})
            check(created['project']['id']=='fhir-created','Project-create scope permits FHIR creation without unrelated write scope')
            hidden=smoke.Client(base+'/mcp',bearer=restricted);hidden.rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'synthetic-restricted','version':'1'}})
            check(hidden.tool('fhir_project',{'action':'list'})['items']==[],'FHIR project list respects project read scopes')
            check(request(base,'/mcp',reader,headers={'Mcp-Session-Id':first.session})[0]==403,'MCP sessions bound to actor')
            check(request(base,'/api/v1/reviews?project=fixture',writer)[0]==401,'Ordinary OIDC cannot approve as human')
            target='/api/v1/reviews?project=fixture';body=b''
            def assertion(changes=None,header=None):
                now=int(time.time());claims={'iss':env['GOVERNANCE_BROWSER_ORIGIN'],'aud':'openehr-modelling-review','sub':'human','iat':now,'exp':now+30,'session_started':now,'identity_issuer':env['GOVERNANCE_LOCAL_IDENTITY_ISSUER'],'tenant':env['GOVERNANCE_LOCAL_IDENTITY_ISSUER'],'identity_method':'interactive_local','roles':['modelling-reviewer'],'project_scopes':['project:fixture:read'],'method':'GET','target':target,'body_sha256':hashlib.sha256(body).hexdigest(),'jti':hashlib.sha256(uuid.uuid4().bytes).hexdigest()};claims.update(changes or {});unsigned=encode(header or {'alg':'HS256','typ':'openehr-review+jwt','kid':'fixture'})+b'.'+encode(claims);return(unsigned+b'.'+encode(hmac.digest(hmac_key.encode(),unsigned,'sha256'))).decode()
            token=assertion();status,body=request(base,target,token);check(status==200,('Valid human assertion with preserved HTTP local issuer',status,body))
            check(request(base,target,token)[0]==401,'Human assertion replay rejected')
            for changes in [{'aud':'openehr-modelling-cdr'},{'method':'POST'},{'target':target+'&other=1'},{'body_sha256':'0'*64},{'identity_method':'mcp'},{'roles':['reviewer']},{'identity_issuer':'http://other.invalid'},{'tenant':'other'},{'exp':int(time.time())-1},{'session_started':int(time.time())-90000}]:
                # Requests are GET with an empty body; do not bind the previous response bytes.
                body=b'';check(request(base,target,assertion(changes))[0] in (401,403),'Invalid human assertion rejected')
            print(json.dumps({'suite':'application-oidc-and-human-assertion-security','status':'PASS','checks':checks,'clinicalData':False,'tlsVerified':True}))
        finally:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
            server.shutdown();server.server_close()
if __name__=='__main__':main()
