# Reuse, project memory and AI cost control

The platform should retrieve verified work before asking a model to generate it again. Reuse is a deterministic product operation; it does not require a language model. Persistent project artifacts, exact model bytes, versioned rules and protected human decisions remain the authority. Chat history and model summaries are supporting context.

## What is implemented

- The browser already caches encrypted immutable repository/model reads with identity, connection, credential fingerprint and exact revision in the key. It rechecks repository access before using a cached result. Credential changes, expiration and eviction invalidate entries. Patient records, CDR query/results, secrets and authorisation decisions are excluded from this cache.
- Private checkpoints retain generated drafts and completed modelling evidence for recovery. Interrupted work can retrieve these rather than regenerate it. Current repository state, access and uncertain writes are checked again; historical evidence is not a current approval.
- The C# mapping registry can find exact-context saved drafts and currently confirmed mappings through `modelling_mapping(action=reuse)`. The browser exposes **Integration workspace → Reuse verified work and save AI calls → Find existing work without AI**. Search and loading a saved mapping make no model-provider call and do not start processing or delivery.
- Corrections are recorded as new immutable mapping versions with original user requirements, rule interpretations, assumptions and examples. After human confirmation, the new exact version can be found for subsequent work. This is governed reuse of accumulated project work, not autonomous model training.

These are feature-branch capabilities until the release is deployed. Existing mappings without a reuse context remain available for manual inspection. They are not silently retrofitted with invented context or new approval.

## Matching and invalidation

When preparing a mapping, optionally include `reuseContext` with the stable source system/profile identifier, verified source dictionary/meaning version, intended purpose and exact external terminology snapshots. Review that context alongside the models and rules before confirming. Each terminology pin contains its canonical, exact version and content SHA-256. An empty list means no external terminology snapshot dependency; embedded mapping dictionaries remain part of the exact mapping bytes. Do not invent versions or hashes to obtain a match.

The server binds that context to the actual mapping source-schema hash, the original requirements and their basis, and a hash of the installed mapping runtime. Requirement labels alone do not affect reuse; original text, basis and order do. Source schema structure alone does not establish source meaning, so a verified meaning/dictionary version and intended use are also required.

Reuse queries require the current context, schema fingerprint, exact supplied model keys, direction and original requirements. Matches stay inside the currently authorised project. The server verifies immutable mapping/model identities and the protected decision chain again. A revoked or unconfirmed mapping is returned as existing work requiring confirmation, never as approved execution.

Changed source meaning/version, purpose, schema, original requirements, terminology pins, model selection or runtime prevents an exact reuse match. That does **not** mean AI generation is required: inspect existing work, make the necessary targeted change, rerun deterministic checks and confirm the new version. An old validation report does not qualify a new runtime or changed input.

Search is bounded to 2,000 stored definitions, 16 MiB of inspected definition bytes and at most 50 returned candidates. The response reports whether traversal completed. A limited search or a missing match is not proof that the organisation has no reusable work.

## Browser and MCP workflow

1. Choose the project and actual supplied models. For private files, schema inspection can fill the schema SHA-256 without placing record values in the form or AI context.
2. Enter the stable source identifier, verified meaning version, purpose and original instructions. Separate individual user instructions with blank lines. Use the advanced terminology snapshot field when applicable. The MCP action can also represent mixed user-instruction, declared-fact and inferred-proposal requirements without changing their provenance.
3. Select **Find existing work without AI** and inspect a saved candidate. The display distinguishes a currently confirmed exact match from a draft requiring human confirmation.
4. To make a new mapping discoverable later, select **Include this source/purpose/terminology context** before preparing and human-confirming it. Adding or changing context on an existing immutable mapping requires a new mapping version.
5. Run through the normal preview/channel workflow. Processing still rechecks source structure, exact model/rule confirmation, validation and destination authorisation. Reuse lookup does not move records, approve a profile, confer clinical approval or authorise a FHIR destination.

The assistant instructions and MCP tool description direct agents to inspect existing work and use the reuse action before drafting. This reduces unnecessary generation; the system does not claim that a prompt alone guarantees all future provider calls will be avoided.

## Privacy and trust

**Every direct clinical/source database connection is read-only, without an override.** Project memory, caches, job state and learned proposals are stored in the platform's own protected storage; none is written into a clinical source database.

Do not put patient records, identifiers, credentials or clinical query results into reuse context, narratives, examples, general MCP or model-provider memory. Only approved non-patient modelling metadata belongs there. Metadata can itself be sensitive and remains subject to project access. Channel monitoring grants do not grant project/model access or expose this memory.

This feature does not fine-tune provider models, share learned rules across customers/projects, infer clinical equivalence, or automatically promote corrections into approved rules. A curated cross-project pattern library would require its own explicit sharing, provenance, licensing and review controls; it is not delivered here.

## Measuring savings honestly

A reuse response records `providerCalls: 0` for that lookup. It does not invent a number of credits, tokens or currency saved: the counterfactual generation cost is unknown. Existing task usage/context budgets remain separate. Future cost reporting must use actual provider usage and make estimates identifiable as estimates.

Tests cover finding drafts, confirmed reuse, immutable re-provision, changed context/narrative/schema/terminology/model invalidation, live revocation, project rights, read-session versus fresh-write boundaries, and finding/loading work in the browser without generation or a new decision.
