<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\ProjectQuality;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class QualityTools
{
    public function __construct(private ProjectQuality $quality)
    {
    }

    /** Inspect an exact repository model revision, document profile, recorded provenance, requirement trail, authentic validation/review events, explicit terminology findings, and hash-verified saved native build evidence. Full engine, dependency, terminology and clinical qualification may remain NOT_EXECUTED; no approval or model write occurs.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_project_qa', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function evaluate(
        string $project,
        string $path,
        ?string $revision = null,
        #[Schema(enum: ['xml', 'oet', 'opt', 'adl', 'aql', 'flat', 'structured', null])] ?string $format = null
    ): array {
        return ToolResult::run(fn (): array => $this->quality->evaluate($project, $path, $revision, $format));
    }
}
