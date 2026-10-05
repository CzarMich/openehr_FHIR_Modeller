# Archetype Designer compatibility

Hosted Designer import/export and semantic round trips are **UNVERIFIED**. The assistant's independent Git exchange test verifies repository behaviour; it does not establish what a particular Designer version/account can export, import or automate.

| Capability / format | Status | Evidence or boundary |
|---|---|---|
| Native Git model file retrieval, conditional updates and external edits | FILE_EXCHANGE_VERIFIED | `evidence/designer-git-roundtrip.json`; independent Git clients, without an authenticated Designer UI |
| Hosted Designer version/account | EXTERNAL_ACCEPTANCE_REQUIRED | No authenticated account/version established |
| Designer `.t.json` | Exact immutable original preservation and protected platform receipt; semantic interpretation unverified | Distinct authoring format; unknown fields must remain in original source |
| OET import/export | EXTERNAL_ACCEPTANCE_REQUIRED | Do not infer capability from existing files or historical descriptions |
| Legacy OPT 1.4 XML import/export | EXTERNAL_ACCEPTANCE_REQUIRED | Structural assistant inspection does not prove Designer acceptance |
| Assistant-generated OPT 1.4 XML | Compiler profile and SDK Web Template consumer verified; hosted Designer import unverified | Bounded OET/ADL 1.4 adapter; see [limits](LEGACY_OPT_COMPILATION.md) |
| Assistant-generated ADL 2 OPT | Compiler fixture verified; Designer import unverified | Archie output is OPT 2 ADL, not legacy OPT XML |
| Languages, bindings, annotations, slots, identifiers and constraint round trip | UNVERIFIED | Requires real export/import/re-export comparison with the actual account/version |
| Hosted API, automatic push, publish or release | NOT SUPPORTED | No verified supported automation contract or authenticated capability check |

Each future acceptance record must include tool/version/account type, platform revision, source/export hashes, exact fixture, test timestamp, checks performed and known transformations/losses. A tool-version change requires revalidation. A successful HTTP response or XML parse cannot establish semantic round-trip compatibility.

The current compiler tests verify assistant-side ADL 2 parsing, pinned dependencies, nested archetypes, native constraint findings, serialization and output validation. They make no claim of lossless Designer interchange. Follow the [current manual/Git workflow](workflows/archetype-designer.md), [connection guide](ARCHETYPE_DESIGNER_INTEGRATION.md) and [generic exchange architecture](MODELLING_TOOL_INTEGRATION.md).
