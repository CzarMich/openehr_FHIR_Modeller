# Installation and first use

openEHR Modeller provides a browser workspace and provider-neutral MCP for clinical modelling, supplied-model review, mapping and private integration. Application services are C#/.NET 10; the browser backend remains Node and installed private engines compile/validate standards artifacts. Read [purpose and workflow](../README.md), [source qualification](SOURCE_CONNECTORS.md), [integration](INTEGRATION_ENGINE.md) and [security/privacy](SECURITY.md) before operational use.

## Existing installation

Open the deployed browser URL supplied by your organisation. Sign in with your assigned account and complete MFA if required. The platform owner manages invitations/permissions; model review and clinical approval require their separate roles. The [workspace guide](BROWSER_WORKSPACE.md) describes normal use. Existing human identity issuers and accounts must not be renamed during an upgrade.

For an external MCP client, use the installation's HTTPS `/mcp` endpoint and configured authentication. Browser sign-in alone is not an API credential. Supply credentials using the client's protected configuration, never a prompt or committed file. See [MCP clients](MCP_CLIENTS.md) and [identity/access](IDENTITY_AND_ACCESS.md).

## New server installation

1. Provision the server, trusted HTTPS gateway, private persistent volumes and protected installation keys. Use exact hosted-built image digests for the application, browser, ingress and standards engines. Do not build application images on shared Dev or production.
2. Configure the application service identity, Host/Origin allowlists and verified human identity provider/local account store. Mount protected credentials read-only. Keep source profiles, model repositories, internal audit storage, private processing and destination credentials separate.
3. Preserve/reuse the established runtime storage contract. The application serves HTTP on 9000 behind ingress; configure probes for HTTP. Standards engines remain private and are not public FHIR/CDR endpoints.
4. Bootstrap the owner, establish accounts/MFA and configure the installation's approved drivers/connectivity and source/destination trust boundaries. Driver installation and root trust are installation tasks; do not expose arbitrary executable/JAR uploads in the UI.
5. Verify health and synthetic end-to-end behaviour before using clinical sources. Follow [Dev delivery](FHIR_DEV_DELIVERY.md) and [production promotion/rollback](FHIR_PRODUCTION_DELIVERY.md) for the existing environments.

The supplied [Compose definition](../docker-compose.yml) supports independent installations with prebuilt images and private persistent volumes. [Configuration](CONFIGURATION.md) explains current installation settings. Routine product configuration is moving into authenticated forms; [shared workspace/settings status](WORKSPACE_ACCESS_AND_SETTINGS.md) distinguishes implemented controls from pending source/terminology/destination profile forms. Do not represent the pending forms as delivered.

## Standard I/O

Run the installed application image with `--stdio` and an interactive stdin, or use `make run-stdio` with the configured prebuilt Compose image. Keep stdout reserved for JSON-RPC; diagnostics go to stderr. Standard-I/O service access does not create a human approver. Use the browser's protected review flow for human decisions.

## Clinical boundary

**Every direct clinical/source database connection is read-only, with no override.** Do not use application-internal migrations on a clinical database. FHIR delivery uses a separately authorised HTTP destination. Keep real patient records out of chat, general MCP, model Git and reusable AI memory. Supply and confirm the exact FHIR profiles and applicable openEHR templates before mapping. Clinical acceptance remains deployment/use-case-specific.
