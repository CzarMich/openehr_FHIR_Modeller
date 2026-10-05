<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\TerminologyBindingPlans;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class TerminologyBindingTools
{
    public function __construct(private TerminologyBindingPlans $plans) {}

    /** Inspect explicit OET/OPT coded constraints and existing references without changing source bytes. Positional locations apply only to the recorded revision; inherited ADL semantics require the engine.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_terminology_inspect', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function inspect(string $project, string $path, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->plans->inspect($project, $path, $revision));
    }

    /** Propose review candidates from exact project ValueSet membership. Preserve existing bindings and original constraints; aliases explicitly declare terminology_id, canonical system, optional version and archetype. No code is invented or applied.
     * @param list<array<string, mixed>> $aliases
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_binding_plan', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function plan(string $project, string $path, ?string $revision = null,
        #[Schema(type: 'array', items: ['type' => 'object'], maxItems: 100)] array $aliases = []): array
    {
        return ToolResult::run(fn (): array => $this->plans->plan($project, $path, $revision, $aliases));
    }

    /** Recompute and persist a DRAFT terminology plan against an explicit model revision. expectedRevision is required to replace an existing plan. This writes evidence only; it cannot alter or clinically approve the model.
     * @param list<array<string, mixed>> $aliases
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_binding_plan_save', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function save(string $project, string $path, string $modelRevision,
        #[Schema(type: 'array', items: ['type' => 'object'], maxItems: 100)] array $aliases = [], ?string $expectedRevision = null): array
    {
        return ToolResult::run(fn (): array => $this->plans->save($project, $path, $modelRevision, $aliases, $expectedRevision));
    }

    /** Read a saved terminology plan and recompute freshness against current source and the whole project catalogue. Historical evidence never establishes current validation or clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'terminology_binding_plan_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function get(string $project, string $path, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->plans->get($project, $path, $revision));
    }
}
