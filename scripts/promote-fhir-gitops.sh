#!/usr/bin/env bash
set -euo pipefail
revision=${1:?Validated revision required}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_REPOSITORY:-}" == CzarMich/openehr_FHIR_Modeller && "$(hostname -s)" == platform ]] || { echo 'Promotion requires the repository workflow on the Dev delivery runner.' >&2; exit 2; }
: "${GHCR_TOKEN:?}" "${HARBOR_USERNAME:?}" "${HARBOR_PASSWORD:?}" "${GHCR_USER:?}"
python3 scripts/fhir-promotion-evidence.py "$revision" "$RUNNER_TEMP/promotion/images" "$RUNNER_TEMP/promotion/dev-evidence"
stage="$RUNNER_TEMP/promotion"
auth="$stage/registry-auth.json"
trap 'rm -f -- "$auth"' EXIT
python3 - "$auth" <<'PY'
import base64,json,os,sys
from pathlib import Path
pairs={'ghcr.io':(os.environ['GHCR_USER'],os.environ['GHCR_TOKEN']),'registry.hygeoniq.com':(os.environ['HARBOR_USERNAME'],os.environ['HARBOR_PASSWORD'])}
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'w') as output:json.dump({'auths':{host:{'auth':base64.b64encode((':'.join(pair)).encode()).decode()} for host,pair in pairs.items()}},output)
PY
# Copy identical verified manifests/layers, never rebuild on either deployment host.
skopeo=quay.io/skopeo/stable@sha256:47853bb9fb24202af9110531ebd6e43c5f97701254ca290596640290d17942f4
printf '{}\n' > "$stage/production-images.json"
printf '{}\n' > "$stage/production-runtime-digests.json"
for service in app chat ingress fhir engine; do
  image=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["image"])' "$stage/images/$service.json")
  digest=${image##*@}
  destination="registry.hygeoniq.com/openehr-fhir-modeller/$service"
  docker run --rm -v "$auth:/auth.json:ro" "$skopeo" copy --all --preserve-digests --authfile /auth.json "docker://$image" "docker://$destination:sha-$revision"
  docker run --rm -v "$auth:/auth.json:ro" "$skopeo" inspect --raw --authfile /auth.json "docker://$image" > "$stage/$service-manifest.json"
  python3 - "$stage/production-runtime-digests.json" "$service" "$digest" "$stage/$service-manifest.json" <<'PY_RUNTIME'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);digests=json.loads(path.read_text());manifest=json.loads(Path(sys.argv[4]).read_text());digests[sys.argv[2]]=[sys.argv[3]]+[m['digest'] for m in manifest.get('manifests',[])];path.write_text(json.dumps(digests,indent=2)+'\n')
PY_RUNTIME
  python3 - "$stage/production-images.json" "$service" "$destination@$digest" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);images=json.loads(path.read_text());images[sys.argv[2]]=sys.argv[3];path.write_text(json.dumps(images,indent=2)+'\n')
PY
done
# Use the delivery runner's existing infrastructure Git SSH identity, not a token
# copied from another application. A non-fast-forward push fails without overwrite.
infra="$stage/infrastructure"
git clone --depth 1 git@github.com:CzarMich/platform-infrastructure.git "$infra"
python3 scripts/fhir-prod-gitops.py "$infra/kubernetes/production/apps/openehr-fhir-modeller.yaml" "$stage/production-images.json"
python3 "$infra/kubernetes/production/validate_gitops.py"
latest=$(GH_TOKEN="$GHCR_TOKEN" gh api repos/CzarMich/openehr_FHIR_Modeller/git/ref/heads/main --jq .object.sha)
[[ "$latest" == "$revision" ]] || { echo 'Main advanced; refusing stale promotion.' >&2; exit 2; }
git -C "$infra" config user.name 'FHIR Modeller delivery'
git -C "$infra" config user.email 'fhir-modeller-delivery@users.noreply.github.com'
git -C "$infra" add kubernetes/production/apps/openehr-fhir-modeller.yaml
if ! git -C "$infra" diff --cached --quiet; then
  git -C "$infra" commit -m "Deploy FHIR modeller $revision to hygeoniq-prod"
  git -C "$infra" push origin HEAD:main
fi
git -C "$infra" rev-parse HEAD > "$stage/infrastructure-revision"
