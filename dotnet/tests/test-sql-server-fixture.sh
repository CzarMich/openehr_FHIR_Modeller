#!/usr/bin/env bash
# CI ONLY: creates/destroys an ephemeral synthetic SQL Server, never a supplied clinical endpoint.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'Run SQL fixture on hosted CI only.' >&2; exit 2; }
fixture_dir=$(mktemp -d)
fixture_name="modeller-sql-fixture-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
fixture_password="Synthetic_$(openssl rand -hex 16)!"
cleanup() { docker rm -f "$fixture_name" >/dev/null 2>&1 || true; sudo rm -rf "$fixture_dir"; }
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj '/CN=Modeller Synthetic Fixture CA' -keyout "$fixture_dir/ca.key" -out "$fixture_dir/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' -keyout "$fixture_dir/server.key" -out "$fixture_dir/server.csr" >/dev/null 2>&1
cat > "$fixture_dir/extensions" <<'EXT'
subjectAltName=IP:127.0.0.1,DNS:localhost
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EXT
openssl x509 -req -sha256 -days 2 -in "$fixture_dir/server.csr" -CA "$fixture_dir/ca.crt" -CAkey "$fixture_dir/ca.key" -CAcreateserial -extfile "$fixture_dir/extensions" -out "$fixture_dir/server.crt" >/dev/null 2>&1
cat > "$fixture_dir/mssql.conf" <<'CONF'
[network]
tlscert = /var/opt/mssql/fixture.crt
tlskey = /var/opt/mssql/fixture.key
forceencryption = 1
tlsprotocols = 1.2
CONF
sudo chown 10001:0 "$fixture_dir/server.key"
sudo chmod 400 "$fixture_dir/server.key"
export MSSQL_SA_PASSWORD="$fixture_password"
docker run -d --name "$fixture_name" --memory=2304m --cpus=2 -p 127.0.0.1:19433:1433 \
  -e ACCEPT_EULA=Y -e MSSQL_PID=Developer -e MSSQL_SA_PASSWORD -e MSSQL_MEMORY_LIMIT_MB=1536 \
  -v "$fixture_dir/mssql.conf:/var/opt/mssql/mssql.conf:ro" \
  -v "$fixture_dir/server.crt:/var/opt/mssql/fixture.crt:ro" \
  -v "$fixture_dir/server.key:/var/opt/mssql/fixture.key:ro" \
  mcr.microsoft.com/mssql/server:2022-latest@sha256:4525e3efac9f3e241cb003bb2ff2a82818b502f37e12049d788b1a9fa7e13b7f >/dev/null
ready=false
export SQLCMDPASSWORD="$fixture_password"
for attempt in $(seq 1 90); do
  if docker exec -e SQLCMDPASSWORD "$fixture_name" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -Q 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Synthetic SQL Server startup failed.' >&2; docker logs --tail 30 "$fixture_name"; exit 1; }
# Trust only this process's fixture CA. Production connection validation is not bypassed.
SSL_CERT_FILE="$fixture_dir/ca.crt" MODELLER_SQL_SYNTHETIC_FIXTURE=ephemeral-loopback-only \
 MODELLER_SQL_FIXTURE_PASSWORD="$fixture_password" MODELLER_SQL_FIXTURE_PORT=19433 \
 dotnet run --project dotnet/Modeller.Database.Tests -c Release -- --synthetic-sql-fixture
