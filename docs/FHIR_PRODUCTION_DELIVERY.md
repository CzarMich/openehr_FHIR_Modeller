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
Skopeo verifies the destination with the existing registry CA at
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
