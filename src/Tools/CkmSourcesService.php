<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use OpenEHR\Assistant\Apis\CkmClient;
use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;

final readonly class CkmSourcesService
{
    public function __construct(private CkmClient $client)
    {
    }

    /** List configured CKMs. Pass a source name as the optional ckm argument on CKM tools.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'ckm_sources', annotations: new ToolAnnotations(readOnlyHint: true, idempotentHint: true, openWorldHint: false))]
    public function sources(): array
    {
        return ['default' => $this->client->defaultSource(), 'sources' => $this->client->sources()];
    }
}
