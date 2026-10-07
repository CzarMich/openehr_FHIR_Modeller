#!/usr/bin/env bash
set -euo pipefail
revision=${1:?full Git SHA required}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
state_dir=/opt/openehr-modelling-assistant
release_dir="$state_dir/releases/$revision"
test -r "$state_dir/config/runtime.env"
test -r "$state_dir/incoming/$revision.tar.gz"
mkdir -p "$state_dir/releases"
exec 9>"$state_dir/.deploy.lock"
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 75; }
mkdir -p "$release_dir"
tar --extract --gzip --file "$state_dir/incoming/$revision.tar.gz" --directory "$release_dir"
ln -sfn "$state_dir/config/runtime.env" "$release_dir/.env"
cd "$release_dir"
compose=(docker compose -p openehr-modelling-assistant --env-file .env -f docker-compose.yml)
storage=false
if [[ -d "$state_dir/config/storage" ]]; then
  export MODELLING_STORAGE_SECRET_DIR="$state_dir/config/storage"
  compose+=(-f deploy/compose.storage.yml)
  storage=true
fi
engine=false
if [[ -r "$state_dir/config/engine-key" ]]; then
  export MODELLING_ENGINE_KEY_FILE="$state_dir/config/engine-key"
  compose+=(-f deploy/compose.engine.yml)
  engine=true
fi
cdr=false
if [[ -r "$state_dir/config/cdr-key" ]]; then
  export MODELLING_CDR_KEY_FILE="$state_dir/config/cdr-key"
  compose+=(-f deploy/compose.cdr.yml)
  cdr=true
fi
"${compose[@]}" config --quiet
"${compose[@]}" build
previous=""
if [[ -r "$state_dir/current-revision" ]]; then previous=$(cat "$state_dir/current-revision"); fi
rollback() {
  if [[ -n "$previous" && -d "$state_dir/releases/$previous" ]]; then
    cd "$state_dir/releases/$previous"
    # Never fall back to the old SQLite ledger after PostgreSQL accepts authority.
    if [[ "$storage" == true && ! -f deploy/compose.storage.yml ]]; then
      echo 'Previous release predates PostgreSQL support; keeping writers stopped for forward recovery.' >&2
      return
    fi
    rollback_compose=(docker compose -p openehr-modelling-assistant --env-file .env -f docker-compose.yml)
    if [[ "$storage" == true ]]; then rollback_compose+=(-f deploy/compose.storage.yml); fi
    if [[ "$engine" == true && -f deploy/compose.engine.yml ]]; then rollback_compose+=(-f deploy/compose.engine.yml); fi
    if [[ "$cdr" == true && -f deploy/compose.cdr.yml ]]; then rollback_compose+=(-f deploy/compose.cdr.yml); fi
    "${rollback_compose[@]}" up -d --build --wait || true
  fi
}
trap rollback ERR
if [[ "$storage" == true ]]; then scripts/prepare-postgres.sh "$state_dir" "${compose[@]}"; fi
"${compose[@]}" up -d --wait
# Read only the inbound test credential into the subprocess environment, never print it.
python3 - <<'PY'
import os,subprocess
from pathlib import Path
for line in Path('.env').read_text().splitlines():
    if line.startswith(('AUTH_API_KEY=','AUTH_API_KEY_HEADER=','MCP_SERVER_NAME=')):
        key,value=line.split('=',1);os.environ[key]=value
subprocess.run(['python3','scripts/mcp-smoke.py','--url','https://openehr-modelling.sandbox.hygeoniq.com/mcp','--evidence','/tmp/modelling-deployment-smoke.json'],check=True)
PY
printf '%s\n' "$revision" > "$state_dir/current-revision"
trap - ERR
printf 'Deployed openEHR Modelling Assistant %s\n' "$revision"
