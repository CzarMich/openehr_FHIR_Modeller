# ADR-0030: C# modelling core and optional integration-engine mode

Status: accepted for implementation, 2026-11-26. Delivery status remains partial
until the executable acceptance evidence and deployment verification are recorded.

## Context and scope

Users need to author models/rules with an agent, then assign a specific reviewed
mapping version to a continuously consuming channel. They may provide narrative
requirements and existing FHIR StructureDefinitions. Some integrations need a
direct source-to-FHIR path rather than an openEHR stage. The clinical/source
database read-only rule is mandatory across all modes.

New modelling/runtime features are implemented in C#/.NET. The deployed PHP
application remains a compatibility component during migration; do not extend it
with the new channel engine, rule registry, direct mapping or delivery features.
The existing Java/Node native compilers and validators remain specialised engines.

## Components

- `Modeller.Core`: immutable project/model/mapping revisions, protected model/rule
  decisions, source-format parsing, deterministic transformations and validation/
  delivery clients. Model metadata never contains operational records.
- `Modeller.Mcp`: provider-neutral modelling tools, synthetic inspection/preview,
  engine adapters and existing guide contracts. It cannot approve a mapping or
  transmit clinical records from an ordinary agent/API-key invocation.
- `Modeller.Processing`: private C# execution workers. Read configured sources,
  recheck confirmed model/rule versions, validate each output, export/deliver,
  checkpoint and quarantine. No LLM interprets individual records.
- The existing browser backend handles verified sessions, CSRF, personal access
  and channel controls. It brokers exact human decisions to C# with purpose-bound,
  short-lived assertions. New application/domain logic does not depend on PHP.

## Model/rule confirmation and versioning

Store actual supplied model bytes, origin, version, hash and provenance. Draft
origin claims and compiler results never constitute approval. Both FHIR and
openEHR models used by an openEHR-mediated mapping require explicit selection;
a direct FHIR mapping requires the supplied target StructureDefinitions, not a
fictitious openEHR input. Human confirmation covers exact models and executable
rules. Keep clinical approval/publication separate in the existing governance
platform. Request method, target, body digest, identity, roles, freshness and nonce
must be verified; agents cannot set a `human` or `approved` flag.

Mapping versions retain original user narrative, structured interpretation,
assumptions, conditions and synthetic expected results. Unresolved questions,
unsupported operations, target conflicts and failed examples block execution.
Changing instructions creates a new mapping version and confirmation. Channels
pin their assigned version; no automatic upgrade to a new draft.

## Execution and delivery

Explicit modes: source → openEHR → FHIR; direct source → FHIR; and separately
authored FHIR → openEHR. CDR persistence is not required for generation. Support
only implemented/tested connector and parser combinations; a generic XML parser
is not an HL7/CDA adapter, and a JSON resourceType alone does not establish FHIR.

The first private runtime uses bounded file batches and durable per-record state.
Channels poll configured sources, retain consumption state, and continue after
quarantined data failures according to their reviewed policy. Infrastructure
failures cause retry/backpressure; ambiguous delivery outcomes require explicit
reconciliation. Source/model/rule drift must not be silently accepted.

FHIR destination writes use HTTPS and separate credentials. The initial delivery
policy is conditional create by a stable business identifier, with advertised
server support, bounded retries and representation comparison for existing data.
Do not blindly retry an ordinary POST, overwrite an existing resource, claim
universal exactly-once delivery or infer that a 2xx entry means an entire bundle
succeeded. New-resource reference creation, transactions and update modes require
their own implemented tests before being advertised.

Direct database access is strictly read-only. Use dedicated read-only accounts,
server-enforced protection and constrained read plans. No clinical/source writes,
DDL, migrations, writable procedures or arbitrary SQL escape hatches. Negative
write tests belong only in isolated synthetic databases. No SQL driver is claimed
implemented by a file-processing worker.

## Privacy and deployment

Operational records, exports, validation detail and quarantine live outside model
Git, model artefact stores and general MCP/AI context. A synthetic marker is a
usage contract, not an automated PHI/anonymisation detector. Application logs carry
codes/counts, not record values or secrets. Files are not assumed encrypted merely
because directories are private: operators own volume/backup encryption, retention,
access and recovery. Public HTTPS does not imply TLS on every private engine hop.

Build application images on hosted CI; test on Dev; promote exact verified digests
to hygeoniq-prod through GitOps, preserving existing storage, identity and edge.
Keep the existing MCP compatibility endpoint until the replacement passes actual
contract/auth/storage parity. Document the new endpoint/mode and every remaining
migration/connector limitation honestly. This decision does not assert parity with
all features or throughput of a mature integration-engine product.
