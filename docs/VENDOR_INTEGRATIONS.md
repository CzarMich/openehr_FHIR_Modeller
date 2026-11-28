# Vendor sources and private extraction

This guide describes the vendor-adapter implementation. Check the deployed revision and its acceptance evidence before relying on a capability. A successful connection or synthetic fixture does not establish clinical correctness or acceptance against a hospital installation.

## Supported interfaces

| Selection | Adapter | Required installation evidence |
|---|---|---|
| SQL Server | Native Microsoft.Data.SqlClient, validated TLS, effective permission checks | Actual read-only account, permitted schemas and dictionary; snapshot isolation already enabled for private extraction |
| Oracle | Managed ODP.NET over TCPS, effective privilege checks, read-only transaction | Trusted certificate configuration, read-only principal, service name and actual schema/dictionary |
| PostgreSQL | Native Npgsql, certificate/hostname verification, read-only repeatable-read transaction | Read-only account without object ownership, write/create/temp/admin rights; permitted schemas |
| MySQL | Native MySqlConnector, verified TLS, read-only consistent snapshot | Direct read-only grants, InnoDB tables and permitted schemas; unexpanded role grants fail closed |
| MariaDB | Independently selected MySqlConnector adapter and read-only checks | MariaDB installation acceptance, direct read grants and InnoDB tables |
| SAP HANA | System.Data.Odbc with the installed SAP client, checksum verification, verified TLS, effective privileges and read-only transaction | Licensed SAP HANA ODBC client installed by the operator, exact checksum, trusted CA, catalog visibility and read-only account |
| Epic Clarity on SQL Server | SQL Server adapter with an explicit Epic source selection | Approved Clarity access and the installation's actual table dictionary; no universal Epic table layout is assumed |
| Epic Clarity on Oracle | Oracle adapter with an explicit Epic source selection | Approved Clarity access and actual Oracle service/schema/dictionary |
| Epic FHIR | FHIR CapabilityStatement/release checks, SMART backend RSA JWT or configured HTTPS credentials, bounded authenticated paging | Organisation application registration, mapped backend account, approved endpoints/read scopes and actual resource permissions |
| FHIR API | Release-pinned capabilities and read-only searches | Actual R4/R4B/R5 endpoint and approved resource/search contract |
| SAP BW | OData metadata plus v2/v4 result paging; original annotations and unit fields retained | Approved query with no subscription/delta side effects; grain, dimensions, measures, units and filters supplied explicitly |
| Clinical REST API | Approved GET paths and declared JSON Pointers for records/next links | Documented read-only API contract and actual authentication/paging semantics |

Native SQL Server and Oracle do not require a JDBC `.jar`. Oracle trust/wallet configuration can be installed under the operator-controlled `MODELLER_ORACLE_TNS_ADMIN` directory; credentials and service/schema selection remain in the UI. HANA's proprietary ODBC client is an installation dependency: it is not downloaded from an arbitrary URL or uploaded by an agent. The operator sets its installed path through `MODELLER_HANA_ODBC_DRIVER`; the UI records the expected SHA-256. The runtime refuses a missing or mismatched driver. JDBC execution, arbitrary drivers, RFC calls and automatic SAP client licensing are not implemented.

The adapter code is C#/.NET. The separate `Modeller.Extraction` executable owns source drivers and source reads. `Modeller.Core` and the file-mapping worker remain free of clinical database drivers.

## Configure through the browser

Open **Integration → Vendor connections** and select a project. An authenticated administrator or approver with the required project permission manages source connections and read plans. Monitoring grants do not permit source configuration or patient reads.

