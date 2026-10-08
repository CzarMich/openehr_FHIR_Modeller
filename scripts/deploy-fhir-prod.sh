#!/usr/bin/env bash
set -euo pipefail

revision=${1:?A validated full Git SHA is required}
dev_run=${2:?A successful Dev delivery run is required}
registry_user=${3:?A registry actor is required}
[[ "$revision" =~ ^[0-9a-f]{40}$ && "$dev_run" =~ ^[1-9][0-9]*$ && "$registry_user" =~ ^[A-Za-z0-9-]+$ ]] || { echo 'Invalid promotion parameters.' >&2; exit 2; }
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REPOSITORY:-}" == CzarMich/openehr_FHIR_Modeller ]] || { echo 'Production promotion must originate in the repository workflow.' >&2; exit 2; }
marker=/opt/hygeoniq/production-host
[[ "$(hostname -s)" == ubuntu ]] || { echo 'This is not the approved production host.' >&2; exit 2; }
[[ -f "$marker" && ! -L "$marker" && "$(stat -c %u "$marker")" == 0 ]] || { echo 'The root-owned production marker is missing.' >&2; exit 2; }
marker_mode=$(stat -c %a "$marker")
(( (8#$marker_mode & 022) == 0 )) || { echo 'The production marker is writable by non-root users.' >&2; exit 2; }
grep -Fxq hygeoniq-production "$marker" || { echo 'Wrong production marker.' >&2; exit 2; }
ip -4 -o address show | grep -Eq ' inet 82\.165\.59\.171/' || { echo 'The approved production address is absent.' >&2; exit 2; }
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
export DOCKER_HOST=unix:///var/run/docker.sock
[[ "$(docker info --format '{{.Name}}')" == ubuntu ]] || { echo 'Docker is not on the approved production host.' >&2; exit 2; }

state_dir=/opt/hygeoniq/projects/openehr-fhir-modeller-prod/deployment
config_dir=/opt/hygeoniq/projects/openehr-fhir-modeller-prod/config
public_host=openehr-fhir-modeller.sandbox.hygeoniq.com
release_dir="$state_dir/releases/$revision"
for file in "$config_dir/runtime.env" "$config_dir/chat.env" "$config_dir/secrets/fhir-engine-key" "$config_dir/secrets/fhir-connections.json" "$config_dir/secrets/ig-prod-login.json"; do
  [[ -s "$file" ]] || { echo 'Required protected production configuration is missing.' >&2; exit 2; }
done
java_lock=/opt/hygeoniq/fhir-production-tooling/java.lock
[[ -f "$java_lock" && ! -L "$java_lock" && "$(stat -c '%u:%g:%a' "$java_lock")" == 0:1000:660 ]] || { echo 'The shared production Java lock is missing or has unexpected ownership.' >&2; exit 2; }
for volume in models governance chat-data cdr-data fhir-data; do
  docker volume inspect "openehr-fhir-modeller-prod_$volume" >/dev/null
done
for network in openehr-fhir-modeller-prod_default hyq-fhir-ig-prod_default; do
  docker network inspect "$network" >/dev/null
done
mkdir -p "$state_dir/releases"
exec 9>"$state_dir/.deploy.lock"
flock -n 9 || { echo 'Another production promotion is active.' >&2; exit 75; }
python3 scripts/fhir-promotion-evidence.py "$revision" images dev-evidence
mkdir -p "$release_dir/evidence"
python3 scripts/fhir-dev-manifest.py "$revision" images "$release_dir"
install -m 0644 deploy/fhir-prod/compose.yml "$release_dir/compose.yml"
install -D -m 0755 deploy/production/java-memory-guard.sh "$release_dir/runtime/java-memory-guard.sh"

# The short-lived Actions token arrives via SSH stdin, never in process arguments.
IFS= read -r registry_token
[[ -n "$registry_token" ]] || { echo 'A short-lived registry token is required.' >&2; exit 2; }
docker_config=$(mktemp -d "$state_dir/.registry.XXXXXXXX")
chmod 700 "$docker_config"
trap 'rm -rf -- "$docker_config"' EXIT
export DOCKER_CONFIG="$docker_config"
printf '%s\n' "$registry_token" | docker login ghcr.io --username "$registry_user" --password-stdin
unset APP_IMAGE CHAT_IMAGE INGRESS_IMAGE FHIR_IMAGE REVISION
export COMPOSE_PARALLEL_LIMIT=1
compose=(docker compose --project-name openehr-fhir-modeller-prod --env-file "$release_dir/images.env" -f "$release_dir/compose.yml")
"${compose[@]}" config --quiet
echo 'Pulling the verified Dev digests sequentially for production.'
"${compose[@]}" pull --quiet
echo 'Production image transfer completed.'
while IFS='=' read -r name image; do
  [[ "$name" == *_IMAGE ]] || continue
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]] || { echo 'Image provenance revision mismatch.' >&2; exit 2; }
done < "$release_dir/images.env"
latest_revision=$(printf '%s' "$registry_token" | timeout 60s python3 -c 'import json,sys,urllib.request; token=sys.stdin.read(); request=urllib.request.Request("https://api.github.com/repos/CzarMich/openehr_FHIR_Modeller/git/ref/heads/main",headers={"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json"}); print(json.load(urllib.request.urlopen(request,timeout=45))["object"]["sha"])')
unset registry_token
[[ "$latest_revision" == "$revision" ]] || { echo 'Main advanced during transfer; refusing stale production promotion.' >&2; exit 2; }
bash scripts/fhir-prod-nginx.sh prepare "$release_dir/nginx-previous"
nginx_active=false
previous=''
if [[ -r "$state_dir/current-revision" ]]; then previous=$(cat "$state_dir/current-revision"); fi
rollback() {
  status=$?
  trap - ERR
  echo 'Production verification failed; preserving volumes and restoring the prior pinned release when available.' >&2
  if [[ "$nginx_active" == true ]]; then bash scripts/fhir-prod-nginx.sh restore "$release_dir/nginx-previous" || true; fi
  if [[ "$previous" =~ ^[0-9a-f]{40}$ && -f "$state_dir/releases/$previous/compose.yml" ]]; then
    docker compose --project-name openehr-fhir-modeller-prod --env-file "$state_dir/releases/$previous/images.env" -f "$state_dir/releases/$previous/compose.yml" up -d --no-build --wait --wait-timeout 300 || true
  fi
  exit "$status"
}
trap rollback ERR
"${compose[@]}" up -d --no-build --wait --wait-timeout 300
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:18350/ready > "$release_dir/evidence/loopback-ready.json"
bash scripts/fhir-prod-nginx.sh activate "$release_dir/nginx-previous"
nginx_active=true
for attempt in $(seq 1 15); do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 10 --resolve "$public_host:443:82.165.59.171" "https://$public_host/ready" > "$release_dir/evidence/https-ready.json"; then break; fi
  if [[ "$attempt" == 15 ]]; then false; fi
  sleep 2
done
curl --fail --silent --show-error --max-time 30 --resolve "$public_host:443:82.165.59.171" "https://$public_host/chat/" > /dev/null
python3 - "$config_dir/runtime.env" "$public_host" "$release_dir" <<'PY'
import json,os,subprocess,sys
from pathlib import Path
config,hostname,destination=sys.argv[1:]
for line in Path(config).read_text().splitlines():
    if line.startswith(('AUTH_API_KEY=','AUTH_API_KEY_HEADER=','MCP_SERVER_NAME=')):
        key,value=line.split('=',1)
        if len(value)>=2 and value[0]==value[-1] and value[0] in ('"',"'"): value=value[1:-1]
        os.environ[key]=value
evidence=Path(destination,'evidence/mcp-smoke.json')
subprocess.run(['python3','scripts/mcp-smoke.py','--fhir','--url','https://'+hostname+'/mcp','--evidence',str(evidence)],check=True)
checks=json.loads(evidence.read_text())
tools=next(c['detail'] for c in checks['checks'] if c['check']=='tools/list')
if not {'fhir_project','fhir_artifact','fhir_fsh_compile','fhir_ig'} <= set(tools): raise ValueError('FHIR capabilities absent after production promotion')
PY
printf '%s\n' "$revision" > "$state_dir/.current-revision.tmp"
mv "$state_dir/.current-revision.tmp" "$state_dir/current-revision"
cp "$release_dir/images.json" "$release_dir/evidence/images.json"
printf '{"revision":"%s","devRunId":%s,"environment":"production"}\n' "$revision" "$dev_run" > "$release_dir/evidence/promotion.json"
trap - ERR
printf 'Promoted verified Dev revision %s to https://%s/.\n' "$revision" "$public_host"
