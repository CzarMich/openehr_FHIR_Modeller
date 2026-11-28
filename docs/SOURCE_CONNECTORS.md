# Source selection and discovery jobs

Source discovery is an explicit job. A job records the selected source family, connector, operator-managed connection profile, project, purpose and original user narrative. It does not infer the database product from a vendor name, search for credentials, or grant permission to process patient records.

The platform distinguishes **selection**, **implemented metadata discovery**, **connector acceptance**, **clinical extraction**, and **deployment acceptance**. A selectable source is not automatically an implemented or qualified connector. The MCP reports these states separately and refuses to run unqualified connectors.

## Source catalogue

| Source | Family | Current executable discovery status |
|---|---|---|
| Microsoft SQL Server | Database | Native .NET metadata discovery; isolated SQL Server 2022 TLS/permission acceptance passed. An operator must still register and authorise the actual installation. |
| Oracle Database | Database | Managed ODP.NET metadata and private read adapter; TCPS/read-only checks. Actual installation acceptance required. |
| PostgreSQL | Database | Native Npgsql metadata/private reads with verified TLS and read-only repeatable-read transaction. |
| MySQL | Database | Native MySqlConnector metadata/private reads with strict read grants and consistent read-only snapshot. |
| MariaDB | Database | Independently selected adapter with MariaDB acceptance; shared protocol does not imply identical qualification. |
| SAP HANA | Database | Metadata/private reads through a checksum-pinned operator-installed SAP ODBC client; verified privileges and read-only transaction. |
| Epic Clarity (SQL Server/Oracle) | Database | Explicit engine selections using the corresponding native adapter and actual vendor dictionary. |
| Epic FHIR API | Platform/API | SMART backend RSA JWT/read scopes, capability/release checks and bounded read paging. Organisation registration and installation acceptance required. |
| SAP BW | Platform/API | Read-only approved OData query, metadata/analytic semantics and bounded v2/v4 paging; no stateful ODP subscription. |
| FHIR API | Platform/API | Exact release/capabilities, approved read paths and authenticated same-origin paging. |
| Clinical REST API | Platform/API | Explicit read contract, GET paths and JSON Pointers for records/next links. |

The native SQL Server connector does not require ODBC or a JVM. Other installations can require an ODBC driver or vendor JDBC `.jar`; driver artifacts must be operator-controlled, licensed, checksum-pinned and qualified. A model or MCP request cannot upload or choose arbitrary executable driver code. The HANA ODBC adapter is implemented; loading its licensed driver and accepting the actual installation remain required. Arbitrary JDBC execution is not exposed.

## Create and inspect a job

1. Select the modelling project and inspect `source_connectors`. Read the connector's qualification and execution status.
2. Have an operator register a connection profile under the correct tenant and project permissions. The profile contains credentials; the job contains only its opaque identifier.
3. Call `source_discovery_job_create` with the connector, profile ID, purpose and original narrative. Keep patient identifiers, patient-specific filters, secrets and clinical rows out of this record.
4. Read the resulting `PLANNED` job. Provide the installation's dictionary, provenance and other semantic evidence as appropriate modelling artifacts; state what remains unknown.
5. Call `source_discovery_job_run` with its exact current revision. A qualified connector performs metadata-only discovery and records a fingerprint and counts. A disabled or unqualified connector fails closed.
6. For a database source, use `source_database_discover`, `source_database_table` and `source_database_plan_check` with that explicit job ID. They return bounded metadata or a structural plan check, never clinical rows.
7. Review the proposed clinical meaning, joins, source grain, rules and exact destination models. Separate human confirmation is required before mapping; discovery completion cannot authorise an operational run.

Example planning call:

```json
{
  "project": "clinical-mapping",
  "connector": "sqlserver",
  "sourceProfile": "clinical-reader",
  "purpose": "Identify candidate sources for Observation and Condition",
  "userNarrative": "Use the actual vendor dictionary. Report uncertainty about subject identifiers, encounters, effective times, status and code systems. Do not include patient rows."
}
```

Use the returned job ID and revision, rather than constructing or guessing them. `source_discovery_jobs` lists jobs in an authorised project; `source_discovery_job_get` retrieves a selected job. These are versioned planning records in the model repository. They are not protected approval attestations, and editing a record cannot grant execution permission.

