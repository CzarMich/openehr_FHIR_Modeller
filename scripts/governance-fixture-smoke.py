#!/usr/bin/env python3
"""Independent purpose-bound assertion client against an isolated production container.
Only synthetic fixture identities/keys are used. No human production approval is attempted.
"""
import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location('mcp_smoke', Path(__file__).with_name('mcp-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--state', type=Path, required=True)
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--resume', action='store_true')
args = parser.parse_args()
base = args.url.rstrip('/')
os.environ['AUTH_API_KEY'] = 'z' * 64
checks = []

def record(name):
    checks.append({'check': name, 'status': 'PASS'})
    print('PASS ' + name, flush=True)

def token(method, target, raw, changes=None, secret='a' * 64):
    now = int(time.time())
    claims = dict(iss='https://browser.fixture', aud='openehr-modelling-review', identity_issuer='https://identity.fixture',
                  sub='synthetic-reviewer', tenant='https://identity.fixture', roles=['modelling-reviewer', 'modelling-approver'],
                  iat=now, exp=now + 60, session_started=now, jti=secrets.token_hex(32), method=method, target=target,
                  body_sha256=hashlib.sha256(raw).hexdigest())
    claims.update(changes or {})
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).rstrip(b'=').decode()
    signing = encode(dict(alg='HS256', typ='openehr-review+jwt', kid='active')) + '.' + encode(claims)
    return signing + '.' + base64.urlsafe_b64encode(hmac.new(secret.encode(), signing.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()

def request(method, target, data=None, changes=None, signed=None, extra=None):
    raw = b'' if data is None else json.dumps(data, separators=(',', ':')).encode()
    signed = signed or token(method, target, raw, changes)
    headers = {'Authorization': 'Bearer ' + signed, 'Content-Type': 'application/json'}
    headers.update(extra or {})
    req = urllib.request.Request(base + target, data=raw if method == 'POST' else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response: return response.status, json.load(response), signed
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), signed

if args.resume:
    state = json.loads(args.state.read_text())
    status, view, _ = request('GET', state['target'])
    assert status == 200 and view['state'] == 'REVIEWED' and len(view['events']) == 4
    assert view['events'][-1]['hash'] == state['event_hash']
    record('audit history and actor evidence survive process restart')
    evidence = json.loads(args.evidence.read_text())
    evidence['checks'].extend(checks)
    args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
else:
    client = module.Client(base + '/mcp')
    client.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'governance-fixture', 'version': '1'}})
    client.rpc('notifications/initialized', notify=True)
    project = 'review-' + secrets.token_hex(6)
    client.tool('model_project_create', {'id': project, 'name': 'Synthetic review', 'description': 'Contract test only'})
    source = client.tool('model_artifact_save', {'project': project, 'path': 'templates/fixture.oet', 'content': '<template xmlns="openEHR/v1/Template"><id>fixture</id><name>Fixture</name><definition/></template>'})
    view = client.tool('governance_prepare', dict(project=project, path=source['path'], modelRevision=source['revision'], comment='Synthetic review fixture.'))
    view = client.tool('governance_validate', dict(subject=view['subject'], expectedSequence=view['sequence']))
    view = client.tool('governance_request_review', dict(subject=view['subject'], expectedSequence=view['sequence'], comment='Review with known unexecuted validation stages.'))
    assert view['state'] == 'REVIEW_REQUESTED' and not view['clinical_approval']
    names = {item['name'] for item in client.listing('tools/list', 'tools')}
    assert 'governance_approve' not in names and 'governance_publish' not in names
    record('MCP prepares review but exposes no clinical approval tool')
    target = '/api/v1/reviews/' + view['subject']
    status, read, _ = request('GET', target)
    assert status == 200 and read['source']['sha256'] == source['sha256'] and read['content'] == source['content']
    assert read['validation']['release_eligible'] is False and 'APPROVED' not in read['available_transitions']
    record('interactive route exposes exact source and incomplete validation')
    data = dict(state='REVIEWED', expectedSequence=view['sequence'], comment='Synthetic independent human review.', validationDigest=view['validation_digest'])
    for label, changes in [('wrong audience', {'aud': 'modelling-api'}), ('expired assertion', {'exp': int(time.time()) - 1}),
                           ('wrong body binding', {'body_sha256': '0' * 64}), ('wrong tenant', {'tenant': 'another'})]:
        assert request('POST', target + '/transitions', data, changes=changes)[0] == 401
        record(label + ' rejected')
    status, error, _ = request('GET', target, changes={'roles': ['administrator']})
    assert status == 403 and error['error']['code'] == 'GOVERNANCE_ROLE_REQUIRED'
    record('authenticated account without platform role receives a permission error')
    owner = {'roles': ['modelling-administrator'], 'session_started': int(time.time()) - 1800}
    assert request('GET', target, changes=owner)[0] == 200
    assert request('POST', target + '/transitions', data, changes=owner)[0] == 401
    assert request('GET', target, changes=dict(owner, session_started=int(time.time()) - 3601))[0] == 401
    record('platform owner browses with the chat session; stale decisions and expired sessions remain rejected')
    assert request('POST', target + '/transitions', data, extra={'Authorization': '', 'X-API-Key': 'z' * 64})[0] == 401
    record('ordinary model API key cannot attest an interactive human')
    status, reviewed, signed = request('POST', target + '/transitions', data)
    assert status == 200 and reviewed['state'] == 'REVIEWED' and reviewed['events'][-1]['actor']['human'] is True
    assert reviewed['events'][-1]['actor']['method'] == 'interactive_oidc'
    assert request('POST', target + '/transitions', data, signed=signed)[0] == 401
    assert request('POST', target + '/transitions', data)[0] == 409
    record('human review is recorded once; replay and stale sequence rejected')
    approval = dict(data, state='APPROVED', expectedSequence=reviewed['sequence'])
    status, error, _ = request('POST', target + '/transitions', approval)
    assert status == 403 and error['error']['code'] == 'GOVERNANCE_VALIDATION_REQUIRED'
    record('unexecuted conformance checks prevent approval even for an interactive approver')
    evidence = {'status': 'PASS', 'fixture': 'isolated production HTTP containers; synthetic identities only', 'checks': checks,
                'clinical_approval': False, 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
    args.state.write_text(json.dumps({'target': target, 'event_hash': reviewed['events'][-1]['hash']}))
