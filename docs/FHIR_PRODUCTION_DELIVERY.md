# Production promotion

The modeller is available at `https://openehr-fhir-modeller.sandbox.hygeoniq.com/`
after successful production promotion. The MCP path is `/mcp`. Production uses
separate accounts, credentials, workspaces and volumes from Dev. The existing IG
platform remains responsible for publication and distribution; deploying the
modeller does not publish any FHIR artifact.

## Promote verified images through GitHub

Run **Promote FHIR Modeller Production** from `main`, providing the successful
**Deploy FHIR Modeller Dev** run ID for that exact current main commit. Complete
the live Dev browser and FHIR workflow checks before starting promotion.

The workflow checks the source repository, current revision, successful actual
Dev deployment step, four immutable digest manifests, and matching Dev readiness
and MCP evidence. A skipped or stale Dev delivery cannot supply the required
evidence. It downloads the images' recorded digest references; it builds no new
images and does not use mutable image tags.

The GitHub-hosted promotion job uses the protected `production` environment and
dedicated `PROD_SSH_KEY` / `PROD_SSH_KNOWN_HOSTS` secrets. SSH host-key checking is
mandatory. The fixed target is `amcdr@82.165.59.171`; there is no persistent Actions
runner on the production server. Only tracked deployment files and verified
manifests are transferred. A short-lived Actions token reaches registry login
through SSH standard input, and the temporary registry configuration is removed
when the deployment process exits.

The remote script requires hostname and Docker daemon name `ubuntu`, address
`82.165.59.171`, and root-owned `/opt/hygeoniq/production-host` containing
`hygeoniq-production`. It forces the local Docker socket and checks current main
again after image transfer. Pulls are sequential and quiet. No source directory
is mounted into an application container.

## Protected production configuration

The operator provisions `/opt/hygeoniq/projects/openehr-fhir-modeller-prod/`:

- `config/runtime.env` and `config/chat.env`, with fresh production keys and the
  production HTTPS identity issuer;
- `config/secrets/fhir-engine-key`, `fhir-connections.json` and `ig-prod-login.json`;
- writable `deployment/`, containing immutable release manifests and evidence.

The named IG connection is `ig-prod`, with private origin
`http://ig-prod-api:8092`. Only the app joins `hyq-fhir-ig-prod_default`.
Compose project `openehr-fhir-modeller-prod` has its own default network and five
external volumes: models, governance, cdr-data, chat-data and fhir-data. The app
and browser run as UID1000; the private FHIR engine runs as UID10001.

Existing Nginx terminates public TLS and forwards the original host and HTTPS
scheme to `127.0.0.1:18350`. The private engine has no host port. Production uses
the public certificate chain, without disabling TLS verification or loading the
development CA.

GitHub delivery installs only the tracked site named
`openehr-fhir-modeller.sandbox.hygeoniq.com.conf`, after containers are healthy.
It rejects an unrelated existing file or enabled-site link, saves previous bytes
and link state, checks `nginx -t` before reload, and restores the prior managed
site if activation or subsequent verification fails. Other sites remain intact.

The engine has a 2 GiB limit for its existing 1,536 MiB validator heap and native
overhead. A production-only Java wrapper is mounted read-only from the tracked
release. The shared host lock `/opt/hygeoniq/fhir-production-tooling/java.lock`
(root:1000, mode0660) prevents simultaneous heavy Java work in the modeller and
IG platform. Version probes remain available; the lock releases on process exit.
Browser, app and ingress limits are 512, 256 and 64 MiB. These limits require
capacity monitoring alongside existing server workloads.

## Verification and recovery

Promotion waits for container health, checks loopback and certificate-verified
public HTTPS readiness, and runs the independent authenticated MCP smoke client.
It records the source SHA, Dev run ID and exact image digests without secrets.
Only then does `deployment/current-revision` advance. GitHub retains the
production verification artifact for 30 days.

If verification fails, the previous managed release is restored when present;
data volumes remain intact. The first deployment has no previous managed release,
so repair the configuration and rerun promotion of a currently verified main
revision. Offline tests cover mismatched image evidence, failed Dev checks,
wrong-host rejection and separate production storage without contacting the VPS.
