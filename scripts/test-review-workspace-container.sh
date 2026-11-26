#!/usr/bin/env bash
# Verify the default browser image starts with no model-provider account/runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
image=openehr-modelling-reviews-fixture:local
name="modelling-reviews-fixture-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker build -f chat/Dockerfile --target reviews -t "$image" .
docker run -d --name "$name" --read-only --tmpfs /data/chat:uid=1000,gid=1000,mode=0700 --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  -e CHAT_ENABLED=false -e CHAT_REVIEW_ENABLED=true -e CHAT_PUBLIC_URL=https://browser.fixture \
  -e CHAT_INTEGRATION_ENABLED=true -e CHAT_MCP_API_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  -e CHAT_OIDC_ISSUER=https://identity.fixture -e CHAT_OIDC_CLIENT_ID=review-fixture \
  -e CHAT_OIDC_CLIENT_SECRET=synthetic-fixture-only \
  -e CHAT_REVIEW_SIGNING_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$image" >/dev/null
for attempt in {1..20}; do
  if docker exec "$name" node -e "fetch('http://127.0.0.1:8350/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
assert.equal(spawnSync('codex', ['--version']).error?.code, 'ENOENT');
assert.equal(existsSync('/home/node/.codex/auth.json'), false);
const response = await fetch('http://127.0.0.1:8350/health');
const health = await response.json();
assert.equal(health.enabled, false); assert.equal(health.review_enabled, true); assert.equal(health.integration_ready, true);
const status = (path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port: 8350, path, headers: { Host: 'browser.fixture' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
});
assert.equal(await status('/chat/reviews'), 302);
assert.equal(await status('/'), 200);
assert.equal(await status('/chat/workspace.js'), 200);
assert.equal(await status('/chat/api/models/projects'), 401);
assert.equal(await status('/chat/api/reviews?project=default'), 401);
assert.equal(await status('/chat/integration/'), 200);
assert.equal(await status('/chat/api/integration/connections'), 401);
assert.equal(spawnSync('/app/integration/worker/Modeller.Processing', []).stderr.toString().trim(), 'USAGE_REQUIRED');
async function rpc(body, session, authenticated = true) {
  return await new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    const request = http.request({ hostname:'127.0.0.1', port:8350, path:'/chat/integration/mcp', method:'POST', headers:{Host:'browser.fixture','Content-Type':'application/json',Accept:'application/json, text/event-stream','Content-Length':Buffer.byteLength(bytes), ...(authenticated?{'X-API-Key':'b'.repeat(64)}:{}), ...(session?{'Mcp-Session-Id':session,'MCP-Protocol-Version':'2025-06-18'}:{})}}, response=>{
      let text=''; response.on('data',chunk=>text+=chunk); response.on('end',()=>{const lines=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()); resolve({status:response.statusCode,session:response.headers['mcp-session-id'],result:text?(JSON.parse(lines.length?lines.at(-1):text)):null});});
    }); request.on('error',reject); request.end(bytes);
  });
}
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'packaged-csharp-check',version:'1'}}};
assert.equal((await rpc(initialize,null,false)).status,401);
const initialized=await rpc(initialize);assert.equal(initialized.status,200);
const tools=await rpc({jsonrpc:'2.0',id:2,method:'tools/list',params:{}},initialized.session);
assert.equal(tools.status,200);
for(const name of ['modelling_project','modelling_model','modelling_mapping','source_inspect','modelling_engine'])assert.ok(tools.result.result.tools.some(tool=>tool.name===name),name);
const help=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'modelling_mapping',arguments:{action:'help'}}},initialized.session);
assert.equal(help.status,200);assert.equal(help.result.result.structuredContent.result.example.schemaVersion,2);
console.log('PASS: packaged C# server/worker and authenticated public MCP proxy work without PHP or provider accounts.');
console.log('PASS: provider-independent review workspace starts without model runtime or account and rejects unauthenticated review access.');
JS
