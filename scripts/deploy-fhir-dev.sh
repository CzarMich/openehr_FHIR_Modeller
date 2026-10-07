#!/usr/bin/env bash
set -euo pipefail

revision=${1:?A full validated Git SHA is required}
manifest_dir=${2:?The CI image manifest directory is required}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid revision.' >&2; exit 2; }
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REPOSITORY:-}" == CzarMich/openehr_FHIR_Modeller ]] || { echo 'Delivery must run through this repository GitHub Actions workflow.' >&2; exit 2; }

# These guards deliberately have no environment override or remote SSH fallback.
marker=/opt/hygeoniq/dev-host
[[ "$(hostname -s)" == platform ]] || { echo 'This is not the approved Dev host.' >&2; exit 2; }
[[ -f "$marker" && ! -L "$marker" && "$(stat -c %u "$marker")" == 0 ]] || { echo 'The root-owned Dev host marker is missing.' >&2; exit 2; }
marker_mode=$(stat -c %a "$marker")
(( (8#$marker_mode & 022) == 0 )) || { echo 'The Dev marker is writable by non-root users.' >&2; exit 2; }
grep -Fxq hygeoniq-development "$marker" || { echo 'Wrong Dev marker.' >&2; exit 2; }
ip -4 -o address show | grep -Eq ' inet 192\.168\.178\.20/' || { echo 'The approved Dev address is absent.' >&2; exit 2; }
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
[[ "$(docker context inspect --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || { echo 'A local Docker context is required.' >&2; exit 2; }
[[ "$(docker info --format '{{.Name}}')" == platform ]] || { echo 'Docker is not on the approved Dev host.' >&2; exit 2; }

state_dir=/opt/hygeoniq/projects/openehr-fhir-modeller/deployment
config_dir=/opt/hygeoniq/projects/openehr-fhir-modeller/config
ca_file=/usr/local/share/ca-certificates/hygeoniq-development-ca.crt
public_host=dev-openehr-fhir-modeller.sandbox.hygeoniq.com
release_dir="$state_dir/releases/$revision"
for file in "$config_dir/runtime.env" "$config_dir/chat.env" "$config_dir/secrets/fhir-engine-key" "$config_dir/secrets/fhir-connections.json" "$config_dir/secrets/ig-dev-login.json" "$ca_file"; do
  [[ -s "$file" ]] || { echo 'Required protected Dev configuration is missing.' >&2; exit 2; }
done
for volume in models governance chat-data cdr-data fhir-data; do
  docker volume inspect "openehr-fhir-modeller_$volume" >/dev/null
done
for network in openehr-fhir-modeller_default hygeoniq-proxy hyq-fhir-ig-dev_default; do
  docker network inspect "$network" >/dev/null
done
mkdir -p "$state_dir/releases"
exec 9>"$state_dir/.deploy.lock"
flock -n 9 || { echo 'Another Dev delivery is active.' >&2; exit 75; }
mkdir -p "$release_dir/evidence"
python3 scripts/fhir-dev-manifest.py "$revision" "$manifest_dir" "$release_dir"
install -m 0644 deploy/fhir-dev/compose.yml "$release_dir/compose.yml"
# Compose gives shell variables precedence over --env-file. Only the checked
# manifest may select images/revision, including during rollback.
unset APP_IMAGE CHAT_IMAGE INGRESS_IMAGE FHIR_IMAGE REVISION
compose=(docker compose --project-name openehr-fhir-modeller --env-file "$release_dir/images.env" -f "$release_dir/compose.yml")
"${compose[@]}" config --quiet
"${compose[@]}" pull
while IFS='=' read -r name image; do
  [[ "$name" == *_IMAGE ]] || continue
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] || { echo 'Image provenance revision mismatch.' >&2; exit 2; }
done < "$release_dir/images.env"
latest_revision=$(timeout 45s gh api repos/CzarMich/openehr_FHIR_Modeller/git/ref/heads/main --jq .object.sha)
unset GH_TOKEN
if [[ "$latest_revision" != "$revision" ]]; then
  echo 'Main advanced during image transfer; deployment is skipped.'
  exit 0
fi
previous=''
if [[ -r "$state_dir/current-revision" ]]; then previous=$(cat "$state_dir/current-revision"); fi
rollback() {
  status=$?
  trap - ERR
  echo 'Dev verification failed; preserving volumes and restoring previous pinned images when available.' >&2
  if [[ "$previous" =~ ^[0-9a-f]{40}$ && -f "$state_dir/releases/$previous/compose.yml" ]]; then
    docker compose --project-name openehr-fhir-modeller --env-file "$state_dir/releases/$previous/images.env" -f "$state_dir/releases/$previous/compose.yml" up -d --no-build --wait --wait-timeout 300 || true
  fi
  exit "$status"
}
trap rollback ERR
"${compose[@]}" up -d --no-build --wait --wait-timeout 300
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:18350/ready > "$release_dir/evidence/loopback-ready.json"
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 --cacert "$ca_file" --resolve "$public_host:443:192.168.178.20" "https://$public_host/ready" > "$release_dir/evidence/https-ready.json"; then break; fi
  if [[ "$attempt" == 15 ]]; then false; fi
  sleep 2
done
curl --fail --silent --show-error --max-time 30 --cacert "$ca_file" --resolve "$public_host:443:192.168.178.20" "https://$public_host/chat/" > /dev/null
SSL_CERT_FILE="$ca_file" python3 - "$config_dir/runtime.env" "$public_host" "$release_dir" <<'PY'
import json,os,subprocess,sys
from pathlib import Path
config,hostname,destination=sys.argv[1:]
for line in Path(config).read_text().splitlines():
    if line.startswith(('AUTH_API_KEY=','AUTH_API_KEY_HEADER=','MCP_SERVER_NAME=')):
        key,value=line.split('=',1)
        if len(value)>=2 and value[0]==value[-1] and value[0] in ('"',"'"): value=value[1:-1]
        os.environ[key]=value
evidence=Path(destination,'evidence/mcp-smoke.json')
subprocess.run(['python3','scripts/mcp-smoke.py','--url','https://'+hostname+'/mcp','--evidence',str(evidence)],check=True)
checks=json.loads(evidence.read_text())
tools=next(c['detail'] for c in checks['checks'] if c['check']=='tools/list')
assert {'fhir_project','fhir_artifact','fhir_fsh_compile','fhir_ig'} <= set(tools), 'FHIR capabilities absent after deployment'
PY
printf '%s\n' "$revision" > "$state_dir/.current-revision.tmp"
mv "$state_dir/.current-revision.tmp" "$state_dir/current-revision"
cp "$release_dir/images.json" "$release_dir/evidence/images.json"
trap - ERR
printf 'Deployed validated revision %s to https://%s/ (Dev only).\n' "$revision" "$public_host"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Dev deployment: https://%s/\n\nValidated revision: `%s`\n' "$public_host" "$revision" >> "$GITHUB_STEP_SUMMARY"
fi
