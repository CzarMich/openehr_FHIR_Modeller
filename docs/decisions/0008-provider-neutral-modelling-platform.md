# ADR-0008: Provider-neutral modelling platform

Status: accepted. Supersedes upstream hosted deployment and required client-plugin assumptions in ADR-0007 and the former single-CKM boundary in ADR-0002.

The product is openEHR Modelling Assistant. Keep the existing MCP tools, prompts, guides, specification data and MIT attribution, while removing operational dependency on an upstream hosted service or a model-specific plugin. Multiple configured CKMs share a bounded HTTPS adapter.

MCP adapts reusable modelling services. Repository and terminology contracts isolate storage and FHIR formats. The filesystem provider is implemented first; other storage, native OIDC, a visual editor and CDR adapters are explicit extension work. Partial validators report scope and cannot certify release. Models stay DRAFT until a future trusted governance application supplies qualified validation and independent human approval.

Deployment uses non-root PHP-FPM and Caddy behind an enterprise TLS gateway. Local HTTP defaults bind loopback. API-key authentication is implemented; client model choice belongs outside the server. Microsoft connection documentation is based on official product documentation and does not claim a tenant test that was not performed.
