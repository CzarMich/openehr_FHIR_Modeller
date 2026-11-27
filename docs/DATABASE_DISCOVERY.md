# SQL Server schema discovery

The platform discovers the schema that exists in the connected installation. It does not assume ORBIS table names, a universal vendor data model, or a one-to-one relationship between a table and a FHIR resource.

## What discovery provides

An operator registers a SQL Server connection for an exact tenant and a set of projects. Authorised clients can search table and column names, inspect columns, nullability, primary keys and declared foreign keys, and check a proposed selection against the discovered schema fingerprint. The tools are `source_database_discover`, `source_database_table` and `source_database_plan_check`.

Search is paged so an agent can explore a database containing hundreds of tables without placing its entire catalogue in a prompt. Table detail is paged in batches of 100 columns. Discovery reads SQL Server system catalogues; it does not return clinical rows, sample values, patient identifiers, free text, or credentials. Table and column names themselves can contain sensitive information: operators must authorise disclosure of this metadata to their chosen model provider.

For example, to design an Observation mapping, the agent can identify candidate result, subject, encounter, code, unit, status and effective-time columns from the actual metadata and the supplied data dictionary. A foreign key establishes a declared database relationship. It does not establish that a timestamp is the clinical effective time, that a subject identifier has the required assigning authority, or that a particular status means a final result. Those meanings must be supported by the installation's documentation and confirmed by the user.

The original user narrative, proposed interpretation, evidence and unresolved assumptions belong in the versioned modelling project. Missing keys, unclear meanings and incomplete dictionaries must remain explicit; they must not be replaced with invented table names or clinical assumptions. Exact supplied FHIR StructureDefinitions and applicable openEHR templates require user confirmation before mapping use. Agent-authored models also require user confirmation. A schema check does not grant either clinical approval or permission to run an extraction.

## Golden rule: clinical databases are read-only

**Clinical and source database access is strictly READ ONLY. The platform must never insert, update, delete, alter a source schema, migrate a source database, change permissions, or invoke a write-capable source procedure. There is no user or agent override.** Writes to the platform's own private model, audit and job stores are separate from clinical/source database access. Authorised delivery of generated FHIR resources to a configured destination is also a separate, explicitly controlled operation.

The SQL Server connector uses encrypted connections with certificate validation and an operator-provisioned read-only database principal. It refuses effective server, database, schema or user-object permissions outside its read-only allowlist; it also checks column-level update/reference grants and requires `VIEW DEFINITION` so metadata visibility cannot silently hide user objects from these checks. Permission checks run when a connection opens and before discovery. It never repairs or grants permissions itself. Operators must provision and maintain source credentials with no write authority, including permissions obtained through roles and other databases accessible to that login.

`ApplicationIntent=ReadOnly` is only a connection hint. It is not the security boundary. Likewise, ODBC read-only mode is a driver indication, and SQL Server JDBC `setReadOnly` does not enforce a read-only transaction. Database permissions and the closed connector operations remain mandatory for any future driver adapter. See [Microsoft's ODBC connection attribute documentation](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetconnectattr-function?view=sql-server-ver17), [SQL Server JDBC setReadOnly](https://learn.microsoft.com/en-us/sql/connect/jdbc/reference/setreadonly-method-sqlserverconnection?view=sql-server-ver17), and [effective permission inspection](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/sys-fn-my-permissions-transact-sql).

The query-plan checker generates a bounded parameterized `SELECT` shape from discovered object and column IDs. It accepts declared, enabled, trusted foreign-key joins and rejects arbitrary SQL, computed columns, unjoined tables, unsupported filters, invalid output field names and a changed schema fingerprint. Identifiers are quoted, values are bound parameters, and a root primary key is required. Structural acceptance still requires a separate review of clinical meaning and join cardinality. It is not evidence that an extraction will produce clinically correct records.

## Registering a connection

Set `SOURCE_DATABASE_ENABLED=true` and `SOURCE_DATABASE_PROFILES_DIR` to an absolute operator-controlled directory. Discovery is disabled by default. A profile named `clinical-reader` is read from `clinical-reader.json`; the profile ID cannot be a path or URL. Profiles contain only these fields:

```json
{
  "host": "sql.example.internal",
  "port": 1433,
  "database": "ClinicalReadReplica",
  "user": "modeller_reader",
  "password": "PROVISION_THROUGH_YOUR_SECRET_MANAGER",
  "tenant": "shared",
  "projects": ["clinical-mapping"]
}
```

Use the actual tenant identifier when tenant isolation is enabled. Store the file with mode `0400` or `0600`, accessible only to the application identity, on a protected read-only mount. Symbolic links and files readable by group/others are rejected. If the secret manager uses projected symlinks, stage the specific file into a private volume through an operator-controlled init step with the required ownership and permissions. Do not commit profiles, paste them into chat, or include them in model artifacts. Install the organisation's SQL Server CA in the runtime trust store; disabling certificate validation is not supported.

Clients supply only the project and profile ID, never credentials or a connection string:

```json
{"project":"clinical-mapping","sourceProfile":"clinical-reader","query":"result","limit":25}
```

Use the returned fingerprint and table IDs for subsequent inspection. Metadata changes invalidate a proposal pinned to the old fingerprint.

## Driver and execution status

The implemented connector is native .NET `Microsoft.Data.SqlClient`, pinned with a dependency lockfile. It is intended for SQL Server installations compatible with the queried catalogues; the isolated acceptance fixture targets SQL Server 2022. This document does not establish acceptance against a particular ORBIS installation.

ODBC and vendor JDBC `.jar` adapters are not yet exposed by these tools. They require separate driver qualification, operator-controlled artifacts and checksums, suitable licensing, and the same database-side permission checks. An agent must never upload or load an arbitrary driver library. A SQL Server deployment using the native provider does not require ODBC or a JVM solely for database access.

These tools implement metadata discovery and structural plan checking. They do not extract clinical rows or create a database polling channel. Private extraction, consistent snapshots, stable watermark checkpoints and approved terminology enrichment must pass their own acceptance gates before database channels can be enabled. Existing file-source integration and authorised FHIR destination delivery are documented in [Integration engine](INTEGRATION_ENGINE.md).

## Verification

`dotnet run --project dotnet/Modeller.Database.Tests -c Release` tests vendor-specific identifiers, declared joins, parameterization, schema drift, unsafe plans and operator profile isolation using synthetic metadata.

`dotnet/tests/test-sql-server-fixture.sh` is restricted to hosted CI. It creates an ephemeral SQL Server with a temporary CA, synthetic tables and dedicated test logins. The acceptance test verifies certificate validation, discovered metadata, rejection of write-capable principals, permission drift, and database-side denial of DML, DDL and a write-capable procedure. **Never run write-denial probes against a real clinical database.** Inspect the actual CI result before describing this connector as qualified; unit tests alone do not establish database security or clinical correctness.
