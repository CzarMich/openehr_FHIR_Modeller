#!/usr/bin/env python3
"""Independent full modelling MCP HTTP contracts and security checks; synthetic metadata only."""
import argparse,hashlib,importlib.util,json,os,socket,subprocess,tempfile,time,urllib.error,urllib.request,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('smoke',ROOT/'scripts/mcp-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
KEY='b'*64

def initialize(client):
    result=client.rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'application-contracts','version':'1'}})
    assert result['serverInfo']['name']=='openehr-fhir-modeller'
    client.rpc('notifications/initialized',notify=True)

def verify(url):
    checks=0;os.environ['AUTH_API_KEY']=KEY
    for _ in range(100):
        try:urllib.request.urlopen(url.removesuffix("/mcp")+"/health",timeout=1);break
        except (urllib.error.URLError,TimeoutError):time.sleep(.1)
    else:raise AssertionError("Isolated application did not become ready")
    baseline=json.loads((ROOT/'dotnet/contracts/modelling-baseline.json').read_text())
    baseline['tools']+=json.loads((ROOT/'dotnet/contracts/database-discovery.json').read_text())
    client=smoke.Client(url);initialize(client)
    actual=client.listing('tools/list','tools');assert actual==baseline['tools'],'Tool schema/annotation catalogue changed';checks+=1
    assert client.listing('prompts/list','prompts')==baseline['prompts'];checks+=1
    assert client.listing('resources/templates/list','resourceTemplates')==baseline['resourceTemplates'];checks+=1
    resources=client.listing('resources/list','resources');assert resources==baseline['resources'];checks+=1
    for descriptor in resources:
        uri=descriptor['uri'];result=client.rpc('resources/read',{'uri':uri})['contents'][0]
        assert result['uri']==uri
        if uri=='openehr://terminology':expected=ROOT/'resources/terminology/openehr_terminology.json'
        else:
            parts=uri.removeprefix('openehr://').split('/');expected=ROOT/'resources'/parts[0]/parts[1]/(parts[2]+('.adl' if parts[0]=='examples' and parts[1]=='archetypes' else '.md'))
        assert result['text'].encode()==expected.read_bytes(),uri;checks+=1
    for tool in baseline['tools']:
        try:client.rpc('tools/call',{'name':tool['name'],'arguments':{'__unexpected__':True}});raise AssertionError('Schema accepted unexpected input: '+tool['name'])
        except smoke.RpcError as error:assert error.code==-32602,tool['name']
        checks+=1
    for name,args in [('guide_search',{'query':'blood pressure','maxResults':3}),('examples_search',{'query':'pressure'}),('guide_adl_idiom_lookup',{'pattern':'cardinality'}),('type_specification_search',{'namePattern':'DV_*'}),('type_specification_get',{'name':'DV_QUANTITY','component':'RM'}),('terminology_resolve',{'input':'433'})]:
        value=client.tool(name,args);assert isinstance(value,dict),name
        if name.endswith('_search'):assert value['total']>=len(value['items']) and len(value['items'])>0,name
        if name=='type_specification_get':assert value['name']=='DV_QUANTITY' and value['resourceUri'].endswith('/RM/DV_QUANTITY')
        if name=='terminology_resolve':assert value['id']=='433' and value['groupId']
        checks+=1
    values={'task_type':'design','adl_version':'1.4','format_variant':'flat','translation_intent':'add-new-language','source_language_code':'en','target_language_code':'fr'}
    for prompt in baseline['prompts']:
        args={a['name']:values.get(a['name'],'Synthetic modelling fixture') for a in prompt.get('arguments',[]) if a.get('required')}
        result=client.rpc('prompts/get',{'name':prompt['name'],'arguments':args});assert result['messages'] and all(m['role'] in ['user','assistant'] for m in result['messages']);checks+=1
        if any(a.get('required') for a in prompt.get('arguments',[])):
            try:client.rpc('prompts/get',{'name':prompt['name'],'arguments':{}});raise AssertionError('Missing required prompt arguments accepted')
            except smoke.RpcError as error:assert error.code==-32602
            checks+=1
    for name,args in [('guide_get',{'uri':'file:///etc/passwd'}),('examples_get',{'uri':'openehr://examples/aql/../../etc/passwd'}),('type_specification_get',{'name':'../../etc/passwd'})]:client.tool(name,args,error=True);checks+=1
    project='contract-'+uuid.uuid4().hex[:12]
    created=client.tool('model_project_create',{'id':project,'name':'Synthetic contract project'});assert created['id']==project
    listed=client.tool('model_projects');assert any(p['id']==project for p in listed['projects']);checks+=2
    saved=client.tool('model_artifact_save',{'project':project,'path':'requirements/synthetic.md','content':'Synthetic narrative: preserve the original rule and require user review.'})
    read=client.tool('model_artifact_get',{'project':project,'path':'requirements/synthetic.md'});assert read==saved and saved['status']=='DRAFT';checks+=1
    client.tool('model_artifact_save',{'project':project,'path':'requirements/synthetic.md','content':'Conflicting stale replacement'},error=True);checks+=1
    updated=client.tool('model_artifact_save',{'project':project,'path':'requirements/synthetic.md','content':'Synthetic changed narrative requires a new revision.','expectedRevision':saved['revision']});assert updated['revision']!=saved['revision'];checks+=1
    historical=client.tool('model_artifact_get',{'project':project,'path':'requirements/synthetic.md','revision':saved['revision']});assert historical==saved;checks+=1
    history=client.tool('model_artifact_history',{'project':project,'path':'requirements/synthetic.md'});assert len(history['versions'])==2;checks+=1
    client.tool('model_artifact_save',{'project':project,'path':'requirements/../../etc/passwd','content':'Synthetic'},error=True);checks+=1
    client.tool('model_artifact_save',{'project':project,'path':'requirements/approved.md','content':'Synthetic','metadata':{'approved_by':'agent'}},error=True);checks+=1
    for name,args in [('aql_execute',{'connection_id':'synthetic','query':'SELECT e FROM EHR e LIMIT 1'}),('aql_history',{}),('aql_saved_get',{'id':'0'*32})]:
        result=client.tool(name,args,error=True);assert result['structuredContent']['error']['code']=='CDR_BROWSER_ONLY';checks+=1
    connectors=client.tool('source_connectors')['connectors'];assert len([c for c in connectors if c['family']=='database'])>=5 and {'epic-fhir','sap-bw','fhir-api','clinical-rest-api'} <= {c['id'] for c in connectors};checks+=1
    for connector in connectors:
        job=client.tool('source_discovery_job_create',{'project':project,'connector':connector['id'],'sourceProfile':'synthetic','purpose':'Synthetic discovery of resource source candidates','userNarrative':'Preserve vendor-specific schema evidence; do not infer clinical meaning or include patient rows.'})
        assert job['job']['state']=='PLANNED' and not job['executionAuthorised'] and not job['clinicalApproval'];checks+=1
        assert client.tool('source_discovery_job_get',{'project':project,'jobId':job['job']['id']})==job;checks+=1
        failure=client.tool('source_discovery_job_run',{'project':project,'jobId':job['job']['id'],'expectedRevision':job['revision']},error=True)
        code=json.loads(failure['content'][0]['text'])['error']['code'];assert code==('SOURCE_DATABASE_DISABLED' if connector['id']=='sqlserver' else 'SOURCE_CONNECTOR_NOT_QUALIFIED');checks+=1
    assert len(client.tool('source_discovery_jobs',{'project':project})['items'])==len(connectors);checks+=1
    disabled=client.tool('source_database_discover',{'project':project,'jobId':'discovery-'+'0'*32},error=True);assert json.loads(disabled['content'][0]['text'])['error']['code']=='SOURCE_DATABASE_DISABLED';checks+=1
    origin=url.removesuffix('/mcp')
    for path,headers,status in [('/mcp',{},401),('/mcp',{'X-API-Key':KEY,'Origin':'https://untrusted.invalid'},403),('/mcp',{'X-API-Key':KEY,'Host':'untrusted.invalid'},400),('/api/v1/reviews',{'X-API-Key':KEY},503),('/api/v1/projects',{},401)]:
        request=urllib.request.Request(origin+path,headers=headers)
        try:urllib.request.urlopen(request,timeout=10);raise AssertionError('Expected HTTP '+str(status))
        except urllib.error.HTTPError as error:assert error.code==status,(path,error.code,status)
        checks+=1
    request=urllib.request.Request(origin+'/api/v1/projects/'+project,headers={'X-API-Key':KEY});assert json.load(urllib.request.urlopen(request))['project']['id']==project;checks+=1
    print(json.dumps({'suite':'full-modelling-application','status':'PASS','checks':checks,'publishedTools':len(actual),'resources':len(resources),'clinicalData':False}))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--dll');parser.add_argument('--sdk-image');parser.add_argument('--image');args=parser.parse_args()
    if args.url:
        assert urllib.parse.urlsplit(args.url).hostname in ['127.0.0.1','localhost'],'Run these mutating synthetic probes only against an isolated loopback fixture.'
        verify(args.url);return
    with tempfile.TemporaryDirectory(prefix='modeller-application-contracts-') as directory:
        fixture=Path(directory);sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
        environment={**os.environ,'MODELLER_APPLICATION_ENABLED':'true','MODELLER_RESOURCE_ROOT':str(ROOT/'resources'),'AUTH_MODE':'api_key','AUTH_API_KEY':KEY,'APP_ENV':'testing','MODEL_REPOSITORY_PATH':str(fixture/'models'),'FHIR_REPOSITORY_PATH':str(fixture/'fhir-models'),'GOVERNANCE_DATABASE_PATH':str(fixture/'audit.sqlite'),'FHIR_AUDIT_PATH':str(fixture/'fhir.sqlite'),'MODEL_REPOSITORY_WRITE_ENABLED':'true','ASPNETCORE_URLS':f'http://127.0.0.1:{port}','GOVERNANCE_ENABLED':'false','CDR_ENABLED':'false','SOURCE_DATABASE_ENABLED':'false'}
        dll=str(Path(args.dll or ROOT/'dotnet/Modeller.Mcp/bin/Release/net10.0/Modeller.Mcp.dll').resolve());command=['dotnet',dll]
        if args.sdk_image:
            command=['docker','run','--rm','--user',f'{os.getuid()}:{os.getgid()}','--network','host','-v',f'{ROOT}:{ROOT}:ro','-v',f'{fixture}:{fixture}']+sum((['-e',k+'='+v] for k,v in environment.items() if k not in os.environ or os.environ[k]!=v),[])+[args.sdk_image]+command
        if args.image:
            environment['MODELLER_RESOURCE_ROOT']='/app/resources'
            command=['docker','run','--rm','--network','host','--user',f'{os.getuid()}:{os.getgid()}','-v',f'{fixture}:{fixture}']+sum((['-e',k+'='+v] for k,v in environment.items() if k not in os.environ or os.environ[k]!=v),[])+['--entrypoint','dotnet',args.image,'/app/Modeller.Mcp.dll']
        process=subprocess.Popen(command,env=environment,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
        try:
            url=f'http://127.0.0.1:{port}/mcp'
            for _ in range(100):
                if process.poll() is not None:raise AssertionError('Application failed to start: '+process.stderr.read()[-1600:])
                try:urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=1);break
                except (urllib.error.URLError,TimeoutError):time.sleep(.1)
            else:raise AssertionError('Application readiness timed out')
            verify(url)
        finally:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
if __name__=='__main__':main()