1. **Configure a connection.** Select the database/platform explicitly. Enter a display name, stable patient identity domain and the database or API fields. Database schemas form an explicit allowlist. For Epic select the actual Clarity engine or FHIR interface. For HANA provide the installed driver's checksum. TLS and certificate validation cannot be disabled.
2. **Review and confirm.** The review shows non-secret connection settings and binds the exact credentials/configuration by hash. Credentials and signing keys are not returned in review responses. They are encrypted in an owner-bound vault using a purpose-derived key from the existing operational encryption key; no AI-provider account or new user-supplied key is required. Back up that original key with the vault. Configuration does not authorise a clinical read.
3. **Connect and discover.** Review the real catalogue or API capabilities. Database results support table/column searches and bounded detail pages. Use actual IDs and the returned fingerprint; do not infer meanings from vendor-specific names. Discovery returns no patient rows or sample values. Table overview pages contain counts; request a specific table and page its columns when needed, keeping agent context small. To let your browser modelling agent use `clinical_source_metadata`, explicitly enable metadata sharing for this connection. Sharing is off by default, can be revoked in the UI and never exposes credentials, patient reads, approvals or channel operations.
4. **Define a read plan.** Select discovered table/column IDs, aliases, declared joins, typed filters and a bounded limit, or an exact approved API read path. Record the source window, grain, selection rationale and assumptions. For identifiers stored as numeric columns, explicitly choose `"representation":"string"` when the source contract requires an identifier string; no leading zeros are invented.
5. **Review and confirm the plan.** A metadata-only plan check runs before confirmation. The confirmed plan is immutable. A revision requires a new source connection, preserving existing channel pins and evidence.
6. **Capture privately.** Read the approved window into private intake. The extractor publishes a snapshot only after the entire configured window and all its pages succeed. Incomplete, oversized, ambiguous or changed inputs fail explicitly. Empty results do not create a misleading clinical job.
7. **Assign a mapping/channel.** Select the resulting source under **Source data**, supply its source contract and applicable target models, confirm the mapping and choose export or separately authorised FHIR/openEHR HTTPS delivery. See [integration operations](INTEGRATION_ENGINE.md) for polling, Kafka, ordering and recovery. Channels reuse deterministic rules and source snapshots without a model call per record.

Connection verification, read-plan authorisation, model/mapping confirmation, clinical approval and destination authorisation are separate decisions. A supplied FHIR profile or openEHR template must still be provided as actual content and human-confirmed for the mapping. No vendor connector can approve it automatically.

## Read plans and continuous capture

The compiler generates only bounded, parameterised `SELECT` statements from the discovered catalogue. There is no arbitrary SQL box, stored-procedure operation, schema migration or source permission repair. Computed columns, unsupported types, undeclared joins and changed fingerprints fail closed. Base tables are the database discovery boundary; views and their implicit procedural semantics are not assumed safe.

A complete bounded snapshot reads one reviewed source window. The extractor requests an extra row to detect truncation. A window larger than its limit is rejected rather than reported as complete. Narrow the approved window or use the supported append-only mode. Snapshots and API extracts remain subject to explicit record, byte and time bounds; no connector promises an unlimited read in one run.

Append-only database capture requires a unique native numeric root key, a projected cursor field and explicit confirmation that **committed visibility is strictly increasing**. An identity/sequence column alone does not establish that guarantee. Only joins that preserve one row per root key are allowed. The private cursor advances after the captured file and evidence are durable. Cursor values remain private and do not enter shared monitoring or AI context. Updates, deletions, late commits below the cursor, CDC/binlog/SCN feeds and general bidirectional database replication require a separately implemented and accepted change-feed/reconciliation contract; do not use append-only mode for those semantics.

A channel can continue admitting later snapshots while earlier records wait for a Patient or Encounter. Patient registration trust, assigning authorities, verified dependencies and pseudonymisation remain enforced by the mapping runtime. A vendor source does not bypass these gates.

## API and Epic authentication

API sources use exact HTTPS base URLs and explicitly approved read paths. Credentials are sent only to the configured origin; redirects are refused. Paging must stay within the approved origin/base and collection paths. Cycles, partial pages, duplicate FHIR resource versions and inconsistent totals fail explicitly. Original response pages are retained encrypted with page hashes; resources keep their source identity/version fields. Private manifests link captures to the source configuration and read-plan pins.

