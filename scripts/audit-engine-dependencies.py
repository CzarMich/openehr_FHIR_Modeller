#!/usr/bin/env python3
"""Audit the runtime CycloneDX BOM against OSV; no credentials or model content are sent."""
import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--bom', type=Path, default=Path('docs/evidence/engine-sbom.json'))
parser.add_argument('--evidence', type=Path, default=Path('docs/evidence/ci-engine-dependencies-smoke.json'))
args = parser.parse_args()
raw = args.bom.read_bytes()
bom = json.loads(raw)
assert bom.get('bomFormat') == 'CycloneDX'
components = [c for c in bom['components'] if c.get('purl', '').startswith('pkg:maven/')]
assert 1 <= len(components) <= 200
payload = json.dumps({'queries': [{'package': {'purl': c['purl']}} for c in components]}).encode()
request = urllib.request.Request('https://api.osv.dev/v1/querybatch', data=payload, headers={'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=45) as response:
    results = json.load(response)['results']
assert len(results) == len(components)
findings = [{'package': c['purl'], 'advisories': [v['id'] for v in result['vulns']]}
            for c, result in zip(components, results) if result.get('vulns')]
args.evidence.write_text(json.dumps({'status': 'FAIL' if findings else 'PASS', 'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'source': 'https://api.osv.dev/v1/querybatch', 'bom_sha256': hashlib.sha256(raw).hexdigest(),
    'runtime_packages': len(components), 'findings': findings,
    'scope': 'Known advisories for Maven runtime components; not proof of absence of vulnerabilities.'}, indent=2) + '\n')
print(f"Audited {len(components)} engine runtime packages; {len(findings)} packages with advisories.")
if findings:
    print(json.dumps(findings, indent=2))
    raise SystemExit(1)