## Vendor schemas and clinical meaning

An ORBIS deployment backed by SQL Server selects the SQL Server connector and its actual connection profile. The vendor name does not establish table names. Discovery follows the real schemas, columns, keys and supplied dictionary. A physical relationship does not prove clinical equivalence or identify the correct timestamp, units, status or patient assigning authority.

Different source jobs preserve their own schema fingerprints and namespaces. Connecting several systems does not authorise cross-system patient matching or implicit joins. Cross-source identity linkage, duplication, encounter alignment and clinical reconciliation require explicit evidence and reviewed rules in the private processing boundary.

## Epic as a source

Treat Epic as a platform with organisation-enabled APIs, not as a universal database schema. An Epic installation must register the approved application and environment, use the authorised authentication flow and read-only scopes, inspect the actual capabilities, and pin the applicable FHIR release and profiles. Resource availability, search parameters, paging, rate limits and access rights depend on the installation and approved integration.

FHIR API extraction must preserve resource identity, version, references and source provenance. Paging must remain on approved origins; failed or partial pages cannot be reported as a complete dataset. Patient data and tokens remain in the private runtime. Bulk export, subscriptions and non-FHIR Epic interfaces are separate capabilities requiring explicit implementation and qualification. See [Epic's official documentation](https://fhir.epic.com/Documentation) and the [SMART App Launch specification](https://hl7.org/fhir/smart-app-launch/).

## SAP BW as a source

Select the actual BW/4HANA or BW installation, approved query/API, connection profile and intended clinical use. Record the query's grain, dimensions, measures, unit/currency fields, hierarchies, key dates, variables, filters, authorisation effects and aggregation rules. An analytic result is not automatically a patient-level clinical event. If the available grain cannot support an Observation or Condition, the job must report that limitation rather than invent detail.

An approved OData query can expose its entity model through `$metadata`; SAP-specific annotations can distinguish dimensions and measures. This is an integration option to qualify, not a guarantee that every BW query is exposed or that every installation supports the same interface. See [SAP's OData extraction documentation](https://help.sap.com/docs/SAP_BW4HANA/107a6e8a38b74ede94c833ca3b7b6f51/5876a040e7d94530b71db4597f9f61a0.html?locale=en-US) and [aggregation semantics](https://help.sap.com/docs/ABAP_PLATFORM_BW4HANA/cc0c305d2fab47bd808adcad3ca7ee9d/f352ab0a8fda4e3b8262927074f0b0c1.html).

Do not infer that access to BW authorises direct reads of its underlying clinical database or arbitrary RFC execution. Stateful extraction/delta APIs can maintain source-side subscription or queue state; those effects need explicit qualification against the read-only source policy. A request using HTTP GET is not, by itself, proof that it is free of side effects.

## Qualification required before operational use

Every connector needs positive TLS/authentication checks, negative permission tests on a synthetic fixture, bounded discovery/read behaviour, cancellation/timeouts, schema/API drift handling and secret/logging isolation. Clinical extraction additionally needs a consistent-read policy, stable identities and watermarks, paging/checkpoint recovery, reconciliation, provenance and installation-specific acceptance.

**Direct clinical/source database access is strictly READ ONLY, with no override.** API source connectors also use only explicitly approved read operations. Destination delivery has its own authorisation and credentials. Neither a source job nor a metadata fingerprint can approve FHIR StructureDefinitions, openEHR templates, clinical rules or delivery. See [the read-only policy](CLINICAL_DATA_READ_ONLY.md), [database discovery](DATABASE_DISCOVERY.md), [architecture](ARCHITECTURE.md) and [integration operations](INTEGRATION_ENGINE.md).

## Browser-managed private capture

See [Vendor integrations](VENDOR_INTEGRATIONS.md) for the end-to-end UI workflow, included drivers, source-plan controls, exact numeric cursors, bounds and remaining installation dependencies. Browser credentials stay in the owner-private encrypted vault. General MCP source jobs use separately registered operator profiles and expose structural metadata only. Neither path returns patient rows to an agent. Native database/API adapters are implementation capabilities, not a claim that an unprovided hospital system has been tested.
