#!/usr/bin/env bash
set -euo pipefail
export CKM_TEST_REPO CKM_TEST_ROOT CKM_TEST_UID CKM_TEST_GID
CKM_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
CKM_TEST_ROOT=$(mktemp -d -t modelling-ckm.XXXXXXXX)
CKM_TEST_UID=$(id -u)
CKM_TEST_GID=$(id -g)
chmod 700 "$CKM_TEST_ROOT"
compose=(docker compose -p "modelling-ckm-test-$$" -f "$CKM_TEST_REPO/tests/fixtures/ckm/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$CKM_TEST_ROOT"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$CKM_TEST_ROOT/tls.key" -out "$CKM_TEST_ROOT/tls.crt" \
  -subj /CN=ckm-fixture -addext subjectAltName=DNS:ckm-fixture \
  -addext basicConstraints=critical,CA:TRUE >/dev/null 2>&1
printf '%s\n' fixture-session > "$CKM_TEST_ROOT/session.secret"
chmod 644 "$CKM_TEST_ROOT/tls.crt" "$CKM_TEST_ROOT/session.secret"
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
python3 "$CKM_TEST_REPO/scripts/ckm-fixture-smoke.py" --url "http://$address/mcp" \
  --rotation-file "$CKM_TEST_ROOT/session.secret" \
  --evidence "${1:-$CKM_TEST_REPO/docs/evidence/ci-ckm-contract-smoke.json}"
"${compose[@]}" exec -T fixture node --input-type=module -e '
import https from "node:https"; import fs from "node:fs";
https.get("https://ckm-fixture/stats", {ca:fs.readFileSync("/fixture-data/tls.crt")}, response => {
 let text=""; response.on("data", part => text+=part); response.on("end", () => {
  const events=JSON.parse(text).events;
  if(events.some(event=>event.collector || event.unexpected)) process.exit(1);
  console.log("PASS redirects were not followed and credentials never crossed source profiles");
 });
}).on("error",()=>process.exit(1));'
