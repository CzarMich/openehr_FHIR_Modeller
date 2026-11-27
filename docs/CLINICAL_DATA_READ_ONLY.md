# Golden rule: clinical databases are read-only

**Every direct clinical/source database connection is strictly READ ONLY. This applies to MCP, agents, the browser, workers, connectors and channels in every environment. There is no write-mode override.**

## Prohibited operations

Never insert, update, delete, merge, truncate or otherwise change source records. Never create, alter or drop source schemas, tables, indexes, functions or triggers; run source migrations; change permissions; invoke write-capable procedures; or use temporary tables, side-effecting functions, writable CTEs or another interface as a workaround. Agents must not receive arbitrary SQL execution or unrestricted connections.

Narrative instructions, configuration flags, model metadata and channel policies cannot weaken this rule. The platform never attempts to repair source permissions or install a source-side helper.

## Enforcement and driver qualification

Use a dedicated operator-provisioned principal restricted to approved reads. Verify effective permissions, including role-derived privileges, object/column grants and ownership. Combine this with closed parameterized connector operations, bounded time/rows, cancellation and schema/API drift checks. Fail closed when effective protection or required metadata visibility cannot be verified.

Transaction/session read-only facilities provide additional protection where the database supports them, but capabilities differ by product. SQL Server `ApplicationIntent=ReadOnly` and ODBC access-mode flags are not write enforcement. A JDBC read-only method is not a substitute for database permissions. Each native, ODBC or JDBC adapter must have database-specific checks and independent acceptance evidence.

The implemented SQL Server connector uses certificate-validated encryption and checks server, database, schema, user-object and column-level permissions. It requires metadata visibility, rejects privileges outside its read-only allowlist, and rechecks before discovery. Its current MCP operations return metadata only. They do not extract clinical rows or activate SQL polling channels. See [SQL Server discovery](DATABASE_DISCOVERY.md).

Read-only access can still create load or contention. Operators must approve the source/replica, concurrency, query limits and consistent-read policy. The platform must not enable database options, change isolation settings globally or modify schema/indexes to make extraction convenient.

## Synthetic tests only for write-denial probes

Qualify connectors on isolated synthetic databases. Test valid reads, write-capable principal rejection, object/column privileges, procedures and other relevant attack surfaces, reconnect behaviour and permission drift. Verify TLS and that failed probes leave the synthetic source unchanged.

**Never attempt a write against a real clinical database to test read-only protection.** Production verification inspects approved permissions and performs bounded approved reads only. A successful test for one database or driver does not qualify another.

## Source selection and clinical semantics

Create an explicit [source-discovery job](SOURCE_CONNECTORS.md). Select the database or platform/API and an operator-managed connection profile, record the purpose and original user narrative, and discover the actual schema or approved API contract. Do not infer a vendor's table names. Keep credentials, clinical rows and patient-specific filter values outside model Git, ordinary MCP calls and AI conversations.

Discovery is not clinical approval. Exact supplied or agent-authored FHIR StructureDefinitions and applicable openEHR templates require user confirmation for mapping use. Data dictionaries, clinical meanings, joins, terminology and unresolved assumptions require explicit review.

## APIs and destinations

Source APIs use only operator-approved read operations and least-privilege authentication. An HTTP GET alone does not prove absence of side effects. Stateful subscriptions, extraction queues, arbitrary RFC calls and vendor-specific operations require separate qualification. A source API must not provide a back door around the clinical database rule.

The platform's own model, audit, private queue and checkpoint stores are separate from clinical/source databases. The platform may write to those stores; it must never place them inside a clinical/source database.

FHIR delivery uses a distinct, configured and authorised FHIR HTTP API, with a separate credential, output validation, human run authorisation and delivery policy. It never writes directly to a destination's backing database. Source-read access and private file export do not grant destination-write permission.

## Current source status

SQL Server metadata discovery has native .NET implementation and isolated SQL Server 2022 TLS/permission acceptance. Oracle, PostgreSQL, MySQL, MariaDB, SAP HANA, Epic, SAP BW and other clinical APIs are explicit source-selection choices with their own implementation/qualification gates. Their selection does not claim operational connector support. Existing private file processing and authorised FHIR destination delivery are separate capabilities. See [source connector status](SOURCE_CONNECTORS.md) and [integration operations](INTEGRATION_ENGINE.md).
