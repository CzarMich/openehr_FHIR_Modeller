# Product boundary

The platform supports humans and agents through the governed openEHR modelling lifecycle: requirements, CKM discovery, archetypes, templates, terminology, deterministic validation and compilation, repositories, review, releases, AQL and optional CDR deployment.

Web Templates, simplified paths, synthetic compositions and form-oriented schemas must be derived from actual openEHR artefacts. They are implementation aids; archetypes, templates and compiled operational templates remain authoritative. Native local identity supports secure single-instance accounts alongside optional OIDC and separate service credentials; horizontal scaling and delivery-provider integration remain deployment capabilities. The reference UI uses accessible blue and white styling with consistent readable typography.

The product excludes FHIR resource/profile modelling, CQL/ELM/CDS, HL7 v2 or FHIR-to-openEHR data mapping and generic ETL from this repository. Existing FHIR terminology operations and reviewed ConceptMap candidates remain in scope because they support openEHR terminology binding. Repository/tenant mapping and structural JSON mapping are implementation concepts, not healthcare integration products.

Native authentication requires secure owner bootstrap without shipped passwords. `admin` may be an administrator-selected username; the application must not hard-code a privileged account or reusable default password. Account creation, invitations, resets, MFA, sessions, service credentials and role changes must be auditable. A platform administrator has all configured administrative permissions. Human approval and exact-revision validation remain separate governance controls; service accounts cannot become human approvers.

Planned capabilities are tracked in [the backlog](COMPLETION_QUEUE.json); current support is documented in [the capability matrix](../CAPABILITIES.md).
