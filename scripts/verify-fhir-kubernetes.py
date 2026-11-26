#!/usr/bin/env python3
"""Read-only verification on hygeoniq-prod; never print runtime credentials."""
import base64,json,os,subprocess,sys,time,urllib.request
from pathlib import Path
if subprocess.check_output(['hostname','-s'],text=True).strip()!='hygeoniq-prod':raise SystemExit('Wrong production host')
images=json.loads(Path(sys.argv[1]).read_text())
namespace='openehr-fhir-modeller'
expected={'app':{'app':images['app'],'engine':images['engine']},'chat':{'chat':images['chat']},'ingress':{'ingress':images['ingress']},'fhir':{'fhir':images['fhir']}}
for attempt in range(120):
    workloads=json.loads(subprocess.check_output(['kubectl','-n',namespace,'get','deploy','-o','json']))
    actual={d['metadata']['name']:{c['name']:c['image'] for c in d['spec']['template']['spec']['containers']} for d in workloads['items']}
    if actual==expected:break
    time.sleep(5)
else:raise SystemExit('Argo CD did not reconcile expected image digests')
for deployment in expected:subprocess.run(['kubectl','-n',namespace,'rollout','status','deployment/'+deployment,'--timeout=300s'],check=True)
# Check running images as well as desired Deployment templates.
pods=json.loads(subprocess.check_output(['kubectl','-n',namespace,'get','pods','-o','json']))
for name,containers in expected.items():
    candidates=[p for p in pods['items'] if p['metadata'].get('labels',{}).get('app.kubernetes.io/name')=='openehr-fhir-modeller-'+name and not p['metadata'].get('deletionTimestamp')]
    if len(candidates)!=1:raise SystemExit('Expected one current '+name+' pod')
    status={c['name']:c for c in candidates[0]['status'].get('containerStatuses',[])}
    if not all(status.get(c,{}).get('ready') and status[c]['image'].endswith(image.split('@')[1]) for c,image in containers.items()):raise SystemExit('Running image/readiness mismatch')
url='https://openehr-fhir-modeller.sandbox.hygeoniq.com'
with urllib.request.urlopen(url+'/ready',timeout=30) as response:readiness=json.load(response)
if readiness.get('status')!='ready':raise SystemExit('Public readiness failed')
secret=json.loads(subprocess.check_output(['kubectl','-n',namespace,'get','secret','app-runtime','-o','json']))['data']
for key in ('AUTH_API_KEY','AUTH_API_KEY_HEADER','MCP_SERVER_NAME'):
    if key in secret:os.environ[key]=base64.b64decode(secret[key]).decode()
subprocess.run(['python3',str(Path(__file__).with_name('mcp-smoke.py')),'--fhir','--openehr-engine','--url',url+'/mcp','--evidence',str(Path(sys.argv[1]).with_name('mcp-smoke.json'))],check=True)
print(json.dumps({'host':'hygeoniq-prod','publicUrl':url,'images':images,'readiness':readiness,'status':'verified'}))
