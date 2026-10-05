#!/usr/bin/env python3
"""Read-only acceptance of this product's advertised MCP surface over HTTP or stdio.
No external service requests, stored writes, credentials in output or demo tools.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('mcp_smoke', Path(__file__).with_name('mcp-smoke.py'))
mcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mcp)
VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25']


class Stdio(mcp.Client):
    def __init__(self, command):
        super().__init__('stdio')
        self.stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, bufsize=0)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.pending = b''

    def rpc(self, method, params=None, notify=False):
        self.sequence += 1
        request = dict(jsonrpc='2.0', method=method)
        if params is not None:
            request['params'] = params
        if not notify:
            request['id'] = self.sequence
        self.process.stdin.write(json.dumps(request).encode() + b'\n')
        if notify:
            return {}
        deadline = time.monotonic() + 30
        while b'\n' not in self.pending:
            if not self.selector.select(max(0, deadline-time.monotonic())):
                raise RuntimeError('stdio response timeout')
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError('stdio exited before a response')
            self.pending += chunk
            if len(self.pending) > 16 * 1024 * 1024:
                raise RuntimeError('stdio response limit')
        line, self.pending = self.pending.split(b'\n', 1)
        result = json.loads(line)
        assert result.get('jsonrpc') == '2.0' and result.get('id') == self.sequence
        if 'error' in result:
            raise mcp.RpcError(method, result['error']['code'])
        return result['result']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.selector.close()
        self.stderr.close()


def error(client, method, params):
    try:
        result = client.rpc(method, params)
    except mcp.RpcError as exc:
        assert exc.code in [-32601, -32602, -32002], (method, exc.code)
        return
    assert method == 'tools/call' and result.get('isError') is True, method


def initialize(client, version):
    result = client.rpc('initialize', dict(protocolVersion=version, capabilities={},
                                         clientInfo=dict(name='product-protocol-acceptance', version='1')))
    assert result['protocolVersion'] == (version if version in VERSIONS else VERSIONS[-1])
    assert set(result['capabilities']) == {'tools', 'prompts', 'resources', 'logging', 'completions'}
    assert not result['capabilities']['resources'].get('subscribe', False)
    assert not any(c.get('listChanged', False) for c in result['capabilities'].values())
    assert result['instructions'] and result['serverInfo']['name']
    client.rpc('notifications/initialized', notify=True)
    assert client.rpc('ping') == {}
    return result


def surface(client, record):
    initialize(client, '2025-11-25')
    record('initialize, advertised capabilities and ping')
    tools = client.listing('tools/list', 'tools')
    first_page = client.rpc('tools/list', {})
    assert not first_page.get('nextCursor') and len(first_page['tools']) == len(tools), 'Keep every tool discoverable by single-page clients'
    assert len(tools) == len({t['name'] for t in tools}) and len(tools) >= 63
    assert all(t['inputSchema'].get('additionalProperties') is False for t in tools)
    assert all('annotations' in t for t in tools), 'Tool side-effect annotations missing'
    assert all(t['outputSchema'].get('type') == 'object' for t in tools if 'outputSchema' in t)
    resources = client.listing('resources/list', 'resources')
    assert len(resources) == len({r['uri'] for r in resources})
    for resource in resources:
        result = client.rpc('resources/read', {'uri': resource['uri']})
        assert result['contents'] and all(c.get('uri') and ('text' in c or 'blob' in c) for c in result['contents'])
    templates = client.listing('resources/templates/list', 'resourceTemplates')
    assert len(templates) == 3
    for uri in ['openehr://guides/howto/spec-lookup', 'openehr://spec/type/RM/DV_TEXT']:
        assert client.rpc('resources/read', {'uri': uri})['contents']
    record('paginated discovery and every bundled resource', {'tools':len(tools), 'resources':len(resources), 'templates':len(templates)})
    prompts = client.listing('prompts/list', 'prompts')
    for prompt in prompts:
        values = {'task_type':'design','format_variant':'flat','rm_type':'OBSERVATION',
                  'root_archetype':'openEHR-EHR-COMPOSITION.encounter.v1'}
        args = {a['name']:values.get(a['name'],'synthetic example') for a in prompt.get('arguments', []) if a.get('required')}
        messages = client.rpc('prompts/get', {'name':prompt['name'], 'arguments':args})['messages']
        assert messages and all(m['role'] in ['user','assistant'] and m.get('content') for m in messages)
    record('every advertised prompt', {'prompts':len(prompts)})
    for uri, name, prefix, expected in [('openehr://guides/{category}/{name}','category','a','archetypes'),
                                       ('openehr://guides/{category}/{name}','name','spec-','spec-lookup'),
                                       ('openehr://spec/type/{component}/{name}','component','R','RM')]:
        result = client.rpc('completion/complete', {'ref':{'type':'ref/resource','uri':uri},'argument':{'name':name,'value':prefix}})['completion']
        assert expected in result['values'] and len(result['values']) <= 100
    record('resource template argument completion')
    assert client.rpc('logging/setLevel', {'level':'warning'}) == {}
    result = client.rpc('tools/call', {'name':'ckm_sources','arguments':{}})
    assert not result.get('isError') and result['content']
    assert isinstance(result.get('structuredContent'), dict)
    record('logging level, text and structured tool result')
    for method, params in [('unknown/method',{}), ('tools/call',{'name':'unknown_tool','arguments':{}}),
        ('tools/call',{'name':'guide_get','arguments':{'category':'howto'}}),
        ('tools/call',{'name':'guide_get','arguments':{'category':'howto','name':'missing'}}),
        ('tools/call',{'name':'model_validate','arguments':{'content':'<a/>','format':'xml','extra':True}}),
        ('resources/read',{'uri':'openehr://guides/../../etc/passwd'}),
        ('prompts/get',{'name':'missing_prompt','arguments':{}}),
        ('completion/complete',{'ref':{'type':'ref/resource','uri':'openehr://missing'},'argument':{'name':'x','value':''}})]:
        error(client, method, params)
    record('unknown methods, invalid arguments, missing resources and traversal rejected')


def http_boundary(client, record, allowed_origin):
    def request(body=b'', method='POST', extra=None, session=True):
        headers = dict(client.headers)
        if session:
            headers.update({'Mcp-Session-Id':client.session, 'MCP-Protocol-Version':client.protocol_version})
        headers.update(extra or {})
        try:
            response = client.opener.open(urllib.request.Request(client.url, data=body if method == 'POST' else None,
                                                                headers=headers, method=method), timeout=15)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, dict(response.headers), response.read(16*1024*1024)
    ping = json.dumps(dict(jsonrpc='2.0',id='boundary',method='ping')).encode()
    for name, body, headers, expected in [
        ('invalid version',ping,{'MCP-Protocol-Version':'not-supported'},400),
        ('invalid origin',ping,{'Origin':'https://untrusted.invalid'},403),
        ('invalid host',ping,{'Host':'untrusted.invalid'},403),
        ('invalid session',ping,{'Mcp-Session-Id':'not-a-session'},400),
        ('unknown session',ping,{'Mcp-Session-Id':'00000000-0000-4000-8000-000000000001'},404),
        ('request bound',b'x'*(2097152+1),{},413)]:
        status, _, _ = request(body, extra=headers)
        assert status == expected, (name, status)
    status, _, body = request(b'{')
    assert json.loads(body)['error']['code'] == -32700
    notification = json.dumps(dict(jsonrpc='2.0',method='notifications/cancelled',params={'requestId':'not-running'})).encode()
    status, _, body = request(notification)
    assert status == 202 and body == b''
    status, headers, _ = request(method='GET', extra={'Accept':'text/event-stream'})
    assert status == 405, 'This deployment advertises no independent SSE stream'
    if allowed_origin:
        status, headers, _ = request(ping, extra={'Origin':allowed_origin})
        assert status == 200 and headers.get('Access-Control-Allow-Origin') == allowed_origin
        status, headers, _ = request(method='OPTIONS', extra={'Origin':allowed_origin,'Access-Control-Request-Method':'POST'},session=False)
        assert status == 204 and headers.get('Access-Control-Allow-Origin') == allowed_origin
    status, _, _ = request(method='DELETE')
    assert status == 200
    status, _, _ = request(ping)
    assert status == 404
    record('HTTP security, finite bodies, notifications, stream policy and session termination')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url')
    parser.add_argument('--allowed-origin')
    parser.add_argument('--evidence',type=Path,required=True)
    parser.add_argument('command',nargs=argparse.REMAINDER)
    args = parser.parse_args()
    checks = []
    def record(check, detail=None):
        checks.append(dict(check=check,status='PASS',detail=detail))
        print('PASS ' + check,flush=True)
    client = None
    try:
        if args.url:
            for version in [*VERSIONS, '2099-01-01']:
                initialize(mcp.Client(args.url), version)
            record('supported and future-version negotiation')
            client = mcp.Client(args.url)
        else:
            command = args.command[1:] if args.command[:1] == ['--'] else args.command
            assert command, 'Supply --url or a stdio command after --'
            client = Stdio(command)
        surface(client, record)
        if args.url:
            http_boundary(client,record,args.allowed_origin)
    except Exception as exc:
        checks.append(dict(check='acceptance stopped',status='FAIL',detail=str(exc)))
        print('FAIL '+str(exc),file=sys.stderr)
        return 1
    finally:
        if isinstance(client, Stdio):
            client.close()
        args.evidence.parent.mkdir(parents=True,exist_ok=True)
        args.evidence.write_text(json.dumps(dict(timestamp=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
            transport='http' if args.url else 'stdio',scope='Advertised product protocol; no clinical model writes or external service calls',checks=checks),indent=2)+'\n')
    return 0

if __name__ == '__main__':
    sys.exit(main())
