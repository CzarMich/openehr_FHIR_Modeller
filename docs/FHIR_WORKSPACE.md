# FHIR and mapping workspaces

The browser adds **FHIR modelling** and **Cross-standard mappings** beside the existing openEHR Models, AQL and Governance workspaces. This is an authoring and validation client of the existing IG server. It does not host another public profile catalogue or publication service.

| Component | Responsibility |
| --- | --- |
| FHIR Git repository | Authoritative FSH/source, branches, commits, review history and provenance |
| Modelling workspace | Requirements, package discovery, reuse analysis, drafts, compilation, validation and mapping proposals |
| Existing IG server | Its established project lifecycle, IG builds, publication and artifact distribution |
| Runtime FHIR server | Operational resources and explicitly supported testing |
| Terminology server | Terminology lookup, expansion, validation and translation |

## Create a profile from authoritative packages

1. Sign in and choose **FHIR modelling → New FHIR project**. Select R4 (`4.0.1`), R4B (`4.3.0`) or R5 (`5.0.0`). Supply your actual canonical base, package ID/version and publisher. Set the independent Git URL, branch, root folder and private connection ID. The proposed artifact repository is `https://github.com/CzarMich/fhir_ig`; it remains editable.
2. Set exact dependencies as JSON, for example `[{"id":"hl7.fhir.r4.core","version":"4.0.1"}]` for an R4 project. Register preferred source IDs, URLs and priorities. Review the complete project change before confirming it.
3. Install configured dependencies through **Authoritative packages**. Search installed artifacts, inspect canonical URLs, package versions and provenance, and inspect dependencies. Installation failure or an incompatible release is a failure, never a silent version substitution.
4. Enter clinical requirements and use **Analyse requirements in chat** to retrieve sources and derive explicit typed constraints. **Discover reusable profiles** displays the backend's candidates, ranking evidence, recommendations and gaps. A sufficient existing profile should be reused.
5. For justified derivation, enter identifier/name, title and typed constraints, then **Generate draft FSH**. Generation uses the same backend as MCP. Source remains in the editor and generated-file selector; it is not automatically committed or published.
6. **Compile FSH with SUSHI**, select a generated resource and **Validate exact artifact**. Inspect executed tool evidence and diagnostics. Under **Synthetic example generation**, supply an example identifier and synthetic values keyed by element path. **Generate synthetic example** retains reported gaps rather than inventing missing clinical values. Validate the example using its target profile canonical and retained generated StructureDefinition. Editing source clears the displayed validation state; compilation alone does not establish FHIR conformance or clinical approval.
7. Inspect differential/snapshot elements, terminology bindings, slicing, invariants and Must Support flags. Use **Semantic comparison** against an earlier resource or parent. Use FHIRPath only through the backend processor.
8. **Review draft save** preserves the selected representation and optimistic revision. **Prepare Git commit in chat** uses the existing private Git connection, current revision and exact-change confirmation. A draft-store save is distinct from an external Git commit. FSH source and generated JSON remain separate.

XML imports retain their exact source bytes for saving and downloading. Semantic inspection, comparison and FHIR validation currently require JSON; create a separate JSON working copy and preserve its lineage to the XML original. An XML save does not establish conformance.

