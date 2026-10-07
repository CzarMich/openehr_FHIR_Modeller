"""Actual MCP-to-native-engine acceptance, offline and without a terminology server/CDR."""
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
parser.add_argument('--writes', action='store_true', help='Create only the synthetic engine-fixture project in an isolated test repository')
args = parser.parse_args()
os.environ.setdefault('AUTH_API_KEY', 'a' * 64)
client = module.Client(args.url)
client.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'native-engine-fixture', 'version': '1'}})
client.rpc('notifications/initialized', notify=True)
fixtures = Path(__file__).resolve().parent.parent / 'engine/src/test/resources'
cluster = (fixtures / 'cluster.adls').read_text()
template = (fixtures / 'template.adlt').read_text()
dependencies = [{'identifier': 'openEHR-EHR-COMPOSITION.engine_fixture.v1.0.0', 'content': (fixtures / 'composition.adls').read_text()}]
checks = []
def record(name):
    checks.append(name)
    print('PASS ' + name, flush=True)

catalogue = client.listing('tools/list', 'tools')
if args.catalogue:
    args.catalogue.write_text(json.dumps(catalogue, indent=2) + '\n')
names = {t['name'] for t in catalogue}
assert {'archetype_validate', 'template_validate', 'template_compile', 'opt_validate', 'model_inspect', 'aql_validate'} <= names
record('Native operation schemas discovered through actual MCP')
result = client.tool('archetype_validate', {'content': cluster})
assert result['valid'] and result['content_sha256'] == hashlib.sha256(cluster.encode()).hexdigest()
assert result['engine']['archie'] == '3.20.0' and not result['clinical_approval']
record('Native ADL 2 AOM/RM validation and exact source hash')
for content in ['not an archetype', cluster.replace('DV_TEXT[id3]', 'DV_IMAGINARY[id3]'), cluster.replace('{1..1}', '{4..1}')]:
    result = client.tool('archetype_validate', {'content': content})
    assert not result['valid'] and result['findings']
record('Malformed ADL, unknown RM types and invalid intervals rejected')
assert client.tool('template_validate', {'content': template, 'dependencies': dependencies})['valid']
assert not client.tool('template_compile', {'content': template})['valid']
result = client.tool('template_compile', {'content': template, 'dependencies': dependencies})
assert result['valid'] and result['output']['format'] == 'opt2_adl'
opt = result['output']['content']
assert hashlib.sha256(opt.encode()).hexdigest() == result['output']['sha256']
assert client.tool('template_compile', {'content': template, 'dependencies': dependencies})['output'] == result['output']
assert client.tool('opt_validate', {'content': opt})['valid']
record('Pinned ADL 2 template compilation, output validation and byte-identical rebuild')
if args.writes:
    client.tool('model_project_create', {'id': 'engine-fixture', 'name': 'Synthetic compiler acceptance'})
    source = client.tool('model_artifact_save', {'project': 'engine-fixture', 'path': 'templates/fixture.adlt', 'content': template})
    dep = client.tool('model_artifact_save', {'project': 'engine-fixture', 'path': 'archetypes/root.adls', 'content': dependencies[0]['content']})
    args_build = {'project': 'engine-fixture', 'path': source['path'], 'revision': source['revision'],
        'dependencies': [{'identifier': dependencies[0]['identifier'], 'path': dep['path'], 'revision': dep['revision']}]}
    build = client.tool('template_compile_project', args_build)
    assert build['saved'] and not build['clinical_approval']
    assert client.tool('template_compile_project', args_build)['artifact']['revision'] == build['artifact']['revision']
    saved = client.tool('model_artifact_get', {'project': 'engine-fixture', **{k: build['artifact'][k] for k in ['path', 'revision']}})
    assert saved['content'] == opt and saved['status'] == 'DRAFT'
    assert saved['metadata']['build']['source']['revision'] == source['revision']
    assert saved['metadata']['build']['dependencies'][0]['sha256'] == dep['sha256']
    record('Native OPT and exact-revision source/dependency/compiler evidence saved atomically as DRAFT; retry preserves build revision')
inspection = client.tool('model_inspect', {'content': cluster, 'format': 'adl2'})['inspection']
assert any(node['path'] == '/items[id2]/value[id3]' and node['rm_type'] == 'DV_TEXT' for node in inspection['paths'])
record('Actual model paths, RM types and terminology inspected')
legacy = (fixtures / 'legacy/nested.oet').read_text()
legacy_dependencies = [{'identifier': f'openEHR-EHR-{kind.upper()}.engine_fixture.v1',
    'content': (fixtures / f'legacy/{kind}.adl').read_text()} for kind in ['composition', 'section', 'evaluation', 'cluster']]
