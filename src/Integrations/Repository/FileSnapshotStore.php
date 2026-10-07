<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Domain\Repository\SnapshotStore;
use RuntimeException;
use InvalidArgumentException;

/** Single-node atomic project snapshots with optimistic concurrency and immutable artefact revisions. */
final class FileSnapshotStore implements SnapshotStore
{
    private readonly string $root;

    public function __construct(string $root, private readonly ?\OpenEHR\Assistant\Integrations\Cache\ModelReadCache $cache = null)
    {
        if (!str_starts_with($root, '/') || str_contains($root, "\0")) {
            throw new InvalidArgumentException('Repository root must be an absolute path.');
        }
        $this->assertNoSymlinks($root);
        if (!is_dir($root) && !mkdir($root, 0700, true) && !is_dir($root)) {
            throw new RuntimeException('REPOSITORY_UNAVAILABLE');
        }
        $this->root = realpath($root) ?: throw new RuntimeException('REPOSITORY_UNAVAILABLE');
    }

    public function listIds(): array
    {
        return array_map(static fn (string $path): string => basename($path, '.json'), glob($this->root . '/*.json') ?: []);
    }

    private function projectPath(string $id): string
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/D', $id)) {
            throw new InvalidArgumentException('INVALID_PROJECT_ID');
        }
        $path = $this->root . '/' . $id . '.json';
        $this->assertNoSymlinks($path);
        return $path;
    }

    private function assertNoSymlinks(string $path): void
    {
        $current = '';
        foreach (explode('/', $path) as $part) {
            if ($part === '') {
                continue;
            }
            if ($part === '..' || $part === '.') {
                throw new InvalidArgumentException('INVALID_REPOSITORY_PATH');
            }
            $current .= '/' . $part;
            if (is_link($current)) {
                throw new InvalidArgumentException('REPOSITORY_SYMLINK_FORBIDDEN');
            }
        }
    }

    /**
     * @return array<string, mixed> */
    public function read(string $id): array
    {
        $path = $this->projectPath($id);
        if (!is_file($path)) {
            throw new RuntimeException('PROJECT_NOT_FOUND');
        }
        if (filesize($path) > 33554432) {
            throw new RuntimeException('PROJECT_SIZE_LIMIT');
        }
        $raw = (string) file_get_contents($path);
        $decode = static function () use ($raw): array {
            $state = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
            if (!is_array($state) || !isset($state['project'], $state['artifacts'], $state['history'])) {
                throw new RuntimeException('REPOSITORY_INVALID_SNAPSHOT');
            }
            return $state;
        };
        return $this->cache?->remember($id . ':' . hash('sha256', $raw), $decode) ?? $decode();
    }

    /**
     * @param callable(array<string, mixed>): array{array<string, mixed>, array<string, mixed>} $operation
     *
     * @return array<string, mixed>
     */
    public function transaction(string $id, callable $operation, bool $create = false): array
    {
        $path = $this->projectPath($id);
        $this->assertNoSymlinks($path . '.lock');
        $lock = fopen($path . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) {
            throw new RuntimeException('REPOSITORY_LOCK_FAILED');
        }
        $temporary = null;
        try {
            $state = $create && !file_exists($path) ? [] : $this->read($id);
            [$next, $result] = $operation($state);
            $next['project']['updated_at'] = gmdate(DATE_ATOM);
            $data = json_encode($next, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
            if (strlen($data) > 33554432) {
                throw new RuntimeException('PROJECT_SIZE_LIMIT');
            }
            $temporary = tempnam($this->root, '.write-');
            if ($temporary === false || file_put_contents($temporary, $data, LOCK_EX) !== strlen($data)) {
                throw new RuntimeException('REPOSITORY_WRITE_FAILED');
            }
            chmod($temporary, 0600);
            $this->assertNoSymlinks($path);
            if (!rename($temporary, $path)) {
                throw new RuntimeException('REPOSITORY_WRITE_FAILED');
            }
            return $result;
        } finally {
            if (is_string($temporary) && is_file($temporary)) {
                unlink($temporary);
            }
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
