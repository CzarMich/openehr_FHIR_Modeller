# ADR-0028: Incremental C#/.NET migration

Status: Accepted

Use .NET 10 LTS and the official C# MCP SDK for the replacement application layer.
Keep the existing Java/openEHR compiler and Node/Java FHIR tooling behind their
computational interfaces. Changing application language does not remove the need
for patching, dependency audits, authorization, resource limits and clinical review.

Start with read-only guide retrieval/resources. Reuse bundled Markdown bytes and
captured published MCP contracts; verify behavior independently over HTTP and
stdio. No PHP proxy is part of this slice. Keep the existing production service
and storage until all required replacements pass parity/security gates.

Subsequent slices cover model repository/read interfaces, source modelling,
versioned mappings, writes and protected human/IG confirmation, then browser
backend integration. Preserve exact revisions, tenant boundaries and audit hashes.
Publication/distribution remains in the existing IG platform. Operational records
stay outside model repositories and AI context. Avoid simultaneous new feature
work in PHP and its replacement; keep bounded tasks and a persistent parity matrix
so later sessions reuse evidence instead of repeating the repository audit.
