#!/usr/bin/env bash
set -euo pipefail
repository=$(cd "$(dirname "$0")/.." && pwd)
python3 "$repository/dotnet/tests/storage-contracts.py" --evidence "${1:-$repository/docs/evidence/ci-storage-smoke.json}"
