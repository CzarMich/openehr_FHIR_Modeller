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
assert.equal(health.enabled, false); assert.equal(health.review_enabled, true);
const status = (path) => new Promise((resolve, reject) => {
  http.get({ hostname: '127.0.0.1', port: 8350, path, headers: { Host: 'browser.fixture' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
});
assert.equal(await status('/chat/reviews'), 302);
assert.equal(await status('/'), 200);
assert.equal(await status('/chat/workspace.js'), 200);
assert.equal(await status('/chat/api/models/projects'), 401);
assert.equal(await status('/chat/api/reviews?project=default'), 401);
console.log('PASS: provider-independent review workspace starts without model runtime or account and rejects unauthenticated review access.');
JS
