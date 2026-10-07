<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\TerminologyCatalogue;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class TerminologyCatalogueTools
{
    public function __construct(private TerminologyCatalogue $catalogue) {}

    /** Save a versioned DRAFT local CodeSystem, ValueSet, ConceptMap or external reference in the project repository. Provenance is required; expectedRevision is required when replacing a record. This does not approve clinical content.
     * @param array<string, mixed> $record
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_save', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function save(string $project, #[Schema(type: 'object')] array $record, ?string $expectedRevision = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->save($project, $record, $expectedRevision));
    }

    /** Read a project terminology resource by canonical and optional edition. Multiple editions require an explicit version; historical reads also require that version.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function get(string $project, #[Schema(enum: ['code_system', 'value_set', 'concept_map'])] string $kind,
        string $canonical, ?string $version = null, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->get($project, $kind, $canonical, $version, $revision));
    }

    /** Deterministic project terminology search over names/descriptions and exact canonical identifiers. Invalid records remain explicit QA findings.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_search', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function search(string $project, #[Schema(enum: ['code_system', 'value_set', 'concept_map', null])] ?string $kind = null,
        ?string $canonical = null, ?string $query = null, #[Schema(minimum: 1, maximum: 100)] int $count = 50,
        #[Schema(minimum: 0, maximum: 10000)] int $offset = 0): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->search($project, $kind, $canonical, $query, $count, $offset));
    }

    /** Look up a code in a versioned project CodeSystem. Local resources work offline; explicit external references use the optional configured provider.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_lookup', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function lookup(string $project, string $system, string $code, ?string $version = null, ?string $language = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->lookup($project, $system, $code, $version, $language));
    }

    /** Validate code-system or explicit value-set membership in the project catalogue, keeping resource and code-system editions separate. Draft checks do not confer clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function validate(string $project, string $system, string $code, ?string $valueSet = null, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->validate($project, $system, $code, $valueSet, $version, $codeSystemVersion, $display, $language));
    }

    /** Expand explicit project value-set members with bounded paging; external references preserve provider version/coverage evidence.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_expand', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function expand(string $project, string $valueSet, ?string $version = null, #[Schema(minimum: 0, maximum: 500)] int $count = 50,
        #[Schema(minimum: 0, maximum: 1000000)] int $offset = 0, ?string $language = null, ?string $filter = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->expand($project, $valueSet, $version, $count, $offset, $language, $filter));
    }

    /** Read project ConceptMap candidates. Conditions, ambiguous targets and unconfirmed source editions remain explicit; no mapping is automatically applied.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_catalogue_translate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function translate(string $project, string $conceptMap, string $system, string $code, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $targetSystem = null): array
    {
        return ToolResult::run(fn (): array => $this->catalogue->translate($project, $conceptMap, $system, $code, $version, $codeSystemVersion, $targetSystem));
    }
}
