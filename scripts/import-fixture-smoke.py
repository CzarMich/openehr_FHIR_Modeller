#!/usr/bin/env python3
"""Manual file import via actual MCP. Writes only with explicit isolated-fixture flag."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location('mcp_smoke', Path(__file__).with_name('mcp-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--catalogue', type=Path)
parser.add_argument('--writes', action='store_true', help='Create synthetic originals only in an isolated fixture deployment')
args = parser.parse_args()
os.environ.setdefault('AUTH_API_KEY', 'z' * 64)
client = module.Client(args.url)
client.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'import-fixture', 'version': '1'}})
client.rpc('notifications/initialized', notify=True)
catalogue = client.listing('tools/list', 'tools')
if args.catalogue:
    args.catalogue.write_text(json.dumps(catalogue, indent=2) + '\n')
assert {'model_import_inspect', 'model_artifact_import', 'model_artifact_provenance'} <= {t['name'] for t in catalogue}
checks = []


def record(message):
    checks.append(message)
    print('PASS ' + message, flush=True)


original = b'\xef\xbb\xbf{"nativeUnknownField": [1, 2]}\r\n'
params = {'filename': 'Synthetic Source.t.json', 'contentBase64': base64.b64encode(original).decode(), 'declaredType': 'DESIGNER_AUTHORING_JSON'}
inspection = client.tool('model_import_inspect', params)
assert inspection['detected_type'] == 'UNKNOWN' and inspection['effective_type'] == 'DESIGNER_AUTHORING_JSON'
assert inspection['classification_basis'] == 'CALLER_DECLARED' and not inspection['source_system_verified']
assert inspection['conformance'] == 'NOT_EXECUTED' and inspection['source_sha256'] == hashlib.sha256(original).hexdigest()
for invalid in [dict(params, filename='../bad.json'), dict(params, contentBase64='YR=='), dict(params, declaredType='MADE_UP')]:
    client.tool('model_import_inspect', invalid, error=True)
record('Actual MCP classification preserves source hash; proprietary format is declared, not converted or certified')
unsafe = b'<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///etc/passwd">]><x>&ex;</x>'
result = client.tool('model_import_inspect', {'filename': 'unsafe.xml', 'contentBase64': base64.b64encode(unsafe).decode()})
assert result['syntax'] == 'FAIL' and result['source_sha256'] == hashlib.sha256(unsafe).hexdigest()
record('Traversal, malformed byte envelopes and unknown declarations rejected; unsafe XML flagged without entity expansion')
if args.writes:
    client.tool('model_project_create', {'id': 'import-fixture', 'name': 'Synthetic original preservation'})
    for index, (bytes_, name, type_) in enumerate([(original, params['filename'], params['declaredType']), (b'PK\x00\xff', 'Synthetic.zip', 'MODEL_PACKAGE'), (unsafe, 'unsafe.xml', 'UNKNOWN')]):
        request = {'project': 'import-fixture', 'filename': name, 'contentBase64': base64.b64encode(bytes_).decode(), 'declaredType': type_}
        imported = client.tool('model_artifact_import', request)
        assert imported['status'] == 'STORED_UNREVIEWED' and not imported['clinical_approval'] and not imported['importing_actor']['human']
        assert imported['source_claims']['source_system'] == 'UNKNOWN' and len(imported['events']) == 2
        assert imported == client.tool('model_artifact_import', request)
        assert imported == client.tool('model_artifact_provenance', {'project': 'import-fixture', 'importId': imported['import_id']})
        stored = client.tool('model_artifact_get', {'project': 'import-fixture', 'path': imported['original']['path']})
        roundtrip = stored['content'].encode() if stored['content_encoding'] == 'utf8' else base64.b64decode(stored['content_base64'])
        assert roundtrip == bytes_ and stored['sha256'] == hashlib.sha256(bytes_).hexdigest()
        client.tool('model_artifact_save', {'project': 'import-fixture', 'path': stored['path'], 'content': 'changed', 'expectedRevision': stored['revision']}, error=True)
        client.tool('governance_get', {'subject': imported['import_id']}, error=True)
        if stored['content_encoding'] == 'base64':
            for tool in ['model_project_qa', 'model_terminology_inspect']:
                failure = client.tool(tool, {'project': 'import-fixture', 'path': stored['path']}, error=True)
                assert failure['structuredContent']['error']['code'] == 'MODEL_TEXT_FORMAT_REQUIRED'

    assert client.tool('governance_list', {'project': 'import-fixture'})['items'] == []
    record('Text/BOM/CRLF, binary and unsafe originals preserved exactly; protected receipts are idempotent and separate from model governance')
    record('Original overwrite and import-as-approval rejected through actual MCP')
args.evidence.write_text(json.dumps({'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'status': 'PASS',
    'writes': args.writes, 'checks': checks, 'clinical_approval': False, 'external_tool_round_trip': 'NOT_EXECUTED'}, indent=2) + '\n')
