<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Domain\Modelling\TemplateAuthoringService;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Helpers\ToolResult;
use OpenEHR\Assistant\Validation\ModelValidator;

final readonly class ModelService
{
    public function __construct(private ModelValidator $validator, private TemplateAuthoringService $authoring, private QualityPipeline $qa)
    {
    }

    /** Run deterministic bounded preflight checks. Partial results never certify deployment.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_validate', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function validate(#[Schema(maxLength: 2097152)] string $content, #[Schema(enum: ['xml', 'oet', 'opt', 'adl', 'aql', 'flat', 'structured'])] string $format): array
    {
        return ToolResult::run(fn (): array => $this->validator->validate($content, $format));
    }

    /** Compare bounded XML structure and return typed explicit-field differences, including unambiguous moves. Not full openEHR semantic equivalence.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_diff', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function diff(#[Schema(maxLength: 2097152)] string $before, #[Schema(maxLength: 2097152)] string $after): array
    {
        return ToolResult::run(fn (): array => $this->validator->diff($before, $after));
    }

    /** Generate a draft OET from either 1–30 direct ENTRY identifiers or explicit parent-linked nested placements with supplied archetype paths. Returns the exact ADL dependencies and hashes used; save these alongside the OET in the project's archetypes folder. Supplied archetypes take precedence over CKM for matching identifiers; pass current repository sources to preserve designer edits. Unmatched identifiers are fetched from CKM. A changed hash is not a semantic version or approval. Drafts are compile-checked when the native engine is configured; this does not certify complete legacy semantics.
     *
     * @param list<string> $entries
     * @param list<array{identifier: string, content: string}> $archetypes
     * @param list<array<string, mixed>> $placements
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'template_build_oet', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: true), outputSchema: ToolResult::SCHEMA)]
    public function buildOet(#[Schema(minLength: 1, maxLength: 200)] string $name, string $composition,
        #[Schema(items: ['type' => 'string'], maxItems: 30, uniqueItems: true)] array $entries = [], ?string $ckm = null,
        #[Schema(items: ['type' => 'object', 'additionalProperties' => false, 'required' => ['id', 'parent', 'identifier', 'path'], 'properties' => [
            'id' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 64], 'parent' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 64],
            'identifier' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 300], 'path' => ['type' => 'string', 'minLength' => 2, 'maxLength' => 2048],
            'min' => ['type' => 'string', 'pattern' => '^[0-9]+$'], 'max' => ['type' => 'string', 'pattern' => '^(?:[0-9]+|\\*)$'],
            'name' => ['type' => 'string', 'minLength' => 1, 'maxLength' => 1000]]], maxItems: 30)] array $placements = [],
        #[Schema(items: ['type' => 'object', 'additionalProperties' => false, 'required' => ['identifier', 'content'], 'properties' => [
            'identifier' => ['type' => 'string', 'maxLength' => 200], 'content' => ['type' => 'string', 'maxLength' => 1048576]]], maxItems: 64)] array $archetypes = []): array
    {
        return ToolResult::run(fn (): array => $this->authoring->generateOet($name, $composition, $entries, $ckm, $placements, $archetypes));
    }

    /** Run document/project QA and verify any saved native build tied to the exact source revision. Missing qualification remains NOT_EXECUTED; release eligibility stays false.
     *
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_qa', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function qa(#[Schema(maxLength: 2097152)] string $content, #[Schema(enum: ['xml', 'oet', 'opt', 'adl', 'aql', 'flat', 'structured'])] string $format): array
    {
        return ToolResult::run(fn (): array => $this->qa->run($content, $format));
    }
}
