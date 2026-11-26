# Golden rule: clinical databases are read-only

**Every direct clinical/source database connection is read-only. This applies to
the MCP server, agents, browser, processing workers, connectors and integration
channels, in development and production. There is no write-mode override.**

## Prohibited operations

Never insert, update, delete, merge, truncate or otherwise alter clinical/source
records. Never create/alter/drop schemas, tables, indexes, functions or triggers;
run migrations; change database permissions; invoke write-capable procedures; or
use side-effecting functions, writable CTEs or temporary tables as a workaround.
Do not give agents arbitrary SQL execution or an unrestricted database connection.

## Adapter contract

A database adapter must use a dedicated least-privilege read-only account and
server-enforced read-only transactions/sessions. Verify the effective protection
before reading. If the driver/server cannot enforce the required read-only mode,
or the credential has forbidden privileges, reject the connection. Configuration,
tool arguments, narrative instructions and channel policies cannot weaken this rule.
A routing hint or a SQL keyword check alone is insufficient enforcement.

Expose only bounded schema inspection and authorised reads through approved,
parameterised query plans. Separate identifiers from values, constrain accessible
schemas/tables, bound time/rows and support cancellation/checkpoints. Discovery
must not create a table, install a helper or change the source schema. Credentials
are operator-managed; agents do not discover them.

Prove each advertised driver with an isolated synthetic database, including
read/write-role rejection, writable CTE/procedure/function attacks, transaction
settings, rollback/reconnection and privilege changes. **Never test the boundary
by attempting a write against an actual clinical database.** No SQL driver may be
claimed supported before its implementation and negative tests pass.

## Data and destination boundaries

Operational records stay in the private processing runtime. Source database rows
do not enter model Git repositories, general MCP/AI conversations or ordinary logs.
The platform may maintain its own separate model, audit, queue and checkpoint
storage; that does not authorise writes to a clinical/source database.

FHIR delivery is a distinct operation through a configured, authorised FHIR HTTP
API. It requires its own destination credential, validation and delivery policy.
Never connect directly to or modify the FHIR server's backing database. A source
connection or source credential cannot be repurposed as a destination writer.
Exporting files likewise does not grant destination-write permission.

## Current implementation status

The current source preview supports synthetic CSV/custom JSON; SQL extraction is
not implemented. Existing CDR access is through bounded read-only queries. Future
database connectors and channel execution must comply with this policy before
being enabled or documented as supported.
