<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class NativeEngineTools
{
    private const array DEPENDENCY = ['type' => 'object', 'additionalProperties' => false,
        'required' => ['identifier', 'content'], 'properties' => [
            'identifier' => ['type' => 'string', 'minLength' => 2, 'maxLength' => 300],
            'content' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 2097152],
        ]];

    public function __construct(private NativeModels $models)
    {
    }

    /** Validate ADL 2 grammar, AOM constraints and the declared supported RM profile with the configured native engine. Dependencies are explicit exact versions; no network retrieval or approval.
     * @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'archetype_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function archetype(
        #[Schema(minLength: 1, maxLength: 2097152)] string $content,
        #[Schema(items: self::DEPENDENCY, maxItems: 64)] array $dependencies = []
    ): array {
        return ToolResult::run(fn (): array => $this->models->validate($content, 'adl2', $dependencies));
    }

    /** Validate an ADL 2 template or compile-check the explicit legacy OET compatibility profile with exact supplied archetypes. OET requires ADL 1.4 dependencies and uses RM 1.0.2; unsupported constructs fail. Read profile, checks and limitations; legacy checks are not full AOM conformance.
     * @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'template_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function template(
        #[Schema(minLength: 1, maxLength: 2097152)] string $content,
        #[Schema(items: self::DEPENDENCY, maxItems: 64)] array $dependencies = []
    ): array {
        return ToolResult::run(fn (): array => $this->models->validate($content, 'adlt2', $dependencies));
    }

    /** Compile ADL 2 into OPT 2 ADL, or supported OET XML plus exact ADL 1.4 dependencies into OPT 1.4 XML. Returns native output, hashes, dependency evidence and explicit validation profile. Legacy nested placements, bounded rules and original terms are preserved; unsupported constructs fail closed. No repository write, clinical approval or CDR deployment.
     * @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'template_compile', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function compile(
        #[Schema(minLength: 1, maxLength: 2097152)] string $content,
        #[Schema(items: self::DEPENDENCY, maxItems: 64)] array $dependencies = []
    ): array {
        return ToolResult::run(fn (): array => $this->models->compile($content, $dependencies));
    }

    /** Validate OPT 2 ADL using native flat AOM/RM checks, or OPT 1.4 XML using its independent schema and explicit RM structure profile. Inspect checks and limitations: legacy profile is not full AOM semantic conformance or clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'opt_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function opt(#[Schema(minLength: 1, maxLength: 2097152)] string $content): array
    {
        return ToolResult::run(fn (): array => $this->models->validate($content, 'opt2'));
    }

    /** Inspect native ADL 2, OPT 2 ADL or OPT 1.4 XML paths, RM types, multiplicities and original terminology. Explicit format and validation profile; no guessed paths or clinical approval.
     * @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_inspect', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function inspect(
        #[Schema(minLength: 1, maxLength: 2097152)] string $content,
        #[Schema(enum: ['adl2', 'opt2', 'opt14'])] string $format,
        #[Schema(items: self::DEPENDENCY, maxItems: 64)] array $dependencies = []
    ): array {
        return ToolResult::run(fn (): array => $this->models->inspect($content, $format, $dependencies));
    }

    /** Parse AQL with the native engine. Optionally check containment and SELECT/WHERE/ORDER BY paths against exact supplied OPT 1.4 XML or OPT 2 ADL templates. Fetch the intended repository versions first; compile OET/ADL templates with explicit dependencies using template_compile before supplying its OPT output. Reports each template and unmatched or incomplete paths. Does not execute queries or validate predicate values, function signatures or clinical meaning; no CDR or provider account is required.
     * @param list<array{identifier: string, content: string}> $templates
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'aql_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function aql(
        #[Schema(minLength: 1, maxLength: 2097152)] string $content,
        #[Schema(items: self::DEPENDENCY, maxItems: 8)] array $templates = []
    ): array {
        return ToolResult::run(fn (): array => $this->models->validate($content, 'aql', $templates));
    }
}
