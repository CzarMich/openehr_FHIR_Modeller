#!/usr/bin/env bash
set -euo pipefail
export OIDC_TEST_REPO
OIDC_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
export OIDC_TEST_ROOT
OIDC_TEST_ROOT=$(mktemp -d -t modelling-oidc.XXXXXXXX)
chmod 700 "$OIDC_TEST_ROOT"
export OIDC_TEST_UID OIDC_TEST_GID
OIDC_TEST_UID=$(id -u)
OIDC_TEST_GID=$(id -g)
compose=(docker compose -p "modelling-oidc-test-$$" -f "$OIDC_TEST_REPO/tests/fixtures/oidc/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$OIDC_TEST_ROOT"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$OIDC_TEST_ROOT/tls.key" -out "$OIDC_TEST_ROOT/tls.crt" \
  -subj /CN=oidc-fixture -addext subjectAltName=DNS:oidc-fixture \
  -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
chmod 644 "$OIDC_TEST_ROOT/tls.crt"
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
python3 - "$OIDC_TEST_ROOT" "$OIDC_TEST_REPO" "http://$address/mcp" "${1:-$OIDC_TEST_REPO/docs/evidence/ci-oidc-smoke.json}" <<'PY'
import json,os,subprocess,sys
from pathlib import Path
root,repo,url,evidence=sys.argv[1:]
env=os.environ.copy()
env.update(json.loads((Path(root)/'tokens.json').read_text()))
subprocess.run(['python3',str(Path(repo)/'scripts/oidc-smoke.py'),'--url',url,'--allow-test-writes','--issuer-kind','fixture','--evidence',evidence],env=env,check=True)
PY
