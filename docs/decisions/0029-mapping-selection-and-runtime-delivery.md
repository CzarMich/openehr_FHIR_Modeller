# ADR-0029: exact model selection and private FHIR delivery

Status: accepted for implementation, 2026-11-26.

## Context

The product must accept externally supplied templates/profiles and require human
confirmation for agent-modelled mapping inputs. Clinical approval/publication in
the existing governance platform is a separate responsibility. Synthetic mapping
previews currently provide no operational extraction, composition validation or
destination delivery. The README previously obscured these distinctions.

## Decision

Record a protected, exact-revision mapping-model selection covering both openEHR
and FHIR. An agent can prepare a request but cannot confirm/revoke it. The browser's
existing purpose-bound interactive assertion authenticates a human decision, bound
to HTTP method, target, body hash, short expiry and a consumed nonce. Recheck tenant,
project access, current hashes and optimistic sequence at the decision and every
later use. Store hashes/provenance in the audit ledger; supply actual model content
to the agent. Imported metadata and caller approval flags never confer authority.

A selection confirmation authorises use of those inputs for mapping design. It is
not clinical approval, publication, a conformance report or permission to transmit
records. Externally provided inputs remain visibly distinguished from agent drafts.

Operational processing belongs in the C# service and keeps clinical records out of
MCP/AI context and model Git. Use operator-configured sources and destinations;
never accept arbitrary URLs or credentials from tool input. Validate each record
against pinned models, quarantine failures and reconcile counts. Destination writes
are separately authorised. Prefer stable resource identities and conditional/versioned
writes supported by the destination; never blindly retry an indeterminate POST.
Preserve delivery receipts and explicitly report uncertain outcomes.

## Consequences and gates

Preserve the legacy application during migration. No partial .NET service may
replace the whole production MCP endpoint. A language migration is not itself a
security guarantee. No operational/delivery support may be advertised until real
positive/negative integration checks exist. Dataset adapters require their actual
specifications and fixtures; unavailable checks remain NOT_EXECUTED.
