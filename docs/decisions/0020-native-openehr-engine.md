# ADR-0020: Native openEHR engine behind an isolated service boundary

Status: accepted for the ADL 2/OPT 2 and AQL syntax profile.

The PHP modelling domain must use mature language processors without becoming coupled to JVM types or an AI provider. The prior [engine evaluation](../OPENEHR_ENGINE_EVALUATION.md) distinguishes ADL 2 compilation from legacy OET/OPT XML.

Use a language-neutral `OpenEhrEngine` port and an explicit authenticated JSON API. Archie 3.20.0 supplies ADL 2/AOM/BMM/RM validation and OPT 2 creation; openEHR SDK AQL 2.35.0 supplies the AQL grammar/AST. The Java sidecar binds to application-loopback and runs each bounded request in a disposable JVM, with fixed operations, finite memory, time and concurrency. It receives content and pinned dependency hashes, never executable code or retrieval URLs.

Reparse and validate compiled OPTs before returning success. Native source-archetype validators require per-archetype terminology scope inside an OPT; validation-only component views restore derived root/language fields and exclude Archie-generated HRID display aliases from local-code checks. Source bytes and the returned generated OPT remain unchanged. Preserve real errors and test nested archetypes, missing terms and invalid embedded RM types.

`template_compile` is computation only. `template_compile_project` reads explicit historical revisions and saves the native OPT and bounded compiler/source/dependency/report metadata atomically through `ModelRepository`. The build identifier depends on canonical inputs, selected engine and output hash; retries cannot overwrite a build. Repository evidence is not a signed governance attestation. No compiler operation grants human identity or approval.

Legacy OET/OPT XML, automatic CKM dependency selection, model-aware AQL validation and external Designer round trips require their own implementations and acceptance evidence. No format is silently relabelled or converted. An unconfigured optional engine returns an explicit error while other modelling operations remain available.
