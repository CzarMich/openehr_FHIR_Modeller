# GitHub delivery to Dev

The Dev workflow deploys to local host `platform` (`192.168.178.20`):

- Browser: <https://dev-openehr-fhir-modeller.sandbox.hygeoniq.com/>
- MCP: <https://dev-openehr-fhir-modeller.sandbox.hygeoniq.com/mcp>
- Local diagnostics: <http://127.0.0.1:18350/>

The inherited VPS deployment workflow is removed from this fork. This delivery
path contains no SSH target, remote build or production deployment.
Production uses a separate, explicitly dispatched
[promotion of successfully verified Dev images](FHIR_PRODUCTION_DELIVERY.md).

## Delivery contract

After `PR validation` succeeds for a push to current `main`, `Deploy FHIR Modeller
Dev` builds app, chat, ingress and private FHIR images on GitHub-hosted runners.
Each image records the exact validated commit and is pushed to
`ghcr.io/czarmich/openehr-fhir-modeller-{app,chat,ingress,fhir}`. Digest manifests
are transferred to the repository runner labelled
`self-hosted,Linux,X64,hyq-dev,fhir-modeller-dev`.

The runner deploys immutable image digests, performs no builds and mounts no
application source. The script requires root-owned, non-writable marker
`/opt/hygeoniq/dev-host` containing `hygeoniq-development`, the approved hostname
and address, and the expected repository Actions context. It fixes Docker to
the local Unix socket, clears context/TLS overrides and verifies daemon hostname.

Workflow dispatch from `main` supports recovery, but still requires successful
validation of that exact current main commit. Main freshness is checked before
building, before scheduling delivery and again after image pulls. An older delivery
is skipped when a newer main revision exists.

## Protected host configuration

The operator provisions `/opt/hygeoniq/projects/openehr-fhir-modeller/config/`:

| File | Purpose |
| --- | --- |
| `runtime.env` | Existing app authentication, governance and repository settings |
| `chat.env` | Existing browser identity, encryption, provider and token-budget settings |
| `secrets/fhir-engine-key` | Internal credential readable by app UID1000 and engine UID10001 |
| `secrets/fhir-connections.json` | Named connections; IG uses its configured `ig-dev-api` origin |
| `secrets/ig-dev-login.json` | Existing IG authentication credentials |

Credentials and identity/encryption keys remain outside Git and image builds.
Preserve the explicit existing `CHAT_LOCAL_IDENTITY_ISSUER` and corresponding
governance identity issuer when moving the browser to HTTPS; changing an issuer
can detach existing accounts and project authorization. The public browser URL
changes independently. The public CA is mounted from
`/usr/local/share/ca-certificates/hygeoniq-development-ca.crt`; TLS verification
stays enabled.

Delivery preserves Compose project `openehr-fhir-modeller`, its default network
and all five external volumes: models, governance, cdr-data, chat-data and
fhir-data. The app remains UID1000 and the FHIR engine UID10001. No existing volume
ownership changes or volume deletion occur. Only ingress joins `hygeoniq-proxy`;
only the app joins IG Dev network `hyq-fhir-ig-dev_default`. FHIR port8094 stays
private.

The sibling `deployment/` directory records each revision, digest manifest,
immutable Compose file and read-only health/MCP evidence. `current-revision`
advances only after loopback and CA-verified public HTTPS checks pass and the
expected FHIR MCP tools are present. On failure, a previous recorded pinned release
is restored when available; volumes stay intact. First migration from a manual
stack has no recorded image rollback yet, so repair or rerun the same validated
release if verification fails.

## Access and verification

Clients on the Dev LAN/VPN need DNS or a hosts entry mapping the public hostname
to `192.168.178.20`, plus trust in the development CA. Use the existing browser
account and MFA. MCP uses its configured credential. Delivery never prints it.

`scripts/test-fhir-dev-delivery.py` checks digest/revision rejection, host guards,
immutable Compose settings and preserved storage without starting containers.
Delivery uploads exact-commit readiness/MCP evidence. The browser acceptance
harness then exercises the HTTPS authoring and validation flow. These checks do
not constitute clinical approval or IG publication.
