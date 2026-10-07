<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;

/** Enforces project grants from verified OIDC scopes at the storage boundary. */
final readonly class ProjectScopedRepository implements ModelRepository
{
    public function __construct(private ModelRepository $repository, private Principal $principal)
    {
    }

    public function capabilities(): array { return $this->repository->capabilities(); }

    public function listProjects(): array
    {
        return array_values(array_filter($this->repository->listProjects(), fn (array $project): bool => $this->canRead((string) ($project['id'] ?? ''))));
    }

    public function getProject(string $id): array
    {
        $this->assertRead($id);
        return $this->repository->getProject($id);
    }

    public function createProject(string $id, string $name, string $description): array
    {
        if (!in_array('projects:create', $this->principal->scopes, true) && !in_array('projects:admin', $this->principal->scopes, true)) {
            throw new \RuntimeException('PROJECT_PERMISSION_REQUIRED');
        }
        return $this->repository->createProject($id, $name, $description);
    }

    public function archiveProject(string $id, string $expectedRevision): array
    {
        $this->assertWrite($id);
        return $this->repository->archiveProject($id, $expectedRevision);
    }

    public function listArtifacts(string $project): array
    {
        $this->assertRead($project);
        return $this->repository->listArtifacts($project);
    }

    public function getArtifact(string $project, string $path, ?string $revision = null): array
    {
        $this->assertRead($project);
        return $this->repository->getArtifact($project, $path, $revision);
    }

    public function saveArtifact(string $project, string $path, string $content, array $metadata, ?string $expectedRevision): array
    {
        $this->assertWrite($project);
        return $this->repository->saveArtifact($project, $path, $content, $metadata, $expectedRevision);
    }

    public function deleteArtifact(string $project, string $path, string $expectedRevision): void
    {
        $this->assertWrite($project);
        $this->repository->deleteArtifact($project, $path, $expectedRevision);
    }

    public function history(string $project, string $path): array
    {
        $this->assertRead($project);
        return $this->repository->history($project, $path);
    }

    private function canRead(string $project): bool
    {
        return in_array('projects:admin', $this->principal->scopes, true)
            || in_array('project:' . $project . ':read', $this->principal->scopes, true)
            || in_array('project:' . $project . ':write', $this->principal->scopes, true);
    }

    private function assertRead(string $project): void
    {
        if (!$this->canRead($project)) {
            throw new \RuntimeException('PROJECT_PERMISSION_REQUIRED');
        }
    }

    private function assertWrite(string $project): void
    {
        if (!in_array('projects:admin', $this->principal->scopes, true)
            && !in_array('project:' . $project . ':write', $this->principal->scopes, true)) {
            throw new \RuntimeException('PROJECT_PERMISSION_REQUIRED');
        }
    }
}