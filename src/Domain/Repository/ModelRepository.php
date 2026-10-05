<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Storage boundary: domain consumers use provider-neutral revisions and logical artefact paths. */
interface ModelRepository
{
    /**
     * @return array<string, bool> */
    public function capabilities(): array;
    /**
     * @return list<array<string, mixed>> */
    public function listProjects(): array;
    /**
     * @return array<string, mixed> */
    public function getProject(string $id): array;
    /**
     * @return array<string, mixed> */
    public function createProject(string $id, string $name, string $description): array;
    /**
     * @return array<string, mixed> */
    public function archiveProject(string $id, string $expectedRevision): array;
    /**
     * @return list<array<string, mixed>> */
    public function listArtifacts(string $project): array;
    /**
     * @return array<string, mixed> */
    public function getArtifact(string $project, string $path, ?string $revision = null): array;
    /**
     * @param array<string, mixed> $metadata
     * @return array<string, mixed> */
    public function saveArtifact(string $project, string $path, string $content, array $metadata, ?string $expectedRevision): array;
    public function deleteArtifact(string $project, string $path, string $expectedRevision): void;
    /**
     * @return list<array<string, mixed>> */
    public function history(string $project, string $path): array;
}
