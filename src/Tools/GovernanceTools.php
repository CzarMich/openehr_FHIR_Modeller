<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class GovernanceTools
{
    public function __construct(private ModelGovernance $governance) {}

    /** Register an exact source revision for governed review. Trusted transport identity is recorded as preparer; caller-supplied author or approval metadata is not accepted.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_prepare', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function prepare(string $project, string $path, string $modelRevision, string $comment): array
    {
        return ToolResult::run(fn (): array => $this->governance->prepare($project, $path, $modelRevision, $comment));
    }

    /** Execute the installed deterministic validation pipeline and append authoritative evidence. New validation evidence requires a new review. Missing/partial stages return the model to DRAFT and prevent approval; model JSON cannot supply validation results.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_validate', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function validate(string $subject, #[Schema(minimum: 1)] int $expectedSequence): array
    {
        return ToolResult::run(fn (): array => $this->governance->validate($subject, $expectedSequence));
    }

    /** Request independent human review of the registered revision. Unqualified draft reviews remain explicitly incomplete and cannot be approved or published.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_request_review', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function requestReview(string $subject, #[Schema(minimum: 1)] int $expectedSequence, string $comment): array
    {
        return ToolResult::run(fn (): array => $this->governance->transition($subject, $expectedSequence, 'REVIEW_REQUESTED', $comment));
    }

    /** Reopen a CHANGES_REQUESTED subject as DRAFT. Changed model content must be registered as a new source revision; existing review history is retained.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_reopen_draft', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function reopenDraft(string $subject, #[Schema(minimum: 1)] int $expectedSequence, string $comment): array
    {
        return ToolResult::run(fn (): array => $this->governance->transition($subject, $expectedSequence, 'DRAFT', $comment));
    }

    /** Read authoritative lifecycle state, exact source identity, validation and append-only audit history. Approval of an old revision never approves the current model.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function get(string $subject): array { return ToolResult::run(fn (): array => $this->governance->get($subject)); }

    /** List governed model revisions in a project and the authenticated tenant namespace, with bounded paging.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'governance_list', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function list(string $project, #[Schema(minimum: 1, maximum: 100)] int $count = 25, #[Schema(minimum: 0, maximum: 10000)] int $offset = 0): array
    {
        return ToolResult::run(fn (): array => $this->governance->list($project, $count, $offset));
    }
}
