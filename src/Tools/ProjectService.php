<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tools;

use Mcp\Capability\Attribute\McpTool;
use Mcp\Capability\Attribute\Schema;
use Mcp\Schema\ToolAnnotations;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Modelling\Traceability;
use OpenEHR\Assistant\Helpers\ToolResult;

final readonly class ProjectService
{
    public function __construct(private ModelRepository $repository, private Settings $settings, private Traceability $traceability, private ?AccessPolicy $access = null)
    {
    }

    /** List persistent projects and actual repository capabilities.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_projects', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function projects(): array
    {
        return ToolResult::run(fn (): array => ['projects' => $this->repository->listProjects(), 'capabilities' => $this->repository->capabilities()]);
    }

    /** Open a project and list its logical artefacts and revision identifiers.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_project_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function get(string $project): array
    {
        return ToolResult::run(fn (): array => ['project' => $this->repository->getProject($project), 'artifacts' => $this->repository->listArtifacts($project)]);
    }

    /** Create a persistent modelling workspace. Requires deployment write enablement and authorized draft-write scope or role in OIDC mode.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_project_create', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function create(string $id, #[Schema(minLength: 1, maxLength: 200)] string $name, #[Schema(maxLength: 10000)] string $description = ''): array
    {
        return ToolResult::run(function () use ($id, $name, $description): array {
            $this->assertWrites();
            return $this->repository->createProject($id, $name, $description);
        });
    }

    /** Read an artefact or its immutable historical revision.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_artifact_get', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function artifact(string $project, string $path, ?string $revision = null): array
    {
        return ToolResult::run(fn (): array => $this->repository->getArtifact($project, $path, $revision));
    }

    /** Save a DRAFT artefact with optimistic concurrency and authorized write access. Pass the previous revision when replacing an artefact; null only creates.
     *
     * @param array<string, mixed>|null $metadata
     * @return array<string, mixed>
     */
    #[Schema(properties: ['metadata' => ['type' => ['object', 'null'], 'additionalProperties' => true, 'default' => null]], additionalProperties: false)]
    #[McpTool(name: 'model_artifact_save', annotations: new ToolAnnotations(readOnlyHint: false, destructiveHint: false, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function save(string $project, string $path, #[Schema(maxLength: 2097152)] string $content,
        ?array $metadata = null, ?string $expectedRevision = null): array
    {
        return ToolResult::run(function () use ($project, $path, $content, $metadata, $expectedRevision): array {
            $this->assertWrites();
            return $this->repository->saveArtifact($project, $path, $content, $metadata ?? [], $expectedRevision);
        });
    }

    /** Read artefact revision history, including tombstones.
     * @return array<string, mixed> */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_artifact_history', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function history(string $project, string $path): array
    {
        return ToolResult::run(fn (): array => ['versions' => $this->repository->history($project, $path)]);
    }

    /** Compute coverage from explicit requirement links and existing project artefacts; not clinical or test coverage.
     *
     * @param list<array<string, mixed>> $requirements
     * @param list<array<string, mixed>> $links
     * @return array<string, mixed>
     */
    #[Schema(additionalProperties: false)]
    #[McpTool(name: 'model_requirements_coverage', annotations: new ToolAnnotations(readOnlyHint: true, openWorldHint: false), outputSchema: ToolResult::SCHEMA)]
    public function coverage(string $project,
        #[Schema(items: ['type' => 'object'], maxItems: 1000)] array $requirements,
        #[Schema(items: ['type' => 'object'], maxItems: 5000)] array $links): array
    {
        return ToolResult::run(fn (): array => $this->traceability->coverage($requirements, $links,
            array_column($this->repository->listArtifacts($project), 'path')));
    }

    private function assertWrites(): void
    {
        ($this->access ?? new AccessPolicy($this->settings))->assertModelWrite();
    }
}
