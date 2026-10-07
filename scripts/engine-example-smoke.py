#!/usr/bin/env python3
"""Compile the repository's existing openEHR model examples over real MCP; no clinical data or writes."""
import argparse
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
args = parser.parse_args()
os.environ.setdefault('AUTH_API_KEY', 'a' * 64)
client = module.Client(args.url)
client.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'native-model-examples', 'version': '1'}})
client.rpc('notifications/initialized', notify=True)
root = Path(__file__).resolve().parent.parent / 'resources/examples/archetypes'
checks = []
sources = {}
for path in sorted(root.glob('*.adl')):
    # This example has required unfilled slots. It is a negative dependency case below.
    if 'translation_requirements' in path.name:
        continue
    content = path.read_bytes().decode('utf-8')
    identifier = path.stem
    kind = identifier.split('-')[2].split('.')[0]
    oet = f'<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id>synthetic-{kind.lower()}-probe</id><name>Synthetic {kind} compiler probe</name><definition xsi:type="{kind}" archetype_id="{identifier}"/></template>'
    result = client.tool('template_compile', {'content': oet, 'dependencies': [{'identifier': identifier, 'content': content}]})
    assert result['valid'] and result['output']['format'] == 'opt14_xml'
    assert result['checks']['full_aom_semantics'] == 'NOT_EXECUTED' and not result['clinical_approval']
    assert result['dependencies'][0]['sha256'] == hashlib.sha256(content.encode()).hexdigest()
    output = result['output']
    assert output['sha256'] == hashlib.sha256(output['content'].encode()).hexdigest()
    assert client.tool('opt_validate', {'content': output['content']})['valid']
    checks.append({'fixture': str(path.relative_to(root.parent.parent.parent)), 'source_sha256': hashlib.sha256(content.encode()).hexdigest(), 'opt_sha256': output['sha256'], 'status': 'PASS'})
    sources[identifier] = content
    print(f'PASS original {kind} example compiled and independently revalidated', flush=True)

encounter = 'openEHR-EHR-COMPOSITION.encounter.v1'
pressure = 'openEHR-EHR-OBSERVATION.blood_pressure.v2'
template = f'<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id>synthetic-composed-probe</id><name>Synthetic encounter with observation</name><definition xsi:type="COMPOSITION" archetype_id="{encounter}"><Content xsi:type="OBSERVATION" archetype_id="{pressure}" path="/content" min="1" max="1"/></definition></template>'
dependencies = [{'identifier': identifier, 'content': sources[identifier]} for identifier in [encounter, pressure]]
result = client.tool('template_compile', {'content': template, 'dependencies': dependencies})
assert result['valid'] and result['checks']['full_aom_semantics'] == 'NOT_EXECUTED'
actions = {item['code'] for item in result['compilation_actions']}
assert {'ADL14_INTERNAL_REFERENCE_EXPANDED', 'RM_UNCONSTRAINED_ATTRIBUTE_NARROWED'} <= actions
assert client.tool('template_compile', {'content': template, 'dependencies': list(reversed(dependencies))})['output'] == result['output']
assert client.tool('opt_validate', {'content': result['output']['content']})['valid']
checks.append({'fixture': 'Synthetic OET composing original Encounter and Blood Pressure archetypes', 'opt_sha256': result['output']['sha256'], 'status': 'PASS'})
print('PASS original Encounter and Blood Pressure composed with preserved internal references and deterministic OPT XML', flush=True)

required = root / 'openEHR-EHR-ADMIN_ENTRY.translation_requirements.v1.adl'
template = f'<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id>synthetic-missing-dependency</id><name>Synthetic negative dependency test</name><definition xsi:type="ADMIN_ENTRY" archetype_id="{required.stem}"/></template>'
result = client.tool('template_compile', {'content': template, 'dependencies': [{'identifier': required.stem, 'content': required.read_bytes().decode('utf-8')}]}, error=True)
code = result['structuredContent']['error']['code']
assert code == 'ENGINE_REQUIRED_SLOT_UNFILLED'
checks.append({'fixture': str(required.relative_to(root.parent.parent.parent)), 'status': 'EXPECTED_REJECTION', 'code': code})
print('PASS required unfilled slot remains a compilation error', flush=True)
args.evidence.write_text(json.dumps({'status': 'PASS', 'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checks': checks,
    'scope': 'Existing repository examples and synthetic OET assembly; OPT XML schema/RM profile, not full AOM semantics, Designer interoperability or clinical qualification.',
    'clinical_approval': False, 'repository_writes': False}, indent=2) + '\n')
