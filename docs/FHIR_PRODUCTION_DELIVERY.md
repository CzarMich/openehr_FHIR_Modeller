# Production promotion to hygeoniq-prod

Production runs in RKE2 on `hygeoniq-prod` (192.168.178.30), namespace
`openehr-fhir-modeller`. Public HTTPS and `/mcp` remain available through
`amcdr-vps` at https://openehr-fhir-modeller.sandbox.hygeoniq.com/.
The VPS is the edge, not an application deployment target.

Run **Promote FHIR Modeller Production** on main with the successful exact-main
**Deploy FHIR Modeller Dev** run ID after live Dev checks. The workflow retains
the exact revision, five immutable image manifests, successful actual Dev
execution and readiness/MCP evidence gates. Images are built on hosted runners.
No images are built on Dev or production during promotion.

The protected production job runs on the existing Dev delivery runner, copies
identical manifest digests/layers from GHCR to the dedicated Harbor project
`openehr-fhir-modeller` using pinned Skopeo and `--preserve-digests`, then updates
only the five image references and adds the scoped pull identity in
`CzarMich/platform-infrastructure:kubernetes/production/apps/openehr-fhir-modeller.yaml`.
It validates the complete GitOps tree and pushes without force. Argo CD's
`hygeoniq-production` application reconciles the existing production deployments.
Secrets, PVCs, identity issuers, services and VPS routing are preserved.

Protected environment credentials are `HARBOR_USERNAME`/`HARBOR_PASSWORD` (scoped
publisher), `PROD_CLUSTER_SSH_KEY` and `PROD_CLUSTER_KNOWN_HOSTS` (direct cluster
verification from Dev). The delivery runner uses its existing infrastructure Git
SSH identity. Registry auth and temporary SSH files are removed after the job.
The copy container resolves the configured registry name directly to the production
registry at `192.168.178.30`, preserving its TLS server name rather than using the
unrelated public-edge fallback certificate. Skopeo verifies it with the existing CA at
`/etc/docker/certs.d/registry.hygeoniq.com/ca.crt`; TLS verification stays enabled.
The cluster has its own pull-only `modeller-pull` secret; the previous pull
identity remains available for rollback. Rotate the scoped registry robots before
their one-year expiry. No secret values belong in Git or workflow evidence.

Verification connects directly to `hyq@192.168.178.30` with strict host-key
checking, checks actual pod images/readiness, and executes public HTTPS/MCP and
real openEHR compiler smoke tests through the existing VPS edge. Evidence records
the source revision, exact promoted digests, infrastructure commit and checks.

If verification fails, inspect the failed rollout and revert the infrastructure
image/pull-reference commit to the previous known-good digests. Argo CD performs
the rollback; never reset PVCs or secrets. There is no automatic rollback over
concurrent infrastructure commits. Production deployment does not publish model
artifacts; the existing IG platform retains review and distribution authority.

The former Docker-on-VPS scripts and Compose fixtures remain legacy regression
material and are not invoked by production promotion.

## Primary runtime protocol upgrade

Promotion updates all five exact image references and the matching primary HTTP contract in one infrastructure commit. The primary container uses its image entrypoint, explicit application mode and HTTP port 9000; startup/liveness use `/health` and readiness uses `/ready`, with an allowlisted loopback Host header. The retained standards-engine sidecar, persistent-volume references, secret references and stable identity settings are preserved. The delivery runner already requires PyYAML for the infrastructure validator; the promotion transformer uses that same dependency.

Deployments use `Recreate`. The browser/channel orchestrator owns a single persistent store and must not overlap an old instance during upgrade. The protocol/cohort transition can briefly interrupt requests; confirm processing is stopped or reconciled before promotion, preserve rollback images and check delivery receipts before retrying any uncertain destination write. This change prepares the deployment contract; it does not itself mean a production upgrade has run.

### Probe-handler ownership during the runtime transition

The initial 0.22.0 production sync demonstrated that server-side apply can retain an existing `exec` probe owned by another field manager while adding `httpGet`. Kubernetes rejects the resulting Deployment because a probe permits one handler. The primary Deployment therefore uses Argo CD `Replace=true`, which updates the complete Deployment specification without deleting/recreating the Deployment resource. `Force=true` is not used. This keeps entrypoint, image and probe changes together and retains resource/PVC identities.

Recovery uses the exact verified desired app Deployment, the current resource UID/resourceVersion and unchanged volume/secret references. Validate it with `kubectl replace --dry-run=server` before the atomic replace. Verify all five running image digests, public HTTPS readiness/MCP, private workspace readiness and preservation records afterward. Never remove the old probe handlers in a separate update while the old image is running. The completed 0.22.0 recovery preserved 34 namespace resource identities, 11 secret records, five persistent volumes and the account/service-account state.
