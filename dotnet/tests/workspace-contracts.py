#!/usr/bin/env python3
"""Independent HTTP review contracts and optional installed-validator job acceptance.
Only synthetic fixture files are used. No clinical DB connection is made.
"""
import argparse,base64,hashlib,hmac,json,os,socket,subprocess,tempfile,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--sdk-image');p.add_argument('--dll',type=Path);p.add_argument('--installed-fhir',action='store_true');args=p.parse_args()
assert bool(args.sdk_image)!=bool(args.dll)
def digest(value):return hashlib.sha256(value.encode()).hexdigest()
def compact(value):return json.dumps(value,separators=(',',':'),ensure_ascii=False)
def canonical(value):return json.dumps(value,separators=(',',':'),ensure_ascii=False,sort_keys=True)
with tempfile.TemporaryDirectory(prefix='modeller-workspace-contracts-') as temporary:
    fixture=Path(temporary);key=os.urandom(32).hex();signing=os.urandom(32).hex();(fixture/'key').write_text(key)
    owner='b'*64;subject=None;checks=0
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    config={'modelRoot':str(fixture/'models'),'fhirUrl':'http://127.0.0.1:1','fhirKeyFile':str(fixture/'key'),'nativeUrl':'http://127.0.0.1:1','nativeKeyFile':str(fixture/'key'),'sources':[],'destinations':[],'requireTerminology':False}
    if args.installed_fhir:
        address=subprocess.check_output(['docker','inspect','--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}','openehr-fhir-modeller-fhir-1'],text=True).strip()
        config['fhirUrl']='http://'+address+':8094'
        config['fhirKeyFile']='/run/installed-fhir-key'
    (fixture/'config.json').write_text(compact(config))
    environment={'GUIDE_ROOT':str(ROOT/'resources/guides'),'DOTNET_MCP_API_KEY_FILE':str(fixture/'key'),'ASPNETCORE_URLS':f'http://127.0.0.1:{port}','MODELLER_WORKSPACE_ENABLED':'true','MODELLER_PROCESSING_CONFIG':str(fixture/'config.json'),'MODELLER_APPROVAL_KEYS':compact({'active':signing}),'MODELLER_APPROVAL_KEY_ID':'active','MODELLER_BROWSER_ORIGIN':'https://browser.example','MODELLER_IDENTITY_ISSUERS':'https://identity.example','MODELLER_DRAFT_WRITES_ENABLED':'true','DOTNET_EnableDiagnostics':'0'}
    if args.sdk_image:
        base=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{fixture}:{fixture}','-v',f'{ROOT}:{ROOT}:ro']
        if args.installed_fhir:base+=['-v','/opt/hygeoniq/projects/openehr-fhir-modeller/config/secrets/fhir-engine-key:/run/installed-fhir-key:ro']
        for name,value in environment.items():base+=['-e',name+'='+value]
        command=base+[args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll')]
    else:command=['dotnet',str(args.dll.resolve())]
    def proof(method,target,body,**changes):
        now=int(time.time());claims={'iss':'https://browser.example','aud':'openehr-modelling-integration','identity_issuer':'https://identity.example','identity_method':'interactive_local','tenant':'https://identity.example','sub':'synthetic-human','owner_hash':owner,'roles':['modelling-administrator'],'project_scopes':[],'session_started':now,'iat':now,'exp':now+60,'jti':os.urandom(32).hex(),'method':method,'target':target,'body_sha256':digest(body)};claims.update(changes)
        encode=lambda v:base64.urlsafe_b64encode(compact(v).encode()).decode().rstrip('=')
        value=encode({'alg':'HS256','typ':'openehr-integration+jwt','kid':'active'})+'.'+encode(claims)
        return value+'.'+base64.urlsafe_b64encode(hmac.digest(signing.encode(),value.encode(),'sha256')).decode().rstrip('=')
    def request(target,data=None,token=True,expected=200):
        global checks
        method='POST' if data is not None else 'GET';body=compact(data) if data is not None else ''
        headers={'X-API-Key':key,'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+(proof(method,target,body) if token is True else token)
        try:
            with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}'+target,data=body.encode() if data is not None else None,headers=headers,method=method),timeout=660) as response:status=response.status;value=json.load(response)
        except urllib.error.HTTPError as error:status=error.code;value=json.load(error)
        assert status==expected,(status,value);checks+=1;return value
    with (fixture/'service.log').open('w') as log:
        process=subprocess.Popen(command,env=dict(os.environ,**environment),stdout=log,stderr=log)
        try:
            for attempt in range(100):
                if process.poll() is not None:raise AssertionError((fixture/'service.log').read_text())
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/ready',timeout=1).close();break
                except Exception:time.sleep(.1)
            else:raise AssertionError('C# workspace startup timed out')
            request('/api/v1/integration/projects',token=False,expected=401)
            project={'name':'Synthetic acceptance','fhirVersion':'4.0.1','canonical':'https://example.org/synthetic-modeller','packageId':'org.example.synthetic','version':'1.0.0','publisher':'Synthetic acceptance','dependencies':[]}
            request('/api/v1/integration/projects',{'projectId':'synthetic','configuration':project})
            target='/api/v1/integration/projects/synthetic'
            replay=proof('GET',target,'');request(target,token=replay);request(target,token=replay,expected=401)
            request(target,token=proof('GET',target,'',exp=int(time.time())-1),expected=401)
            request(target,token=proof('GET',target,'',body_sha256=digest('changed')),expected=401)
            request(target,token=proof('GET',target,'',roles=['modelling-reviewer'],project_scopes=['project:other:read']),expected=403)
            profile={'resourceType':'StructureDefinition','id':'SyntheticPatient','url':'https://example.org/StructureDefinition/SyntheticPatient','version':'1.0.0','name':'SyntheticPatient','status':'draft','fhirVersion':'4.0.1','kind':'resource','abstract':False,'type':'Patient','baseDefinition':'http://hl7.org/fhir/StructureDefinition/Patient','derivation':'constraint','differential':{'element':[{'id':'Patient.identifier','path':'Patient.identifier','min':1}]}}
            model=request('/api/v1/integration/projects/synthetic/models',{'id':'synthetic-patient','standard':'FHIR','version':'1.0.0','origin':'externally-provided','content':compact(profile),'provenance':{'source':'Independent synthetic acceptance fixture'}})
            schema=[{'path':'/id','types':['string']},{'path':'/name','types':['string']}]
            def rule(source,target):return {'source':source,'target':target,'operation':'copy','description':'Synthetic exact copy','interpretation':'Copy the explicitly declared string without inference','assumptions':[],'missing':'reject','null':'reject'}
            seed={'resourceType':'Patient','identifier':[{'system':'urn:uuid:991c7a7a-c903-4da4-944c-23329b16797a'}],'active':True}
            output={**seed,'identifier':[{'system':'urn:uuid:991c7a7a-c903-4da4-944c-23329b16797a','value':'syn-1'}],'name':[{'text':'Synthetic One'}]}
            mapping={'schemaVersion':2,'name':'synthetic-patients','version':'1.0.0','direction':'source-direct-to-fhir','sourceSchema':schema,'sourceSchemaSha256':digest(canonical(schema)),'reversibility':'retained-context','description':'Synthetic acceptance, not a clinical mapping','requirements':[{'id':'USER-1','originalText':'Use the supplied profile; copy synthetic id and display name. Reject missing names.','basis':'user-instruction'}],'unresolvedQuestions':[],'examples':[{'synthetic':True,'input':{'id':'syn-1','name':'Synthetic One'},'expected':[output]},{'synthetic':True,'input':{'id':'syn-missing'},'expectedError':'RECORD_REQUIRED'}],'stages':[{'seed':seed,'rules':[rule('/id','/identifier/0/value'),rule('/name','/name/0/text')]}]}
            view=request('/api/v1/integration/projects/synthetic/mappings',{'modelKeys':[model['key']],'executionMapping':compact(mapping)})
            assert not view['mappingConfirmed'];subject=view['subject'];target='/api/v1/integration/mappings/'+subject+'/decisions'
            request(target,{'decision':'CONFIRMED','expectedSequence':0,'comment':'Inspected exact synthetic model and rules'},token=False,expected=401)
            view=request(target,{'decision':'CONFIRMED','expectedSequence':0,'comment':'Inspected exact synthetic model and rules'})
            assert view['mappingConfirmed'] and not view['clinicalApproval']
            request(target,{'decision':'CONFIRMED','expectedSequence':0,'comment':'Stale sequence'},expected=409)
            if args.installed_fhir:
                source=fixture/'source';source.mkdir();(source/'records.json').write_text(compact([{'id':'syn-1','name':'Synthetic One'},{'id':'syn-2','name':'Synthetic Two'},{'id':'syn-missing'}]))
                config['sources']=[{'id':'synthetic','root':str(source),'format':'json','projects':['synthetic'],'owners':[owner]}];(fixture/'config.json').write_text(compact(config))
                job=fixture/'job';job.mkdir();(job/'request.json').write_text(compact({'owner':owner,'projectId':'synthetic','subject':subject,'sourceId':'synthetic','file':'records.json','sourceSha256':hashlib.sha256((source/'records.json').read_bytes()).hexdigest(),'mode':'export','destinationId':None}))
                subprocess.run(base+[args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Processing/bin/Release/net10.0/Modeller.Processing.dll'),'run',str(fixture/'config.json'),str(job)],check=True,capture_output=True,text=True,timeout=660)
                state=json.loads((job/'state.json').read_text());assert (state['status'],state['read'],state['exported'],state['rejected'],state['emitted'])==('COMPLETED_WITH_FAILURES',3,2,1,0),{'state':state,'evidence':[json.loads(p.read_text()) for p in (job/'evidence').glob('*-fhir-*.json')]}
                assert len((job/'export.ndjson').read_text().splitlines())==2
                assert len((job/'quarantine.ndjson').read_text().splitlines())==1
                checks+=3
            request(target,{'decision':'REVOKED','expectedSequence':1,'comment':'Withdraw synthetic acceptance selection'})
            print(compact({'workspaceHttpChecks':checks,'status':'PASS','installedFhirJob':'PASS' if args.installed_fhir else 'NOT_EXECUTED','clinicalApproval':False}))
        finally:
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=15)
