#!/usr/bin/env python3
"""Independent HTTP review contracts and optional installed-validator job acceptance.
Only synthetic fixture files are used. No clinical DB connection is made.
"""
import argparse,base64,hashlib,hmac,json,os,socket,subprocess,tempfile,time,urllib.request,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--sdk-image');p.add_argument('--dll',type=Path);p.add_argument('--installed-fhir',action='store_true');p.add_argument('--installed-native',action='store_true');p.add_argument('--export-fixture',type=Path);args=p.parse_args()
assert bool(args.sdk_image)!=bool(args.dll)
assert not args.installed_native or args.installed_fhir and args.sdk_image, 'Native acceptance requires the isolated SDK fixture and installed FHIR engine'
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
        if args.installed_native:
            app_inspect=json.loads(subprocess.check_output(['docker','inspect','openehr-fhir-modeller-app-1'],text=True))[0]
            app_address=app_inspect['NetworkSettings']['Networks']['openehr-fhir-modeller_default']['IPAddress']
            config['nativeUrl']='http://app:8090';config['nativeKeyFile']='/run/installed-fhir-key'
    (fixture/'config.json').write_text(compact(config))
    environment={'GUIDE_ROOT':str(ROOT/'resources/guides'),'DOTNET_MCP_API_KEY_FILE':str(fixture/'key'),'ASPNETCORE_URLS':f'http://127.0.0.1:{port}','MODELLER_WORKSPACE_ENABLED':'true','MODELLER_PROCESSING_CONFIG':str(fixture/'config.json'),'MODELLER_APPROVAL_KEYS':compact({'active':signing}),'MODELLER_APPROVAL_KEY_ID':'active','MODELLER_BROWSER_ORIGIN':'https://browser.example','MODELLER_IDENTITY_ISSUERS':'https://identity.example','MODELLER_DRAFT_WRITES_ENABLED':'true','DOTNET_EnableDiagnostics':'0'}
    if args.sdk_image:
        base=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{fixture}:{fixture}','-v',f'{ROOT}:{ROOT}:ro']
        if args.installed_fhir:base+=['-v','/opt/hygeoniq/projects/openehr-fhir-modeller/config/secrets/fhir-engine-key:/run/installed-fhir-key:ro']
        if args.installed_native:base+=['--add-host','app:'+app_address]
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
                # External SDs may legitimately omit a business version: pin bytes, never invent one.
                unversioned=dict(profile);unversioned.pop('version');content=compact(unversioned)
                exact=request('/api/v1/integration/projects/synthetic/models',{'id':'external-unversioned','standard':'FHIR','version':'sha256-'+digest(content),'origin':'externally-provided','content':content,'provenance':{'source':'Synthetic unversioned external SD'}})
                unversioned_mapping=dict(mapping,name='unversioned-synthetic-patients')
                selected=request('/api/v1/integration/projects/synthetic/mappings',{'modelKeys':[exact['key']],'executionMapping':compact(unversioned_mapping)})
                request('/api/v1/integration/mappings/'+selected['subject']+'/decisions',{'decision':'CONFIRMED','expectedSequence':0,'comment':'Reviewed the exact unversioned SD content hash'})
                second=fixture/'unversioned-job';second.mkdir();second_request=json.loads((job/'request.json').read_text());second_request['subject']=selected['subject'];(second/'request.json').write_text(compact(second_request))
                subprocess.run(base+[args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Processing/bin/Release/net10.0/Modeller.Processing.dll'),'run',str(fixture/'config.json'),str(second)],check=True,capture_output=True,text=True,timeout=660)
                second_state=json.loads((second/'state.json').read_text());assert (second_state['exported'],second_state['rejected'],second_state['emitted'])==(2,1,0),second_state
                checks+=1
                invalid=dict(profile);invalid.pop('differential')
                bad=request('/api/v1/integration/projects/synthetic/models',{'id':'invalid-synthetic-profile','standard':'FHIR','version':'1.0.0','origin':'externally-provided','content':compact(invalid),'provenance':{'source':'Intentionally invalid synthetic SD'}})
                bad_mapping=dict(mapping,name='invalid-sd-synthetic-patients')
                bad_view=request('/api/v1/integration/projects/synthetic/mappings',{'modelKeys':[bad['key']],'executionMapping':compact(bad_mapping)})
                request('/api/v1/integration/mappings/'+bad_view['subject']+'/decisions',{'decision':'CONFIRMED','expectedSequence':0,'comment':'Synthetic test: selection is not technical validation'})
                blocked=fixture/'invalid-sd-job';blocked.mkdir();blocked_request=dict(second_request,subject=bad_view['subject']);(blocked/'request.json').write_text(compact(blocked_request))
                subprocess.run(base+[args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Processing/bin/Release/net10.0/Modeller.Processing.dll'),'run',str(fixture/'config.json'),str(blocked)],check=True,capture_output=True,text=True,timeout=660)
                blocked_state=json.loads((blocked/'state.json').read_text());assert (blocked_state['status'],blocked_state['error'],blocked_state['exported'],blocked_state['emitted'])==('BLOCKED','MODEL_FHIR_VALIDATION',0,0),blocked_state
                checks+=1
                if args.installed_native:
                    # Compile an existing non-clinical test fixture through the real C# engine adapter.
                    archetype=(ROOT/'engine/src/test/resources/legacy/composition.adl').read_text()
                    archetype=archetype[:archetype.index('definition')]+'definition\n COMPOSITION[at0000] matches {*}\n'+archetype[archetype.index('ontology'):]
                    archetype=archetype[:archetype.index('    term_bindings')]
                    oet='<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id>33826b37-78c6-4796-9b4b-6e6e926e4375</id><name>Synthetic legacy test</name><definition xsi:type="COMPOSITION" archetype_id="openEHR-EHR-COMPOSITION.engine_fixture.v1"/></template>'
                    compiled=request('/api/v1/integration/execute',{'tool':'modelling_engine','action':'openehr','projectId':'synthetic','arguments':{'operation':'compile/template','parameters':{'content':oet,'dependencies':[{'identifier':'openEHR-EHR-COMPOSITION.engine_fixture.v1','content':archetype,'sha256':digest(archetype)}]}}})
                    assert 'output' in compiled,compiled
                    opt=compiled['output']['content']
                    template_model=request('/api/v1/integration/projects/synthetic/models',{'id':'synthetic-opt','standard':'openEHR','version':'1.0.0','origin':'agent-modelled','content':opt,'provenance':{'source':'Compiled existing non-clinical SDK test fixture'}})
                    java=(ROOT/'engine/src/test/java/org/openehr/modelling/engine/CompositionValidationTest.java').read_text()
                    composition=json.loads(java.split('static final String COMPOSITION = """')[1].split('"""')[0])
                    first={'seed':composition,'rules':[rule('/id','/composer/name'),rule('/name','/name/value')]}
                    second_stage={'seed':seed,'rules':[rule('/composer/name','/identifier/0/value'),rule('/name/value','/name/0/text')]}
                    via=dict(mapping,name='native-synthetic-patients',direction='source-to-fhir',stages=[first,second_stage])
                    via['requirements']=[{'id':'SYNTHETIC-1','originalText':'Create a non-clinical persistent composition, then preserve the synthetic ID and display label in Patient.','basis':'user-instruction'}]
                    via_view=request('/api/v1/integration/projects/synthetic/mappings',{'modelKeys':[model['key'],template_model['key']],'executionMapping':compact(via)})
                    request('/api/v1/integration/mappings/'+via_view['subject']+'/decisions',{'decision':'CONFIRMED','expectedSequence':0,'comment':'Synthetic acceptance only; inspected exact OPT, SD and two-stage rules'})
                    def run_job(name,job_request):
                        directory=fixture/name;directory.mkdir();(directory/'request.json').write_text(compact(job_request))
                        subprocess.run(base+[args.sdk_image,'dotnet',str(ROOT/'dotnet/Modeller.Processing/bin/Release/net10.0/Modeller.Processing.dll'),'run',str(fixture/'config.json'),str(directory)],check=True,capture_output=True,text=True,timeout=660)
                        state=json.loads((directory/'state.json').read_text());return directory,state
                    native_request=json.loads((job/'request.json').read_text());native_request['subject']=via_view['subject']
                    native_job,native_state=run_job('native-job',native_request)
                    assert (native_state['exported'],native_state['rejected'],native_state['emitted'])==(2,1,0),native_state
                    native_evidence=[json.loads(file.read_text()) for file in (native_job/'evidence').glob('*-openehr.json')]
                    assert len(native_evidence)==2 and all(report['valid'] and report['status']=='PASS' and not report['clinical_approval'] for report in native_evidence)
                    forward=[json.loads(line) for line in (native_job/'export.ndjson').read_text().splitlines()]
                    incoming=compact(forward);(source/'incoming-fhir.json').write_text(incoming)
                    config['sources'].append({'id':'incoming-fhir','root':str(source),'format':'fhir-json','projects':['synthetic'],'owners':[owner]});(fixture/'config.json').write_text(compact(config))
                    field_types={}
                    def fields(value,path=''):
                        if isinstance(value,dict):
                            if path:field_types.setdefault(path,set()).add('object')
                            for key,item in value.items():fields(item,path+'/'+key.replace('~','~0').replace('/','~1'))
                        elif isinstance(value,list):
                            field_types.setdefault(path,set()).add('array')
                            for item in value:fields(item,path+'/*')
                        else:field_types.setdefault(path,set()).add('null' if value is None else 'boolean' if isinstance(value,bool) else 'number' if isinstance(value,(int,float)) else 'string')
                    for record in forward:fields(record)
                    reverse_schema=[{'path':path,'types':sorted(types)} for path,types in sorted(field_types.items())]
                    reverse_expected=json.loads(compact(composition));reverse_expected['composer']['name']='syn-1';reverse_expected['name']['value']='Synthetic One'
                    reverse=dict(via,name='native-reverse-synthetic-patients',direction='fhir-to-openehr',sourceSchema=reverse_schema,sourceSchemaSha256=digest(canonical(reverse_schema)),stages=[{'seed':composition,'rules':[rule('/identifier/0/value','/composer/name'),rule('/name/0/text','/name/value')]}],examples=[{'synthetic':True,'input':forward[0],'expected':[reverse_expected]}])
                    reverse['requirements']=[{'id':'SYNTHETIC-REVERSE-1','originalText':'Separately map the synthetic Patient identifier and display label back to a persistent composition.','basis':'user-instruction'}]
                    reverse_view=request('/api/v1/integration/projects/synthetic/mappings',{'modelKeys':[model['key'],template_model['key']],'executionMapping':compact(reverse)})
                    request('/api/v1/integration/mappings/'+reverse_view['subject']+'/decisions',{'decision':'CONFIRMED','expectedSequence':0,'comment':'Synthetic reverse mapping with explicitly bounded round-trip assertions'})
                    reverse_request=dict(native_request,subject=reverse_view['subject'],sourceId='incoming-fhir',file='incoming-fhir.json',sourceSha256=digest(incoming))
                    reverse_job,reverse_state=run_job('native-reverse-job',reverse_request)
                    assert (reverse_state['exported'],reverse_state['rejected'],reverse_state['emitted'])==(2,0,0),reverse_state
                    backward=[json.loads(line) for line in (reverse_job/'export.ndjson').read_text().splitlines()]
                    assert [(r['identifier'][0]['value'],r['name'][0]['text']) for r in forward]==[(r['composer']['name'],r['name']['value']) for r in backward]
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        concurrent=list(pool.map(lambda name:run_job(name,native_request),['native-concurrent-one','native-concurrent-two']))
                    assert all((state['exported'],state['rejected'],state['emitted'])==(2,1,0) for directory,state in concurrent),[state for directory,state in concurrent]
                    checks+=6
            request(target,{'decision':'REVOKED','expectedSequence':1,'comment':'Withdraw synthetic acceptance selection'})
            if args.export_fixture:
                import shutil
                assert not args.export_fixture.exists(), 'Refuse to overwrite an existing fixture export'
                shutil.copytree(fixture,args.export_fixture);(args.export_fixture/'acceptance-keys.json').write_text(compact({'active':signing}));(args.export_fixture/'acceptance-keys.json').chmod(0o600)
            print(compact({'workspaceHttpChecks':checks,'status':'PASS','installedFhirJob':'PASS' if args.installed_fhir else 'NOT_EXECUTED','nativeForwardAndReverse':'PASS' if args.installed_native else 'NOT_EXECUTED','roundTripScope':'Synthetic identifier and display label only' if args.installed_native else None,'clinicalApproval':False}))
        finally:
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=15)
