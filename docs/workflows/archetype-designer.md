# Working with Archetype Designer

Use the platform's **Models**, **Chat** and **Governance** tabs in one browser window. The current model browser reads repository files; a dedicated upload/import wizard and governed handoff bundle are not yet implemented. Use a file-capable MCP client or the configured Git repository for file exchange.

1. Export a model using an operation actually available in your Designer account. Preserve its original file and record the tool/version, external revision, filename and hash.
2. Inspect exact source bytes with `model_import_inspect`, then preserve them through `model_artifact_import`. Supply externally provided tool/revision/licence details as unverified `sourceClaims`; retain the protected receipt. A direct Git commit remains a repository revision and does not automatically establish platform import provenance. Do not rename authoring JSON into an openEHR format.
3. Retrieve it with `model_artifact_get` and inspect the exact revision in **Models**. Use `model_validate` for the declared XML/OET/OPT profile, or native `archetype_validate` for ADL 2 and `template_validate` for ADL 2 or supported OET with exact dependencies. Validation levels remain distinct.
4. Keep the original unchanged. Make changes in a separate ordinary DRAFT path with the observed `expectedRevision`; dedicated working-copy derivation tooling is still pending. If another modeller changed the model, retrieve that revision and reconcile explicitly. The current XML diff does not establish full semantic equivalence.
5. For ADL 2 or [supported OET](../LEGACY_OPT_COMPILATION.md), supply exact matching-format archetype dependencies to `template_compile_project`. Inspect the native output format, build metadata, profile and unexecuted checks. Designer `.t.json` is not accepted by either compiler.
6. Prepare the exact revision for human review through **Governance**. Source, findings and review state remain independent. A Git review or compiler success is not clinical approval.
7. Retrieve the intended native revision and confirm its SHA-256 before external import. Select a format your actual Designer account supports. Record which file/revision was transferred; the full automated handoff manifest/receipt service is not yet available.
8. Re-export from Designer and import it with its external revision claim, preserving a separate original and receipt. Compare identifiers, nodes, constraints, paths, languages, bindings, annotations, slots and dependencies. Unexecuted comparison dimensions remain unverified; report observed losses explicitly.

Git teams can work on a configured branch and use `model_repository_diff` and `model_review_request` where the hosting provider is configured. The assistant's plain model files and sidecar metadata preserve native tool access. Do not place integration credentials in the model repository.

See [manual import and configuration](../MODEL_IMPORTS.md), [compatibility evidence and limits](../ARCHETYPE_DESIGNER_COMPATIBILITY.md), [Git workflow](shared-git-models.md), [compiler deployment](../OPT_COMPILATION.md), and [exchange implementation queue](../EXTERNAL_MODELLING_REQUIREMENTS.json).
