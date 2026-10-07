<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\ProjectTraceability;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class TraceabilityTools
{
    public function __construct(private ProjectTraceability $traceability)
    {
    }

    /** Save the project's explicit requirement/decision/model/evidence graph as a conditional DRAFT revision. Graph schema and pinned references are checked; this does not prove clinical satisfaction or approve a model.
     *
     * @param array<string, mixed> $graph
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_traceability_save', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function save(string $project, #[Schema(type: 'object')] array $graph, ?string $expectedRevision = null): array
    {
        return ToolResult::run(fn (): array => $this->traceability->save($project, $graph, $expectedRevision));
    }

    /** Read a versioned requirements graph, resolve pinned source/anchor/audit references and report declared coverage and unresolved/stale evidence. Native inherited openEHR paths require the qualified engine.
     *
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_traceability_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function get(string $project, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->traceability->get($project, $revision));
    }

    /** Answer why an element exists from the stored requirement and decision trail, including associated terminology, validation and review evidence. Node identifiers come from the persisted graph; no rationale is inferred.
     *
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_traceability_explain', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function explain(string $project, string $node, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->traceability->explain($project, $node, $revision));
    }

    /** Return the exact model elements explicitly linked to a requirement, with full/partial/excluded/unresolved declarations and reference verification. An authentic validation or review event does not certify every graph assertion.
     *
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_traceability_requirement', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function requirement(string $project, string $requirement, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->traceability->requirement($project, $requirement, $revision));
    }
}
