<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Exception\ToolCallException;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\FederatedCkmSearch;

final readonly class CkmFederationTools
{
    public const array OUTPUT = [
        'type' => 'object', 'additionalProperties' => false,
        'required' => ['items', 'total', 'total_scope', 'status', 'all_sources_responded', 'truncated', 'source_results', 'ranking', 'scope'],
        'properties' => [
            'items' => ['type' => 'array', 'maxItems' => 50, 'items' => [
                'type' => 'object', 'additionalProperties' => false, 'required' => ['source', 'source_url', 'kind', 'cid', 'score'],
                'properties' => [
                    'source' => ['type' => 'string'], 'source_url' => ['type' => 'string'], 'kind' => ['type' => 'string', 'enum' => ['archetype', 'template']],
                    'cid' => ['type' => 'string'], 'score' => ['type' => 'integer'], 'archetypeId' => ['type' => 'string'],
                    'name' => ['type' => 'string'], 'projectName' => ['type' => 'string'], 'status' => ['type' => 'string'],
                    'revision' => ['type' => 'string'], 'version' => ['type' => 'string'], 'creationTime' => ['type' => 'string'], 'modificationTime' => ['type' => 'string'],
                ],
            ]],
            'total' => ['type' => 'integer', 'minimum' => 0], 'total_scope' => ['type' => 'string'],
            'status' => ['type' => 'string', 'enum' => ['COMPLETE', 'PARTIAL', 'UNAVAILABLE']],
            'all_sources_responded' => ['type' => 'boolean'], 'truncated' => ['type' => 'boolean'],
            'source_results' => ['type' => 'array', 'minItems' => 1, 'maxItems' => 8, 'items' => [
                'type' => 'object', 'additionalProperties' => false,
                'required' => ['source', 'status', 'reported_total', 'returned', 'error'],
                'properties' => ['source' => ['type' => 'string'], 'status' => ['type' => 'string', 'enum' => ['PASS', 'FAILED', 'NOT_EXECUTED']],
                    'reported_total' => ['type' => ['integer', 'null'], 'minimum' => 0], 'returned' => ['type' => 'integer', 'minimum' => 0],
                    'error' => ['type' => ['string', 'null'], 'enum' => [null, 'FEDERATION_TIME_BUDGET', 'CKM_SOURCE_UNAVAILABLE']]],
            ]],
            'ranking' => ['type' => 'string'], 'scope' => ['type' => 'string'],
        ],
    ];

    public function __construct(private FederatedCkmSearch $search)
    {
    }

    /** Search up to eight configured CKMs with independent source provenance, bounded lexical/status ranking and explicit per-source failures/truncation. An empty source list selects all configured sources only when there are at most eight. Result totals describe retrieved windows, never an asserted global CKM count. Credentials and source URLs are deployment configuration.
     * @param list<string> $sources
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'ckm_federated_search', annotations: new ToolAnnotations(readOnlyHint: true, idempotentHint: true, openWorldHint: true), outputSchema: self::OUTPUT)]
    public function search(
        #[Schema(enum: ['archetype', 'template'])] string $kind,
        #[Schema(minLength: 1, maxLength: 500)] string $keyword,
        #[Schema(items: ['type' => 'string', 'minLength' => 1, 'maxLength' => 64], maxItems: 8, uniqueItems: true)] array $sources = [],
        #[Schema(minimum: 1, maximum: 50)] int $maxResults = 20
    ): array {
        try {
            return $this->search->search($kind, $keyword, $sources, $maxResults);
        } catch (\InvalidArgumentException) {
            throw new ToolCallException('INVALID_CKM_QUERY: select configured source names and documented query limits.');
        }
    }
}
