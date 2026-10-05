<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\TemplateBuilds;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class TemplateBuildTools
{
    public function __construct(private TemplateBuilds $builds)
    {
    }

    /** Compile an exact ADL 2 or supported OET template repository revision with explicit dependency revisions. Atomically save a native OPT 2 ADL or OPT 1.4 XML DRAFT, preserving source hashes, compiler profile, dependency revisions, limitations and validation evidence. Never overwrites a build or approves a clinical model.
     * @param list<array{identifier: string, path: string, revision: string}> $dependencies
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'template_compile_project', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function compile(
        string $project,
        string $path,
        #[Schema(minLength: 1)] string $revision,
        #[Schema(items: ['type' => 'object', 'additionalProperties' => false, 'required' => ['identifier', 'path', 'revision'],
            'properties' => ['identifier' => ['type' => 'string', 'minLength' => 2, 'maxLength' => 300],
                'path' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 240],
                'revision' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 64]]], maxItems: 64)] array $dependencies = []
    ): array {
        return ToolResult::run(fn (): array => $this->builds->compile($project, $path, $revision, $dependencies));
    }
}