legacy_result = client.tool('template_compile', {'content': legacy, 'dependencies': legacy_dependencies})
assert legacy_result['valid'] and legacy_result['profile'] == 'OET14_COMPILATION_RM_STRUCTURE'
assert legacy_result['checks']['full_aom_semantics'] == 'NOT_EXECUTED' and not legacy_result['clinical_approval']
legacy_output = legacy_result['output']
assert legacy_output['format'] == 'opt14_xml' and legacy_output['sha256'] == hashlib.sha256(legacy_output['content'].encode()).hexdigest()
assert 'Textelement' in legacy_output['content'] and 'Synthetic annotation' in legacy_output['content']
assert client.tool('template_compile', {'content': legacy, 'dependencies': list(reversed(legacy_dependencies))})['output'] == legacy_output
assert client.tool('template_validate', {'content': legacy, 'dependencies': legacy_dependencies})['valid']
assert client.tool('opt_validate', {'content': legacy_output['content']})['profile'] == 'OPT14_XML_RM_STRUCTURE'
legacy_inspection = client.tool('model_inspect', {'content': legacy_output['content'], 'format': 'opt14'})['inspection']
assert any(node['rm_type'] == 'DV_TEXT' and 'CLUSTER.engine_fixture.v1' in node['path'] for node in legacy_inspection['paths'])
client.tool('template_compile', {'content': legacy, 'dependencies': legacy_dependencies[:-1]}, error=True)
client.tool('template_compile', {'content': legacy.replace('annotation=', 'min="0" annotation='), 'dependencies': legacy_dependencies}, error=True)
record('Legacy OET/ADL 1.4 nested compilation, exact terms/bindings, independent OPT XML schema/RM profile and byte-identical rebuild; missing dependencies and widening rejected')
if args.writes:
    imported = client.tool('model_artifact_import', {'project': 'engine-fixture', 'filename': 'legacy.oet', 'contentBase64': base64.b64encode(legacy.encode()).decode()})
    source = imported['original']
    refs = []
    for index, dependency in enumerate(legacy_dependencies):
        saved_dep = client.tool('model_artifact_import', {'project': 'engine-fixture', 'filename': f'legacy-{index}.adl', 'contentBase64': base64.b64encode(dependency['content'].encode()).decode()})['original']
        refs.append({'identifier': dependency['identifier'], 'path': saved_dep['path'], 'revision': saved_dep['revision']})
    build = client.tool('template_compile_project', {'project': 'engine-fixture', 'path': source['path'], 'revision': source['revision'], 'dependencies': refs})
    saved = client.tool('model_artifact_get', {'project': 'engine-fixture', **{k: build['artifact'][k] for k in ['path', 'revision']}})
    assert saved['content'] == legacy_output['content'] and saved['metadata']['kind'] == 'compiled_opt14'
    assert saved['status'] == 'DRAFT' and saved['metadata']['build']['report']['checks']['full_aom_semantics'] == 'NOT_EXECUTED'
    assert saved['metadata']['build']['report']['compilation_actions'] == legacy_result['compilation_actions']
    assert client.tool('model_artifact_provenance', {'project': 'engine-fixture', 'importId': imported['import_id']}) == imported
    record('Imported OET and ADL originals compile into a separate OPT 1.4 DRAFT with exact source revisions, unchanged original receipts and explicit qualification limits')
for query, valid in [('SELECT e/ehr_id/value FROM EHR e', True), ('SELECT !!! FROM', False), ('SELECT e/ehr_id/value FROM EHR e garbage', False)]:
    result = client.tool('aql_validate', {'content': query})
    assert result['valid'] == valid
record('Native AQL grammar accepts valid queries and rejects malformed/trailing tokens without a CDR')
args.evidence.parent.mkdir(parents=True, exist_ok=True)
args.evidence.write_text(json.dumps({'status': 'PASS', 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'checks': checks, 'clinical_approval': False, 'external_services': [], 'scope': 'ADL 2/OPT 2, explicit OET/OPT 1.4 compatibility profile and AQL syntax; no clinical approval or Designer round-trip claim'}, indent=2) + '\n')
