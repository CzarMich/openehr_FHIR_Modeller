<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\RepositoryService;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class RepositoryTools
{
    public function __construct(private RepositoryService $service) {}

    /** Discover the configured repository's capabilities, active branch and optional hosted metadata.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_repository_info', annotations: new ToolAnnotations(readOnlyHint: true), outputSchema: ToolResult::SCHEMA)]
    public function info(): array { return ToolResult::run(fn (): array => $this->service->info()); }

    /** List one page of hosted branches and reported protection status. Null protection means unknown.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_repository_branches', annotations: new ToolAnnotations(readOnlyHint: true), outputSchema: ToolResult::SCHEMA)]
    public function branches(#[Schema(minimum: 1, maximum: 10000)] int $page = 1): array
    { return ToolResult::run(fn (): array => $this->service->branches($page)); }

    /** Create a Git branch from a reachable revision. Does not switch the active deployment branch. Requires write access.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_branch_create', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false), outputSchema: ToolResult::SCHEMA)]
    public function createBranch(#[Schema(maxLength: 200)] string $branch, string $baseRevision): array
    { return ToolResult::run(fn (): array => $this->service->createBranch($branch, $baseRevision)); }

    /** Open a draft hosted review against the configured target or return an existing open review. Never approves a clinical model or merges. Requires write access.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_review_request', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false), outputSchema: ToolResult::SCHEMA)]
    public function requestReview(#[Schema(maxLength: 200)] string $branch, #[Schema(minLength: 1, maxLength: 200)] string $title,
        #[Schema(maxLength: 20000)] string $body = ''): array
    { return ToolResult::run(fn (): array => $this->service->requestReview($branch, $title, $body)); }

    /** Read hosted review metadata. Hosting review state is separate from authenticated clinical approval.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_review_get', annotations: new ToolAnnotations(readOnlyHint: true), outputSchema: ToolResult::SCHEMA)]
    public function review(#[Schema(minimum: 1)] int $number): array
    { return ToolResult::run(fn (): array => $this->service->review($number)); }

    /** Compare two reachable immutable Git revisions without executing external diff commands.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_repository_diff', annotations: new ToolAnnotations(readOnlyHint: true), outputSchema: ToolResult::SCHEMA)]
    public function diff(string $baseRevision, string $headRevision): array
    { return ToolResult::run(fn (): array => $this->service->diff($baseRevision, $headRevision)); }
}
