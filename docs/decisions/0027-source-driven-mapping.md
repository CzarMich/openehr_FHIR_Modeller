# ADR-0027: Explicit source-driven mapping with supplied model inputs

Status: Accepted

Model creation and data processing are separate. Reused templates and profiles
must be supplied and pinned just like newly modelled inputs. Deterministic code
executes explicit rules; AI proposes interpretations. Protected human review,
compilation and conformance validation remain distinct. Preview cannot approve
or publish and never writes clinical systems or record values to model storage.

Use a versioned JSON Pointer rule representation for the bounded first increment.
It supports explicit forward stages and independent reverse rules. It is not
StructureMap/FHIR Mapping Language and has no compatibility claim; repetition,
joins, grouping and references require future typed operators and tests.
Do not silently approximate unsupported operations. Report unmapped fields and
validation NOT_EXECUTED. Runtime connectors, jobs and operational records belong
to a separately authorised private processing service.
