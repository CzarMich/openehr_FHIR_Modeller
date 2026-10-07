#!/usr/bin/env python3
"""Exercise a running API-key deployment. Secrets are only read from environment."""
import json,os,sys,urllib.request,urllib.error
from pathlib import Path
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:18345/mcp'
key=os.environ['AUTH_API_KEY'];header=os.getenv('AUTH_API_KEY_HEADER','X-API-Key')
body=json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'security-smoke','version':'1'}}}).encode()
cases=[('missing key',{},body,401),('invalid key',{header:'incorrect'},body,401),('valid key',{header:key},body,200),('forbidden Host',{header:key,'Host':'evil.example'},body,403),('forbidden Origin',{header:key,'Origin':'https://evil.example'},body,403),('large request',{header:key},b'x'*(2097152+1),413)]
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl): return None
opener=urllib.request.build_opener(NoRedirect())
evidence=[]
for name,headers,payload,expected in cases:
 if name=='forbidden Host' and os.getenv('SECURITY_TEST_SHARED_PROXY')=='true':
  evidence.append({'check':name,'status':'SKIPPED','reason':'Shared proxy selects another virtual host; verify the application listener separately.'})
  print('SKIP forbidden Host at shared proxy');continue
 headers.update({'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
 try:
  with opener.open(urllib.request.Request(url,data=payload,headers=headers),timeout=30) as r:
   status=r.status;response=r.read(8*1024*1024)
 except urllib.error.HTTPError as exc:status=exc.code;response=exc.read()
 assert key.encode() not in response
 evidence.append({'check':name,'http_status':status,'expected':expected,'pass':status==expected})
 print(('PASS ' if status==expected else 'FAIL ')+name)
if len(sys.argv)>2:Path(sys.argv[2]).write_text(json.dumps(evidence,indent=2)+'\n')
sys.exit(0 if all(item.get('pass',item.get('status')=='SKIPPED') for item in evidence) else 1)
