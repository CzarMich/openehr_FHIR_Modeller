# Optional CDR adapters

The optional [AQL workspace and CDR integration](CDR_WORKSPACE.md) provides a generic openEHR REST adapter, private connection settings and read-only query execution. The core starts and supports modelling without a CDR connection.

`CdrAdapter` separates Query and Definition API access from modelling, terminology and artifact storage. `CredentialResolver` separates encrypted profile credentials and administrator environment references from the adapter. Future adapters implement these boundaries without changing the workspace.

The shipped adapter executes parameterized AQL and reads remote template definitions. It does not create, modify or delete compositions or deploy templates. Execution requires a configured connection and an explicit request. MCP returns counts and timing; result rows are visible only through Run in the browser. Query history stores text and metadata independently of results. Never invent results for a query that was not run.

Native syntax and exact-template path validation work without a CDR. Unsupported or unresolved paths remain INCOMPLETE. The model repository is not a patient-data store; remote definitions remain separate from local models. See the [workspace guide](CDR_WORKSPACE.md) for configuration, privacy controls, supported APIs and verification.
