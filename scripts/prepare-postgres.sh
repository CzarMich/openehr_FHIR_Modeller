#!/usr/bin/env bash
set -euo pipefail
# Called only from deployment with an explicit Compose argument vector and private state directory.
state_dir=${1:?private state directory required}
shift
[[ -n ${MODELLING_STORAGE_SECRET_DIR:-} ]] || { echo 'Storage secret directory required' >&2; exit 2; }
"$@" up -d --wait governance-db cache
if [[ ! -f "$state_dir/postgres-migration.json" ]]; then
  # Build first, then stop writers. Preserve the SQLite volume and create a consistent backup.
  "$@" stop app
  report=$(mktemp "$state_dir/postgres-migration.XXXXXXXX")
  trap 'rm -f -- "$report"' EXIT
  "$@" run --rm --no-deps --interactive=false -T \
    -v "$MODELLING_STORAGE_SECRET_DIR/governance-owner-password:/run/secrets/migration-owner:ro" \
    -e GOVERNANCE_POSTGRES_USER=modelling_owner \
    -e GOVERNANCE_POSTGRES_PASSWORD_FILE=/run/secrets/migration-owner \
    app php scripts/governance-storage.php cutover </dev/null > "$report"
  chmod 600 "$report"
  mv "$report" "$state_dir/postgres-migration.json"
  trap - EXIT
fi
