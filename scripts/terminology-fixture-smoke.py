#!/usr/bin/env python3
"""Exercise synthetic FHIR operation contracts through the actual MCP HTTP adapter."""
import argparse
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('mcp_smoke', Path(__file__).with_name('mcp-smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
client, checks = module.Client(args.url), []
client.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'terminology-contract', 'version': '1'}})
client.rpc('notifications/initialized', notify=True)
system, value_set, concept_map = 'https://example.org/cs', 'https://example.org/vs', 'https://example.org/map'
assert client.tool('terminology_capabilities')['status'] == 'VALIDATED'
lookup = client.tool('terminology_lookup', {'system': system, 'code': 'x', 'version': 'cs-7', 'language': 'de'})
assert lookup['version_confirmed'] and len(lookup['result']['designation']) == 2
checks.append('lookup retains repeated multilingual designations')
assert client.tool('terminology_validate_code', {'system': system, 'code': 'x'})['valid'] is True
assert client.tool('terminology_validate_code', {'system': system, 'code': 'invented'})['valid'] is False
valid = client.tool('terminology_validate_code', {'system': system, 'code': 'x', 'valueSet': value_set, 'version': 'vs-3', 'codeSystemVersion': 'cs-7'})
assert valid['valid'] and all(v['confirmed'] for v in valid['versions'].values())
checks.append('positive and negative membership with independent versions')
expanded = client.tool('terminology_expand', {'valueSet': value_set, 'version': 'vs-3', 'count': 1})
assert expanded['page']['complete'] and expanded['version_confirmed']
size = client.tool('terminology_expand', {'valueSet': value_set, 'count': 0})
assert size['page']['total'] == 1 and not size['page']['complete']
checks.append('bounded expansion and size-only request')
translated = client.tool('terminology_translate', {'conceptMap': concept_map, 'system': system, 'code': 'x', 'version': 'map-2', 'codeSystemVersion': 'cs-7'})
assert translated['mapping_found'] and translated['requires_review'] and not translated['applied']
assert translated['valid'] is None and not translated['version_confirmed']
checks.append('ConceptMap candidates require review and retain unconfirmed version evidence')
for kind, canonical, version in [('CodeSystem', system, 'cs-7'), ('ValueSet', value_set, 'vs-3'), ('ConceptMap', concept_map, 'map-2')]:
    found = client.tool('terminology_resource_search', {'resourceType': kind})
    assert found['complete'] and len(found['items']) == 1
    fetched = client.tool('terminology_resource_get', {'resourceType': kind, 'canonical': canonical, 'version': version})
    assert fetched['version_confirmed'] and fetched['result']['url'] == canonical
checks.append('canonical discovery and exact resource resolution')
args.evidence.parent.mkdir(parents=True, exist_ok=True)
args.evidence.write_text(json.dumps({'status': 'PASS', 'scope': 'isolated synthetic HTTPS FHIR fixture through production MCP container', 'checks': checks}, indent=2) + '\n')
for check in checks:
    print('PASS ' + check, flush=True)
