#!/usr/bin/env bash
set -euo pipefail
export TERMINOLOGY_TEST_REPO TERMINOLOGY_TEST_ROOT TERMINOLOGY_TEST_UID TERMINOLOGY_TEST_GID
TERMINOLOGY_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
TERMINOLOGY_TEST_ROOT=$(mktemp -d -t modelling-terminology.XXXXXXXX)
TERMINOLOGY_TEST_UID=$(id -u)
TERMINOLOGY_TEST_GID=$(id -g)
chmod 700 "$TERMINOLOGY_TEST_ROOT"
compose=(docker compose -p "modelling-terminology-test-$$" -f "$TERMINOLOGY_TEST_REPO/tests/fixtures/terminology/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$TERMINOLOGY_TEST_ROOT"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$TERMINOLOGY_TEST_ROOT/tls.key" -out "$TERMINOLOGY_TEST_ROOT/tls.crt" \
  -subj /CN=terminology-fixture -addext subjectAltName=DNS:terminology-fixture \
  -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
chmod 644 "$TERMINOLOGY_TEST_ROOT/tls.crt"
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
python3 "$TERMINOLOGY_TEST_REPO/scripts/mcp-smoke.py" --url "http://$address/mcp" --writes \
  --evidence "${1:-$TERMINOLOGY_TEST_REPO/docs/evidence/ci-terminology-smoke.json}" \
  --catalogue "$TERMINOLOGY_TEST_REPO/docs/evidence/tool-catalogue.json"
python3 "$TERMINOLOGY_TEST_REPO/scripts/terminology-fixture-smoke.py" --url "http://$address/mcp" \
  --evidence "${2:-$TERMINOLOGY_TEST_REPO/docs/evidence/ci-terminology-contract-smoke.json}"
