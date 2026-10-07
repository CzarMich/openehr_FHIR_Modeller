#!/usr/bin/env bash
set -euo pipefail
export ENGINE_TEST_REPO ENGINE_TEST_KEY
ENGINE_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
engine_test_dir=$(mktemp -d -t modelling-engine.XXXXXXXX)
ENGINE_TEST_KEY="$engine_test_dir/service-key"
python3 - "$ENGINE_TEST_KEY" <<'PY'
import pathlib,secrets,sys
p=pathlib.Path(sys.argv[1]); p.write_text(secrets.token_hex(32)); p.chmod(0o444)
PY
compose=(docker compose -p "modelling-engine-test-$$" -f "$ENGINE_TEST_REPO/tests/fixtures/engine/compose.yml")
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$engine_test_dir"; }
trap cleanup EXIT
"${compose[@]}" up -d --build --wait
"${compose[@]}" cp engine:/app/sbom.json "$ENGINE_TEST_REPO/docs/evidence/engine-sbom.json"
"${compose[@]}" cp engine:/app/engine.jar "$engine_test_dir/engine.jar"
python3 - "$engine_test_dir/engine.jar" "$ENGINE_TEST_REPO" <<'PYNOTICE'
import pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as jar:
    for notice in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
        assert jar.read('META-INF/' + notice) == (pathlib.Path(sys.argv[2]) / notice).read_bytes(), notice
print('Engine JAR preserves the canonical product and third-party notices.')
PYNOTICE
for notice in LICENSE THIRD_PARTY_NOTICES.md; do
  "${compose[@]}" exec -T engine cat "/app/$notice" | cmp "$ENGINE_TEST_REPO/$notice" -
done
"${compose[@]}" exec -T app php /probe.php
address=$("${compose[@]}" port ingress 8343)
python3 "$ENGINE_TEST_REPO/scripts/engine-fixture-smoke.py" --url "http://$address/mcp" --writes --catalogue "$ENGINE_TEST_REPO/docs/evidence/tool-catalogue.json" \
  --evidence "${1:-$ENGINE_TEST_REPO/docs/evidence/ci-engine-smoke.json}"
python3 "$ENGINE_TEST_REPO/scripts/engine-example-smoke.py" --url "http://$address/mcp" \
  --evidence "$ENGINE_TEST_REPO/docs/evidence/ci-engine-examples-smoke.json"
