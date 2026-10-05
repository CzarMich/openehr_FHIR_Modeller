#!/usr/bin/env bash
set -euo pipefail
export GOVERNANCE_TEST_REPO
GOVERNANCE_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
governance_test_state=$(mktemp -t modelling-governance.XXXXXXXX)
compose=(docker compose -p "modelling-governance-test-$$" -f "$GOVERNANCE_TEST_REPO/tests/fixtures/governance/compose.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f -- "$governance_test_state"
}
trap cleanup EXIT
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
evidence=${1:-$GOVERNANCE_TEST_REPO/docs/evidence/ci-governance-smoke.json}
python3 "$GOVERNANCE_TEST_REPO/scripts/governance-fixture-smoke.py" --url "http://$address" --state "$governance_test_state" --evidence "$evidence"
"${compose[@]}" up -d --force-recreate --wait
# A recreated ingress may receive a different ephemeral host port.
address=$("${compose[@]}" port ingress 8343)
python3 "$GOVERNANCE_TEST_REPO/scripts/governance-fixture-smoke.py" --url "http://$address" --state "$governance_test_state" --evidence "$evidence" --resume