Epic SMART backend configuration requires the registered client ID, token endpoint, registered key ID, private RSA key, supported signing algorithm and organisation-approved read scopes. Assertions use the exact token audience, short lifetime and fresh nonce. Token exchange is an authentication POST; source data operations remain GET reads. Tokens are cached only for their bounded lifetime and refreshed as required. Authentication or unsupported scopes fail closed. An application registration does not grant access until the Epic organisation completes its setup.

Generic REST sources specify JSON Pointers for the records array and next-page link. An empty records pointer selects a root array; an absent next pointer declares a non-paged endpoint. These declarations must match the actual API contract. A GET method alone is not proof that an operation has no side effects.

For BW, supply the analytic contract and preserve dimensions, measures, units, hierarchies and filters from `$metadata` and the query definition. An aggregated result is not automatically a patient-level Observation or Condition. ODP subscriptions and stateful delta initialisation are outside this read-only adapter.

## Golden rule and privacy

**All clinical/source database access is READ ONLY, without an override.** The platform does not write clinical rows, alter schemas, enable snapshot isolation/CDC, grant permissions or invoke write-capable procedures. Session/transaction controls only establish the read context. The database administrator must provision and maintain the required read-only principal. Unknown or unverified permissions stop the connection.

Credentials, patient rows, private cursors, source pages and job findings stay outside general MCP responses, model Git, provider conversations and reusable AI memory. MCP discovery returns bounded structural metadata only; metadata itself can be sensitive and needs disclosure permission. Browser source configuration is owner/project scoped. Shared channel view/monitor grants expose operational summaries only.

Platform vaults, checkpoints and retained source evidence are internal application state. Destination FHIR writes use a separate credential and authorisation. They never use a source database connection or the FHIR server's backing database. Volume/backup encryption, key backup and controlled retention remain operator responsibilities. Never replace encryption keys or delete preserved inputs to bypass a hold or storage limit.

## Acceptance and troubleshooting

Use synthetic acceptance before installation testing. The vendor tests cover dialects, signing, actual HTTP paging and private browser orchestration. Disposable PostgreSQL/MySQL/MariaDB fixtures exercise real TLS and source reads without clinical data or source-write probes. Oracle, HANA, Clarity and the organisation's Epic/BW endpoints still need their actual drivers, permissions and installation acceptance; fixture results cannot substitute for those systems.

Typical failures are explicit: missing HANA driver, certificate failure, unverified write permissions, snapshot isolation required, changed schema, an incomplete source window, unapproved API path or ambiguous paging. Fix the source contract/installation, create a reviewed new configuration when needed and resume deliberately. Do not disable TLS, weaken the read-only checks or blindly retry uncertain destination writes.

See [source discovery](SOURCE_CONNECTORS.md), [read-only policy](CLINICAL_DATA_READ_ONLY.md), [integration operations](INTEGRATION_ENGINE.md), [patient identity](HL7_AND_IDENTITY.md), [security](SECURITY.md) and [testing](testing.md).

Authoritative interface references: [SAP HANA read-only transactions](https://help.sap.com/docs/SAP_HANA_PLATFORM/4fe29514fd584807ac9f2a04f6754767/20fdf9cb75191014b85aaa9dec841291.html), [SAP effective privileges](https://help.sap.com/docs/PRODUCT_ID/4fe29514fd584807ac9f2a04f6754767/20a2f3ea75191014a4c1d9b0859b9917.html), [Oracle read-only transactions](https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/SET-TRANSACTION.html), [PostgreSQL transaction controls](https://www.postgresql.org/docs/current/sql-set-transaction.html), [Epic backend services](https://fhir.epic.com/Documentation), [SMART backend services](https://hl7.org/fhir/smart-app-launch/backend-services.html), [FHIR R4 bundles](https://www.hl7.org/fhir/R4/bundle.html) and [SAP OData semantics](https://www.sap.com/Protocols/SAPData).
