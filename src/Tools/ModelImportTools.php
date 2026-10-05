<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\ModelImports;
use OpenEHR\Assistant\Domain\Modelling\ArtifactTypes;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class ModelImportTools
{
    public function __construct(private ModelImports $imports)
    {
    }

    /** Inspect exact base64-encoded source bytes without writes. Content markers and declarations are separate; Designer .t.json is never assumed to be OET, OPT or Web Template. Does not perform conformance validation or contact an external tool.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_import_inspect', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function inspect(
        #[Schema(minLength: 1, maxLength: 128)] string $filename,
        #[Schema(minLength: 4, maxLength: 2796204)] string $contentBase64,
        #[Schema(enum: ArtifactTypes::ALL)] string $declaredType = 'UNKNOWN'
    ): array {
        return ToolResult::run(fn (): array => $this->imports->inspect($filename, $contentBase64, $declaredType));
    }

    /** Preserve an external file's exact bytes as a create-only original with protected platform provenance. Requires model write access and a configured audit ledger. Idempotent per caller, project, filename, bytes and source claims. External origin remains caller-declared. Never approves, publishes, converts or extracts the source.
     * @param array<string, mixed>|null $sourceClaims
     * @return array<string, mixed> */
    #[Schema(properties: ['sourceClaims' => ['type' => ['object', 'null'], 'additionalProperties' => false, 'default' => null,
        'properties' => ['source_system' => ['type' => 'string', 'maxLength' => 1000], 'tool_version' => ['type' => 'string', 'maxLength' => 1000],
            'external_identifier' => ['type' => 'string', 'maxLength' => 1000], 'external_revision' => ['type' => 'string', 'maxLength' => 1000],
            'external_status' => ['type' => 'string', 'maxLength' => 1000],
            'exported_at' => ['type' => 'string', 'maxLength' => 30], 'licence' => ['type' => 'string', 'maxLength' => 1000], 'copyright' => ['type' => 'string', 'maxLength' => 1000]]]], additionalProperties: false)]
    #[McpTool(name: 'model_artifact_import', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function import(
        string $project,
        #[Schema(minLength: 1, maxLength: 128)] string $filename,
        #[Schema(minLength: 4, maxLength: 2796204)] string $contentBase64,
        #[Schema(enum: ArtifactTypes::ALL)] string $declaredType = 'UNKNOWN',
        ?array $sourceClaims = null
    ): array {
        return ToolResult::run(fn (): array => $this->imports->import($project, $filename, $contentBase64, $declaredType, $sourceClaims ?? []));
    }

    /** Verify imported bytes against the exact repository revision and protected audit receipt. Reports real transport identity separately from unverified source claims; this is not clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_artifact_provenance', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function provenance(string $project, #[Schema(pattern: '^[a-f0-9]{64}$')] string $importId): array
    {
        return ToolResult::run(fn (): array => $this->imports->provenance($project, $importId));
    }
}
