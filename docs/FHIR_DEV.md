# FHIR development deployment

The shared Dev deployment uses [GitHub delivery with pinned images](FHIR_DEV_DELIVERY.md)
at `https://dev-openehr-fhir-modeller.sandbox.hygeoniq.com/`. The local build
commands below are for isolated development and testing, not shared Dev delivery.

The application fork is `CzarMich/openehr_FHIR_Modeller`. Engineering artefacts go
to `CzarMich/fhir_ig`. The existing IG platform is `CzarMich/hyq_fhir` and remains
the sole publication/distribution authority. This guide covers Dev; the separate
[production promotion workflow](FHIR_PRODUCTION_DELIVERY.md) reuses images verified
through GitHub Dev delivery.

## Responsibilities

| Component | Responsibility |
|---|---|
| Git artefact repository | FSH, configuration, resource JSON, synthetic examples, validation evidence, mapping proposals and reviewed history |
| Modeller | Requirements, package discovery, reuse, authoring, validation, comparison and authenticated draft handoff |
| Existing IG platform | Draft intake, review, publication and distribution |
| Runtime FHIR server | Operational resources and optional advertised validation; patient data stays outside model context |

The FHIR engine is a private computational service, not a FHIR runtime server or
catalogue. R4, R4B and R5 are separate project releases. Dependencies require exact
versions; changing release after authoring requires a new project.

## Configuration

For an isolated local Dev deployment, copy `.env.example` to `.env` and configure
the browser using `.env.chat.example`. Enable native Dev identity or the existing
OIDC configuration; configure a shared MCP API key and enable the required writes.
Keep these files private. Prepare the engine secret once:

```sh
install -d -m 700 .secrets
test -s .secrets/fhir-engine-key || openssl rand -hex 32 > .secrets/fhir-engine-key
chmod 444 .secrets/fhir-engine-key
make fhir-dev-up
make fhir-dev-status
```

The enclosing `.secrets` directory is private; the single file is readable by the
different unprivileged container users through its explicit read-only secret
mount. The Dev browser is at `http://localhost:18350`. Use `localhost` consistently
when that is the configured browser origin. The optional
`.docker/docker-compose.fhir-ig-dev.yml` layer joins the existing IG Dev network
and mounts private connection/login files; it does not start another IG service.

`FHIR_ENGINE_URL` and `FHIR_ENGINE_KEY_FILE` enable the private service. The
container network origin `http://fhir:8094` is explicitly supported; other origins
must use HTTPS. Mount the same secret into the engine through
`FHIR_ENGINE_TOKEN_FILE`. The engine is not exposed on a host port.

`FHIR_REPOSITORY_PATH` and `FHIR_AUDIT_PATH` are separate durable directories.
The ledger records verified transport actor, operation, input/result hashes and
source revision. Artefact metadata supplied by callers is labelled as source claims.
Imported originals are immutable; create an authored copy to modify them.

`FHIR_CONNECTIONS_FILE` is a private JSON object managed by the deployment:

```json
{
  "ig-dev": {
    "name": "IG development",
    "type": "ig",
    "baseUrl": "https://ig-dev.example.org",
    "credentialFile": "/run/secrets/ig-dev-token",
    "projectId": "11111111-1111-1111-1111-111111111111",
    "linkId": "22222222-2222-2222-2222-222222222222",
    "environment": "development"
  }
}
```

For the existing IG server's native authentication, replace `credentialFile` with
`loginFile`, pointing to a private JSON file containing `email` and `password`.
The adapter obtains a short-lived JWT from `/api/v1/auth/login` and keeps it only
in request memory. Use an editor account scoped to the intended project. This
avoids a development connection silently expiring after a stored JWT expires.

Other supported connection roles are `runtime`, `terminology` and `git`. Their
roles are distinct. Only safe summaries are exposed. Add explicit private hosts
to `FHIR_ALLOWED_HOSTS`; unencrypted private HTTP additionally requires
`FHIR_ALLOW_HTTP=true`. Confine this exception to explicitly allowlisted services
on an isolated container network, such as the private IG adapter in Dev or
[production](FHIR_PRODUCTION_DELIVERY.md#protected-production-configuration).
Public browser, MCP and external service connections retain verified HTTPS.

Projects hold connection IDs, never credentials. Existing browser personal Git
connections retain their encrypted identity-scoped credentials. FHIR project
storage follows the MCP tenant/project authorization; a browser connected using
one service API key accesses a shared modelling workspace. Use OIDC and project
scopes for separate team access.

## Existing IG operations

The adapter uses the actual `/api/v1/admin/health`, `/api/v1/projects`, project
`/ig`, `/artifacts/upload` and `/git/{linkId}/pull` endpoints. Direct submission
reruns local validation before uploading. Exact commit import passes a full SHA
to the IG platform and records its job. These are draft operations. Review and
publication happen in the IG platform and remain subject to its own gates.

The Git link should target `CzarMich/fhir_ig`, a Dev branch, and
`fsh-generated/resources` (or a deliberately configured JSON source directory).
The IG importer records exact commit/file digests, retries unchanged imports
without duplicate versions, reports conflicts, and does not propagate deletions.

## Verification

Run `make ci`, `npm --prefix chat test`, `npm --prefix chat run test:browser`, and
the engine's test/acceptance scripts documented in [FHIR_ENGINE.md](FHIR_ENGINE.md).
Unit fixtures do not establish real compiler/validator operation. Use actual
SUSHI output, a valid and invalid profile example, package resolution and an
authenticated Dev IG import to verify the complete chain.

Validation evidence differentiates compiler success, structural/profile validation,
terminology coverage, synthetic example validation and clinical approval. An
unavailable validator or unresolved package never becomes a successful check.
Production promotion requires successful Dev delivery and completed live Dev
checks; follow the separate [promotion procedure](FHIR_PRODUCTION_DELIVERY.md).

The modeller's `/ready` endpoint checks the configured private engine and its
installed toolchain. A running browser shell with a missing FHIR engine now
returns a failed readiness check. External registries and the IG platform are
tested separately; readiness does not claim those remote services are available.
