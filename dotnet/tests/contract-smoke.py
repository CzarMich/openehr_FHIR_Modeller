#!/usr/bin/env python3
"""Independent MCP contract/content/security probes. No model API or patient data."""
import argparse,hashlib,importlib.util,json,os,subprocess,sys,urllib.error,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('smoke',ROOT/'scripts/mcp-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
class Stdio:
    def __init__(self,command):
        self.process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        self.sequence=0
    def rpc(self,method,params=None,notify=False):
        self.sequence+=1;payload={'jsonrpc':'2.0','method':method}
        if params is not None:payload['params']=params
        if not notify:payload['id']=self.sequence
        self.process.stdin.write(json.dumps(payload)+'\n');self.process.stdin.flush()
        if notify:return None
        while True:
            line=self.process.stdout.readline()
            if not line:raise AssertionError('Stdio process ended before a response')
            data=json.loads(line) # Any startup/log text on stdout is a failure.
            if data.get('id')!=self.sequence:continue
            if 'error' in data:raise smoke.RpcError(method,data['error']['code'])
            return data['result']
    def listing(self,method,key):return self.rpc(method)[key]
    def close(self):
        self.process.terminate()
        try:self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=10)

def initialize(client):
    result=client.rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'dotnet-contract-probe','version':'1'}})
    assert result['serverInfo']['name']=='openehr-fhir-modeller-dotnet-dev'
    if hasattr(client,'protocol_version'):client.protocol_version=result['protocolVersion']
    client.rpc('notifications/initialized',notify=True)

def rejected(client,args):
    try:
        result=client.rpc('tools/call',{'name':'guide_get','arguments':args})
        assert result.get('isError') is True,'Invalid guide arguments succeeded'
    except smoke.RpcError as error:assert error.code==-32602

def verify(client,guides):
    initialize(client)
    tools=client.listing('tools/list','tools')
    assert tools==[json.loads((ROOT/'dotnet/contracts/guide_get.tool.json').read_text())],'Published tool metadata/schema drifted'
    templates=client.listing('resources/templates/list','resourceTemplates')
    assert templates==[json.loads((ROOT/'dotnet/contracts/guides.template.json').read_text())]
    actual={r['uri']:r for r in client.listing('resources/list','resources')}
    expected={}
    for file in sorted(guides.glob('*/*.md')):
        if file.is_symlink() or file.parent.is_symlink():continue
        category,name=file.parent.name,file.stem
        content=file.read_bytes()
        if not content.strip():continue
        uri=f'openehr://guides/{category}/{name}'
        for args in [{'uri':uri},{'category':category,'name':name}]:
            result=client.rpc('tools/call',{'name':'guide_get','arguments':args})
            assert not result.get('isError'),(uri,result)
            resource=result['content'][0]['resource']
            assert resource['uri']==uri and resource['mimeType']=='text/markdown'
            assert resource['text'].encode()==content,uri
        read=client.rpc('resources/read',{'uri':uri})['contents'][0]
        assert read['text'].encode()==content and read['uri']==uri
        if name=='README' or name.startswith('_'):continue
        expected[uri]=hashlib.sha256(content).hexdigest()
        assert actual[uri]['size']==len(content) and actual[uri]['mimeType']=='text/markdown'
    assert set(actual)==set(expected),'Resource enumeration changed'
    for args in [{},{'uri':'file:///etc/passwd'},{'category':'howto','name':'../../etc/passwd'},
                 {'uri':'openehr://guides/howto/%2e%2e%2fsecret'}, {'uri':'openehr://guides/howto/absent-guide'},
                 {'category':'howto','name':'linked-secret'},{'uri':'openehr://guides/howto/spec-lookup','unknown':True},
                 {'uri':None},{'name':False},{'category':'invalid','name':'spec-lookup'}]:rejected(client,args)
    try:client.rpc('tools/call',{'name':'model_artifact_save','arguments':{}});raise AssertionError('Unimplemented write was accepted')
    except smoke.RpcError as error:assert error.code==-32602
    return {'guides':len(expected),'contentSha256':hashlib.sha256(json.dumps(expected,sort_keys=True).encode()).hexdigest(),'contractParity':'PASS','traversalAndUnknownArguments':'PASS','unimplementedWritesRejected':'PASS'}

def http_status(url,headers,body=b'{}'):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers),timeout=15) as response:return response.status
    except urllib.error.HTTPError as error:return error.code

parser=argparse.ArgumentParser();parser.add_argument('--url');parser.add_argument('--guides',type=Path,default=ROOT/'resources/guides');parser.add_argument('--stdio',nargs=argparse.REMAINDER);args=parser.parse_args()
if args.stdio:
    client=Stdio(args.stdio)
    try:result=verify(client,args.guides)
    finally:client.close()
    print(json.dumps({'transport':'stdio',**result}))
else:
    assert args.url
    key=os.environ['AUTH_API_KEY'];headers={'X-API-Key':key,'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
    assert http_status(args.url,{})==401
    assert http_status(args.url,{**headers,'X-API-Key':'invalid'})==401
    assert http_status(args.url,{**headers,'Host':'attacker.invalid'})==400
    assert http_status(args.url,{**headers,'Origin':'https://attacker.invalid'})==403
    assert http_status(args.url,headers,b'x'*262145)==413
    result=verify(smoke.Client(args.url),args.guides)
    print(json.dumps({'transport':'http','authenticationAndRequestBounds':'PASS',**result}))
