#!/usr/bin/env bash
set -euo pipefail
export GOVERNANCE_TEST_REPO MODELLING_STORAGE_SECRET_DIR
GOVERNANCE_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
MODELLING_STORAGE_SECRET_DIR=$(mktemp -d -t modelling-storage.XXXXXXXX)
# The private parent directory protects host files; container services read selected mounts.
for name in governance-password governance-owner-password cache-password cache-signing-key; do
  openssl rand -hex 32 > "$MODELLING_STORAGE_SECRET_DIR/$name"
  chmod 644 "$MODELLING_STORAGE_SECRET_DIR/$name"
done
compose=(docker compose --project-directory "$GOVERNANCE_TEST_REPO" -p "modelling-storage-test-$$" -f "$GOVERNANCE_TEST_REPO/tests/fixtures/governance/compose.yml" -f "$GOVERNANCE_TEST_REPO/deploy/compose.storage.yml" -f "$GOVERNANCE_TEST_REPO/tests/fixtures/storage/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$MODELLING_STORAGE_SECRET_DIR"
}
trap cleanup EXIT
"${compose[@]}" up -d --build --wait
# Reproduce deployment through a piped shell: the one-off container must not consume the rest.
{
  printf '%s\n' '"$1/scripts/prepare-postgres.sh" "$2" "${@:3}"'
  for ignored in {1..1000}; do printf '%s\n' ': # deployment continuation must remain in the parent shell'; done
  printf '%s\n' 'echo STORAGE_DEPLOYMENT_CONTINUED'
} | bash -se -- "$GOVERNANCE_TEST_REPO" "$MODELLING_STORAGE_SECRET_DIR" "${compose[@]}" > "$MODELLING_STORAGE_SECRET_DIR/continuation.log"
grep -Fxq STORAGE_DEPLOYMENT_CONTINUED "$MODELLING_STORAGE_SECRET_DIR/continuation.log"
"${compose[@]}" up -d --wait

"${compose[@]}" exec -T app php /storage-probe.php > "$GOVERNANCE_TEST_REPO/docs/evidence/ci-storage-smoke.json"
"${compose[@]}" exec -T app php scripts/governance-storage.php verify
"${compose[@]}" restart governance-db
"${compose[@]}" up -d --wait
"${compose[@]}" exec -T app php /storage-probe.php resume
address=$("${compose[@]}" port ingress 8343)
python3 "$GOVERNANCE_TEST_REPO/scripts/governance-fixture-smoke.py" --url "http://$address" --state "$MODELLING_STORAGE_SECRET_DIR/review-state.json" --evidence "$GOVERNANCE_TEST_REPO/docs/evidence/ci-postgres-governance-smoke.json"
python3 "$GOVERNANCE_TEST_REPO/scripts/import-fixture-smoke.py" --url "http://$address/mcp" --writes --catalogue "$GOVERNANCE_TEST_REPO/docs/evidence/tool-catalogue.json" --evidence "$GOVERNANCE_TEST_REPO/docs/evidence/ci-import-smoke.json"
"${compose[@]}" stop cache
"${compose[@]}" exec -T app php /storage-probe.php outage
