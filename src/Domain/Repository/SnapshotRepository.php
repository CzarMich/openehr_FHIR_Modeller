<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

use RuntimeException;
use InvalidArgumentException;

/** Shared revision, history and governance semantics over atomic snapshot storage. */
class SnapshotRepository implements ModelRepository, OriginalRepository
{
    public function __construct(private readonly SnapshotStore $store, private readonly string $provider, private readonly bool $offline) {}

    public function capabilities(): array
    {
        return ['storage' => true, 'versioning' => true, 'history' => true, 'branching' => false,
            'diff' => false, 'reviews' => false, 'approvals' => false, 'locking' => true,
            'webhooks' => false, 'ci' => false, 'releaseTags' => false, 'offline' => $this->offline];
    }

    public function listProjects(): array { return array_map($this->getProject(...), $this->store->listIds()); }

    public function getProject(string $id): array
    {
        return $this->load($id)['project'];
    }

    public function createProject(string $id, string $name, string $description): array
    {
        if (trim($name) === '' || strlen($name) > 200 || strlen($description) > 10000) {
            throw new InvalidArgumentException('Invalid project name or description.');
        }
        return $this->transaction($id, function (array $state) use ($id, $name, $description): array {
            if ($state !== []) {
                throw new RuntimeException('PROJECT_ALREADY_EXISTS');
            }
            $now = gmdate(DATE_ATOM);
            $project = ['id' => $id, 'name' => $name, 'description' => $description, 'status' => 'ACTIVE',
                'revision' => bin2hex(random_bytes(16)), 'created_at' => $now, 'updated_at' => $now];
            return [['project' => $project, 'artifacts' => [], 'history' => []], $project];
        }, true);
    }

    public function archiveProject(string $id, string $expectedRevision): array
    {
        return $this->transaction($id, function (array $state) use ($expectedRevision): array {
            if ($state['project']['revision'] !== $expectedRevision) {
                throw new RuntimeException('REVISION_CONFLICT');
            }
            $state['project']['status'] = 'ARCHIVED';
            $state['project']['revision'] = bin2hex(random_bytes(16));
            return [$state, $state['project']];
        });
    }

    public function listArtifacts(string $project): array
    {
        return array_values($this->load($project)['artifacts']);
    }

    public function getArtifact(string $project, string $path, ?string $revision = null): array
    {
        $this->artifactPath($path);
        $state = $this->load($project);
        if ($revision === null) {
            return $state['artifacts'][$path] ?? throw new RuntimeException('ARTIFACT_NOT_FOUND');
        }
        foreach ($state['history'][$path] ?? [] as $item) {
            if ($item['revision'] === $revision) {
                return $item;
            }
        }
        throw new RuntimeException('VERSION_NOT_FOUND');
    }

    public function saveArtifact(string $project, string $path, string $content, array $metadata, ?string $expectedRevision): array
    {
        $this->artifactPath($path);
        if (OriginalContent::isOriginal($path)) { throw new RuntimeException('IMPORT_ORIGINAL_IMMUTABLE'); }
        if (strlen($content) > 2097152) {
            throw new InvalidArgumentException('ARTIFACT_TOO_LARGE');
        }
        ArtifactMetadata::validate($metadata);
        return $this->transaction($project, function (array $state) use ($path, $content, $metadata, $expectedRevision): array {
            $this->assertActive($state);
            $current = $state['artifacts'][$path] ?? null;
            if (($current['revision'] ?? null) !== $expectedRevision) {
                throw new RuntimeException('REVISION_CONFLICT');
            }
            if ($current !== null && $current['status'] !== 'DELETED' && $current['content'] === $content && $current['metadata'] === $metadata) {
                return [$state, $current];
            }
            $artifact = ['path' => $path, 'content' => $content, 'metadata' => $metadata, 'status' => 'DRAFT',
                'revision' => bin2hex(random_bytes(16)), 'sha256' => hash('sha256', $content),
                'updated_at' => gmdate(DATE_ATOM), 'provider' => $this->provider];
            $state['artifacts'][$path] = $artifact;
            $state['history'][$path][] = $artifact;
            return [$state, $artifact];
        });
    }

    public function storeOriginal(string $project, string $path, string $bytes, array $metadata): array
    {
        OriginalContent::assertPath($path);
        $payload = OriginalContent::envelope($bytes);
        ArtifactMetadata::validate($metadata);
        return $this->transaction($project, function (array $state) use ($path, $payload, $metadata): array {
            $this->assertActive($state);
            if (isset($state['artifacts'][$path]) || isset($state['history'][$path])) {
                throw new RuntimeException('IMPORT_ORIGINAL_EXISTS');
            }
            $artifact = ['path' => $path, 'metadata' => $metadata, 'status' => 'DRAFT',
                'revision' => bin2hex(random_bytes(16)), 'updated_at' => gmdate(DATE_ATOM), 'provider' => $this->provider] + $payload;
            $state['artifacts'][$path] = $artifact;
            $state['history'][$path][] = $artifact;
            return [$state, $artifact];
        });
    }

    public function deleteArtifact(string $project, string $path, string $expectedRevision): void
    {
        $this->artifactPath($path);
        if (OriginalContent::isOriginal($path)) { throw new RuntimeException('IMPORT_ORIGINAL_IMMUTABLE'); }
        $this->transaction($project, function (array $state) use ($path, $expectedRevision): array {
            $this->assertActive($state);
            $current = $state['artifacts'][$path] ?? throw new RuntimeException('ARTIFACT_NOT_FOUND');
            if ($current['revision'] !== $expectedRevision) {
                throw new RuntimeException('REVISION_CONFLICT');
            }
            $current['status'] = 'DELETED';
            $current['revision'] = bin2hex(random_bytes(16));
            $current['updated_at'] = gmdate(DATE_ATOM);
            $state['history'][$path][] = $current;
            unset($state['artifacts'][$path]);
            return [$state, []];
        });
    }

    public function history(string $project, string $path): array
    {
        $this->artifactPath($path);
        return $this->load($project)['history'][$path] ?? [];
    }

    private function artifactPath(string $path): void
    {
        if (OriginalContent::isOriginal($path)) { OriginalContent::assertPath($path); return; }
        if (strlen($path) > 240 || !preg_match('~^(requirements|archetypes|templates|terminology|aql|tests|validation|decisions|documentation|fhir|mappings)/[A-Za-z0-9_./-]+$~D', $path)
            || str_contains($path, '..') || str_contains($path, '//') || str_ends_with($path, '/')) {
            throw new InvalidArgumentException('INVALID_ARTIFACT_PATH');
        }
    }

    /**
     * @param array<string, mixed> $state */
    private function assertActive(array $state): void
    {
        if ($state['project']['status'] !== 'ACTIVE') {
            throw new RuntimeException('PROJECT_ARCHIVED');
        }
    }


    /** @return array<string, mixed> */
    private function load(string $id): array { return $this->store->read($id); }

    /** @param callable(array<string, mixed>): array{array<string, mixed>, array<string, mixed>} $operation
     * @return array<string, mixed> */
    private function transaction(string $id, callable $operation, bool $create = false): array
    { return $this->store->transaction($id, $operation, $create); }
}
