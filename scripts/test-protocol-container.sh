#!/usr/bin/env bash
set -euo pipefail
export PROTOCOL_TEST_REPO PROTOCOL_TEST_ORIGIN
PROTOCOL_TEST_REPO=$(cd "$(dirname "$0")/.." && pwd)
PROTOCOL_TEST_ORIGIN=http://localhost:3000
compose=(docker compose -p "modelling-protocol-test-$$" -f "$PROTOCOL_TEST_REPO/tests/fixtures/protocol/compose.yml")
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${compose[@]}" up -d --build --wait
address=$("${compose[@]}" port ingress 8343)
PROTOCOL_TEST_ORIGIN="http://$address"
"${compose[@]}" up -d --force-recreate --wait app
prefix=${1:-$PROTOCOL_TEST_REPO/docs/evidence/ci-protocol}
python3 "$PROTOCOL_TEST_REPO/scripts/protocol-smoke.py" --url "http://$address/mcp" \
  --allowed-origin "$PROTOCOL_TEST_ORIGIN" --evidence "$prefix-http-smoke.json"
python3 "$PROTOCOL_TEST_REPO/scripts/protocol-smoke.py" --evidence "$prefix-stdio-smoke.json" \
  -- "${compose[@]}" exec -T app php public/index.php --transport=stdio
if [[ ${MCP_OFFICIAL_ACCEPTANCE:-true} == true ]]; then
  docker run --rm --network host -e MCP_TEST_URL="http://$address/mcp" \
    node:22.22.1-bookworm-slim sh -eu -c '
      for scenario in server-initialize logging-set-level ping tools-list resources-list prompts-list server-sse-multiple-streams dns-rebinding-protection; do
        npx --yes @modelcontextprotocol/conformance@0.1.16 server --url "$MCP_TEST_URL" --scenario "$scenario"
      done' | tee "$prefix-official.log"
fi