The profile inspector renders [StructureDefinition metadata](https://hl7.org/fhir/R4/structuredefinition.html) and [ElementDefinition constraints](https://hl7.org/fhir/R4/elementdefinition.html) from the retrieved resource. It does not infer missing snapshots or manufacture terminology assertions.

## Prefer a national source such as MII

Set the project's jurisdiction and configure the applicable national package/source with its **actual package ID and exact compatible version**, then install it. Do not substitute a guessed package ID or a moving `latest` version. Ask the assistant to inspect the configured national candidates, inherited constraints and terminology before selecting a parent. The same workflow supports organisation, international and project sources. National provenance is retained; imported material is never presented as locally authored.

## Submit to the existing IG server

Project connection IDs identify separate IG, runtime and terminology endpoints. **Inspect configured connections** and **Test IG server** return safe service diagnostics. Server credentials are administrator-managed deployment configuration; private Git credentials remain in Chat settings.

Use **List IG destinations** to retrieve actual target projects. The administrator configures the target project and Git link on the IG connection. Supply `{"paths":["input/resources/profile.json"]}` to submit saved resources, or `{"commitSha":"<exact 40-character commit>"}` for Git import. Both operations create drafts and open a review dialog for the exact request; cancellation performs no mutation. Complete build, clinical review and publication in the existing IG platform. Server-side authorization, validation evidence and governance policies remain authoritative. **Publication status** reports server evidence rather than assuming release after an upload. Only the configured existing server builds and distributes IGs. Development testing does not authorize production deployment.

## Analyse an openEHR model against FHIR

Choose **Cross-standard mappings**, select the FHIR project and **Inspect openEHR source in chat**. Retrieve exact model revisions and extract concept semantics, paths, cardinalities, units, terminology, context and repetitions. **Analyse mapping proposals** sends structured extracted source semantics and a requirement to the shared backend. Review candidates, transformations and gaps; similar names do not prove equivalence.

Mapping documents retain source and target standards, artifact/version/path, explicit relationship, transformation, terminology, provenance and revision. **Review mapping save** stores a provisional proposal. A dedicated mapping Git repository can be selected independently through Chat settings and **Prepare mapping Git commit**. Analysis does not modify openEHR models.

## Access and troubleshooting

Browser operations require the existing authenticated session, same-origin checks and CSRF token. Backend project access uses the installation's MCP principal and tenant/project authorization. Shared MCP service credentials do **not** imply private per-user FHIR project isolation. Private Git connection ownership continues to use the browser identity.

Mutation previews issue short-lived single-use tickets bound to identity and exact arguments. The server still checks installation write policy and backend permissions. Unknown actions fail closed. The conversational assistant uses the same action-aware mutation gating and the existing exact-change confirmation flow.

- **Service unavailable:** check the configured MCP service and FHIR capabilities; signing in alone does not install the engine.
- **Revision conflict:** load the current artifact/project before reconciling; never force a stale overwrite.
- **Dependency conflict:** inspect release, source and exact version; do not change the release to hide the problem.
- **Validator incomplete or failed:** inspect recorded execution and diagnostics. Unsupported checks or a failed tool are not validation success.
- **IG operation unsupported:** inspect the real receiving server contract and adapter configuration; do not invent an endpoint.
- **Connection credentials:** update protected server configuration or private Git settings. Never paste secrets into project JSON or chat.

Runtime patient-resource read/search is intentionally absent from the agent and this first browser workspace. A separately authenticated browser-only connection route is required before operational results can be displayed without entering model context. Current connection tools support metadata/testing and synthetic-resource validation where advertised.

## FHIR context and token budgets

The fork inherits the upstream [bounded task execution](TASK_EXECUTION.md): a small
tool-discovery interface, complete recent-turn budgets, lossless result paging,
private task handoffs, logical session rotation and independent review. FHIR tools
use the same permission and confirmation checks when called through discovery.

Within browser conversations, generated FSH, compiled resources and synthetic
examples return small file records with `draftId`, path, SHA-256 and byte count.
The exact source remains in the encrypted private project draft store. The model
can compile `files:[{path,draftId}]`, validate/inspect `{"draftId":"..."}`, add
`profileDraftIds` for exact target profiles, and compare `beforeDraftId` and
`afterDraftId` without retranscribing large StructureDefinitions. These references
are inside the tool's JSON `arguments`. Read complete bytes through
`workspace_checkpoint_read` when editing requires them. Existing confirmed
`personal_repository_save` accepts the same draft ID for a Git commit.

Conflicting supplied content, unavailable or another identity's draft, and draft
references on unsupported mutations are refused. Independent review requires
current repository artifacts and cannot load generator drafts by ID. The public
MCP contracts and direct browser editor keep their original content-based APIs.
A retained draft is private working state; Git remains engineering authority.

## Live Dev browser acceptance

The opt-in `chat/test/fhir-live-smoke.mjs` script uses a real isolated loopback Dev
deployment and an MFA-enabled synthetic account. It creates its own FHIR project,
exercises confirmed saves, real SUSHI and HL7 validation, rejects an invalid example,
checks reload persistence, and records sanitized evidence and screenshots. It never
publishes or writes to a runtime server.

```bash
FHIR_DEV_ACCOUNT_FILE=/private/dev-account.json \
  node chat/test/fhir-live-smoke.mjs
```

The private account JSON supplies `username`, `password`, `totpSecret` and
`origin`. Keep it outside Git with mode 0600. Evidence defaults to
`test-results/fhir-live`; set `FHIR_BROWSER_EVIDENCE_DIR` to change the output.
FHIR requests allow the bounded validator run to return its evidence; timeout
errors do not imply validation success or authorize repeating a confirmed mutation.
