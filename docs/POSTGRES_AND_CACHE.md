# PostgreSQL governance and model retrieval cache

Use PostgreSQL for a shared, durable governance ledger and Valkey (or a compatible Redis service) for optional model retrieval caching. Model source files and revisions remain in the selected filesystem, Git or SharePoint repository. PostgreSQL is authoritative for lifecycle events, validation evidence and consumed browser assertions. Neither the cache nor editable model metadata can grant a role, approve a model or replace audit evidence.

## Deploy the storage services

Include `deploy/compose.storage.yml` with the normal Compose files. It runs PostgreSQL 16 and Valkey 8 on an internal network with no published database/cache ports. The app uses a restricted database role; the database owner is a separate secret used only for initialization, migration and recovery. Generate four independent random secrets in a private directory outside the checkout:

```sh
install -d -m 700 /secure/modelling-storage
for name in governance-password governance-owner-password cache-password cache-signing-key; do
  openssl rand -hex 32 > "/secure/modelling-storage/$name"
  chmod 644 "/secure/modelling-storage/$name"
done
export MODELLING_STORAGE_SECRET_DIR=/secure/modelling-storage
docker compose -f docker-compose.yml -f deploy/compose.storage.yml up -d --build --wait
```

The private parent directory protects host access. Compose mounts only each service's required files; the application never receives the owner password. PostgreSQL initialization installs the schema and grants `SELECT/INSERT` on audit events and limited nonce cleanup. Runtime connections cannot update, delete, truncate or alter audit tables. Triggers also reject ordinary owner mutations; a database superuser can still alter enforcement, so access controls and independent backups remain necessary.

`sslmode=disable` in this overlay applies only to the private Docker network on one host. For managed/remote PostgreSQL use `sslmode=verify-full` and a mounted CA path. For a remote cache use `rediss://`; TLS peer and hostname verification remain enabled.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GOVERNANCE_DATABASE_DRIVER` | `sqlite` | `postgres` for production/shared storage; the legacy default preserves existing installations |
| `GOVERNANCE_POSTGRES_DSN` | empty | `pgsql:host=governance-db;port=5432;dbname=modelling;sslmode=disable`; credentials/options are not accepted in the DSN |
| `GOVERNANCE_POSTGRES_USER` | `modelling_app` | Restricted runtime database role |
| `GOVERNANCE_POSTGRES_PASSWORD_FILE` | empty | Absolute mounted password file, at least 32 characters |
| `GOVERNANCE_DATABASE_PATH` | `/data/governance/audit.sqlite` | Used only by the SQLite driver or as an explicit migration source |
| `MODEL_CACHE_DRIVER` | `none` | `none` or `redis` (Valkey compatible) |
| `MODEL_CACHE_URL` | `redis://cache:6379/0` | Deployment-controlled destination; use `rediss` for remote TLS |
| `MODEL_CACHE_PASSWORD_FILE` | empty | Mounted cache password |
| `MODEL_CACHE_SIGNING_KEY_FILE` | empty | Separate mounted key for HMAC integrity of cached JSON |
| `MODEL_CACHE_TTL` | `300` | Cache lifetime, 1–86400 seconds |
| `MODEL_CACHE_NAMESPACE` | `openehr-models-v1` | Application/environment namespace |
| `MODELLING_STORAGE_SECRET_DIR` | required by overlay | Host directory containing the four generated secrets |

`GOVERNANCE_ENABLED=true` still enables governance operations. PostgreSQL connection and lock deadlines are bounded; the core never silently falls back to SQLite when PostgreSQL is unavailable. `php scripts/governance-storage.php check` verifies the configured database/schema without changing events. Run PHP commands inside the application container.

The automated server deployment enables this overlay when its private `config/storage/` secret directory exists. It builds first, starts dependencies, stops core writers, records a one-time verified cutover, and then starts the application. It refuses to fall back to a pre-PostgreSQL release after cutover. `scripts/prepare-postgres.sh` can run the same procedure with an explicit Compose argument vector. The application owner must retain the resulting private `postgres-migration.json` report.

## Preserve an existing SQLite ledger

Perform the cutover during a write maintenance window. Stop all core instances using the source ledger, make a consistent SQLite backup including committed WAL contents, and preserve model storage separately. Initialize an empty PostgreSQL destination, then run the migration command in a one-off application container with the database-owner identity and owner password file mounted **only for that command**:

```sh
php scripts/governance-storage.php import-sqlite /data/governance/audit.sqlite
```

The command is offline administration, not an HTTP/MCP capability. It verifies every source hash chain, locks the source and destination, copies canonical JSON bytes and all outstanding nonces, compares the complete histories, and commits atomically. Its JSON report records counts and a digest, never event contents or credentials. A populated destination is rejected; retrying cannot duplicate history. Keep the report and source backup. Enable the PostgreSQL runtime configuration only after successful verification. After accepting new PostgreSQL writes, recovery must restore PostgreSQL; switching to the old SQLite file would lose those events.

## Retrieval behaviour and invalidation

Git artifacts are cached by repository/tenant scope, project, path and exact commit. The repository still resolves the branch, fetches according to `MODEL_GIT_SYNC_SECONDS`, and checks reachability before serving a cached artifact. A local write, external fetched commit, deletion or branch change uses a different key. Existing Git fetch freshness bounds still apply. Historical revisions stay immutable.

Filesystem snapshots are read and hashed before a parsed snapshot cache lookup; disk access and permission checks still occur. SharePoint resolves its authorized project index and checks current drive-item access/containment before caching the immutable snapshot item/hash. Repository credentials and permissions are never cached. Each tenant-selected repository has a separate cache scope.

Cache values are bounded JSON with an authenticated key, expiry and payload; no PHP object deserialization is used. Forged, expired or evicted entries are rebuilt from the source. Cache connection/read failures have short deadlines and fall back to source reads. A missing model remains missing during a cache outage. Valkey uses a 128 MiB limit, `allkeys-lru`, no persistence and no durable application state. Signing-key rotation makes existing entries misses; ordinary expiry reclaims them without flushing another application’s keys.

## Backup, recovery and verification

Back up PostgreSQL with `pg_dump -Fc` or an operated physical/PITR backup policy, encrypt backups and restrict access. Preserve the owner/schema, event table, nonce state and source-repository revisions. Restore into an isolated database, run `php scripts/governance-storage.php verify` and the review checks, and verify tenant isolation before directing traffic to it. Cache backup is unnecessary; restart with an empty cache and warm through ordinary authorized reads.

Run `scripts/test-storage-container.sh` for a disposable real PostgreSQL/Valkey deployment. It verifies byte-preserving migration, conflict races, SQL immutability, least privilege, tenant boundaries, restart/nonces, real authenticated review requests, cache hits, poison rejection, eviction, external Git changes and unavailable-cache fallback. Evidence includes measured synthetic cold/warm Git retrieval times, with its workload and limitations; those timings are not a production capacity claim.

References: [PostgreSQL transaction and advisory locking](https://www.postgresql.org/docs/16/explicit-locking.html), [PDO PostgreSQL connection parameters](https://www.php.net/manual/en/ref.pdo-pgsql.connection.php), [Valkey eviction policy](https://valkey.io/topics/lru-cache/).
