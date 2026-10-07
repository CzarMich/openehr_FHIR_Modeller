#!/usr/bin/env bash
set -euo pipefail
export SHAREPOINT_TEST_REPO SHAREPOINT_TEST_ROOT SHAREPOINT_TEST_UID SHAREPOINT_TEST_GID
SHAREPOINT_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
SHAREPOINT_TEST_ROOT=$(mktemp -d -t modelling-sharepoint.XXXXXXXX)
SHAREPOINT_TEST_UID=$(id -u)
SHAREPOINT_TEST_GID=$(id -g)
chmod 700 "$SHAREPOINT_TEST_ROOT"
compose=(docker compose -p "modelling-sharepoint-test-$$" -f "$SHAREPOINT_TEST_REPO/tests/fixtures/sharepoint/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$SHAREPOINT_TEST_ROOT"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$SHAREPOINT_TEST_ROOT/tls.key" -out "$SHAREPOINT_TEST_ROOT/tls.crt" \
  -subj /CN=sharepoint-fixture -addext subjectAltName=DNS:sharepoint-fixture \
  -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
chmod 644 "$SHAREPOINT_TEST_ROOT/tls.crt"
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
python3 "$SHAREPOINT_TEST_REPO/scripts/mcp-smoke.py" --url "http://$address/mcp" --writes --governance --without-terminology \
  --evidence "${1:-$SHAREPOINT_TEST_REPO/docs/evidence/ci-sharepoint-smoke.json}"
"${compose[@]}" exec -T app php scripts/sharepoint-smoke.php --allow-test-writes
