<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\HostedGitRepository;
use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;
use OpenEHR\Assistant\Domain\Repository\OriginalRepository;
use OpenEHR\Assistant\Domain\Repository\OriginalContent;

/** Plain model files in Git; atomic commits and non-force pushes are the persistence boundary. */
final class GitModelRepository implements HostedGitRepository, OriginalRepository
{
    private \OpenEHR\Assistant\Integrations\Cache\ModelReadCache $cache;
    private string $directory;
    private string $branch;
    private string $reviewTarget;
    private string $contentPrefix;
    private bool $flatLayout;
    private string $remote;
    private GitProcess $process;
    private int $syncSeconds;
    /** @var array<string, array{mode: string, size: int}> */
    private array $tree = [];
    private ?string $head = null;

    public function __construct(Settings $settings, private readonly ?HostedRepositoryProvider $provider = null)
    {
        $root = $settings->get('MODEL_REPOSITORY_PATH');
        $this->safeAbsolutePath($root);
        $this->directory = rtrim($root, '/') . '/git';
        $this->safeAbsolutePath($this->directory);
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException('REPOSITORY_UNAVAILABLE');
        }
        $this->flatLayout = $settings->get('MODEL_GIT_LAYOUT') === 'flat';
        $contentPath = $settings->get('MODEL_GIT_CONTENT_PATH');
        if ($contentPath !== '' && (!preg_match('~^[A-Za-z0-9][A-Za-z0-9_/-]*$~D', $contentPath) || str_contains($contentPath, '//') || str_ends_with($contentPath, '/'))) {
            throw new \InvalidArgumentException('INVALID_GIT_CONTENT_PATH');
        }
        $this->contentPrefix = $contentPath === '' ? '' : $contentPath . '/';
        $this->branch = $settings->get('MODEL_GIT_BRANCH');
        $this->branchName($this->branch);
        $this->reviewTarget = $settings->get('MODEL_GIT_REVIEW_TARGET');
        $this->branchName($this->reviewTarget);
        $this->remote = $settings->get('MODEL_GIT_REMOTE_URL');
        $this->validateRemote($this->remote);
        $this->syncSeconds = (int) $settings->get('MODEL_GIT_SYNC_SECONDS');
        $environment = ['GIT_AUTHOR_NAME' => $settings->get('MODEL_GIT_AUTHOR_NAME'),
            'GIT_AUTHOR_EMAIL' => $settings->get('MODEL_GIT_AUTHOR_EMAIL'),
            'GIT_COMMITTER_NAME' => $settings->get('MODEL_GIT_AUTHOR_NAME'),
            'GIT_COMMITTER_EMAIL' => $settings->get('MODEL_GIT_AUTHOR_EMAIL')];
        foreach ($environment as $value) {
            if ($value === '' || strlen($value) > 200 || preg_match('/[\x00-\x1f\x7f<>]/', $value)) {
                throw new \InvalidArgumentException('INVALID_GIT_AUTHOR');
            }
        }
        $key = $settings->get('MODEL_GIT_SSH_KEY_FILE');
        $hosts = $settings->get('MODEL_GIT_KNOWN_HOSTS_FILE');
        if ($key !== '' || $hosts !== '') {
            foreach ([$key, $hosts] as $file) {
                $this->safeAbsolutePath($file);
                if (!is_file($file) || !is_readable($file)) {
                    throw new \InvalidArgumentException('GIT_CREDENTIAL_FILE_UNREADABLE');
                }
            }
            $environment['GIT_SSH_COMMAND'] = 'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -i '
                . escapeshellarg($key) . ' -o UserKnownHostsFile=' . escapeshellarg($hosts);
        } else {
            $environment['GIT_SSH_COMMAND'] = 'ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10';
        }
        $this->cache = new \OpenEHR\Assistant\Integrations\Cache\ModelReadCache(
            $settings,
            'git:' . $this->directory . ':' . $this->remote . ':' . $this->branch . ':' . $this->contentPrefix
        );
        $this->process = new GitProcess($this->directory, (int) $settings->get('MODEL_GIT_TIMEOUT'), $environment);
    }

    public function hosting(): ?HostedRepositoryProvider
    {
        return $this->provider;
    }

    public function capabilities(): array
    {
        return ['storage' => true, 'versioning' => true, 'history' => true, 'branching' => true,
            'diff' => true, 'reviews' => $this->provider !== null, 'approvals' => false, 'locking' => true,
            'webhooks' => false, 'ci' => false, 'releaseTags' => false, 'offline' => $this->remote === '',
            'remoteSync' => $this->remote !== ''];
    }

    public function listProjects(): array
    {
        return $this->locked(false, function (): array {
            $ids = [];
            foreach (array_keys($this->tree) as $path) {
                if (!str_starts_with($path, $this->contentPrefix)) {
                    continue;
                }
                $path = substr($path, strlen($this->contentPrefix));
                if ($path === '.modelling/project.json' || $this->logicalPath($path) !== null) {
                    $ids['default'] = true;
                } elseif (preg_match('~^projects/([A-Za-z0-9][A-Za-z0-9_-]{0,63})/\.modelling/project.json$~D', $path, $matches)) {
                    $ids[$matches[1]] = true;
                }
            }
            return array_map(fn (string $id): array => $this->project($id), array_keys($ids));
        });
    }

    public function getProject(string $id): array
    {
        return $this->locked(false, fn (): array => $this->project($id));
    }

    public function createProject(string $id, string $name, string $description): array
    {
        $this->prefix($id);
        if (trim($name) === '' || strlen($name) > 200 || strlen($description) > 10000) {
            throw new \InvalidArgumentException('Invalid project name or description.');
        }
        return $this->locked(true, function () use ($id, $name, $description): array {
            try {
                $this->project($id);
            } catch (\RuntimeException $error) {
                if ($error->getMessage() !== 'PROJECT_NOT_FOUND') {
                    throw $error;
                }
                $now = gmdate(DATE_ATOM);
                $data = ['id' => $id, 'name' => $name, 'description' => $description, 'status' => 'ACTIVE',
                    'created_at' => $now, 'updated_at' => $now];
                $this->commit([$this->projectPath($id) => $this->json($data)], 'Create modelling project ' . $id);
                return $this->project($id);
            }
            throw new \RuntimeException('PROJECT_ALREADY_EXISTS');
        });
    }

    public function archiveProject(string $id, string $expectedRevision): array
    {
        return $this->locked(true, function () use ($id, $expectedRevision): array {
            $project = $this->project($id);
            if ($project['revision'] !== $expectedRevision) {
                throw new \RuntimeException('REVISION_CONFLICT');
            }
            $project['status'] = 'ARCHIVED';
            $project['updated_at'] = gmdate(DATE_ATOM);
            unset($project['revision'], $project['provider']);
            $this->commit([$this->projectPath($id) => $this->json($project)], 'Archive modelling project ' . $id);
            return $this->project($id);
        });
    }

    public function listArtifacts(string $project): array
    {
        return $this->locked(false, function () use ($project): array {
            $this->project($project);
            $prefix = $this->prefix($project);
            $items = [];
            foreach (array_keys($this->tree) as $fullPath) {
                if (!str_starts_with($fullPath, $prefix)) {
                    continue;
                }
                $path = $this->logicalPath(substr($fullPath, strlen($prefix)));
                if ($path !== null) {
                    $items[] = $this->artifact($project, $path, $this->requiredHead());
                }
            }
            return $items;
        });
    }

    public function getArtifact(string $project, string $path, ?string $revision = null): array
    {
        $this->artifactPath($path);
        return $this->locked(false, function () use ($project, $path, $revision): array {
            $this->project($project);
            $at = $revision ?? $this->requiredHead();
            $this->assertReachable($at);
            return $this->artifact($project, $path, $at, $revision !== null);
        });
    }

    public function saveArtifact(string $project, string $path, string $content, array $metadata, ?string $expectedRevision): array
    {
        $this->artifactPath($path);
        if (OriginalContent::isOriginal($path)) { throw new \RuntimeException('IMPORT_ORIGINAL_IMMUTABLE'); }
        if (strlen($content) > 2097152 || preg_match('//u', $content) !== 1) {
            throw new \InvalidArgumentException('ARTIFACT_TOO_LARGE_OR_INVALID_TEXT');
        }
        \OpenEHR\Assistant\Domain\Repository\ArtifactMetadata::validate($metadata);
        return $this->locked(true, function () use ($project, $path, $content, $metadata, $expectedRevision): array {
            $this->activeProject($project);
            $fullPath = $this->storagePath($project, $path);
            $current = isset($this->tree[$fullPath]) ? $this->artifact($project, $path, $this->requiredHead()) : null;
            if (($current['revision'] ?? null) !== $expectedRevision) {
                throw new \RuntimeException('REVISION_CONFLICT');
            }
            if ($current !== null && $current['content'] === $content && $current['metadata'] === $metadata) {
                return $current;
            }
            $this->commit([$fullPath => $content, $this->metadataPath($project, $path) => $this->json(['metadata' => $metadata])], 'Save model artifact ' . $path);
            return $this->artifact($project, $path, $this->requiredHead());
        });
    }

    public function storeOriginal(string $project, string $path, string $bytes, array $metadata): array
    {
        OriginalContent::assertPath($path);
        OriginalContent::envelope($bytes);
        \OpenEHR\Assistant\Domain\Repository\ArtifactMetadata::validate($metadata);
        return $this->locked(true, function () use ($project, $path, $bytes, $metadata): array {
            $this->activeProject($project);
            $fullPath = $this->storagePath($project, $path);
            // Include historical creation/deletion: an external Git client cannot make an import ID reusable.
            if (isset($this->tree[$fullPath]) || $this->lastChange($this->requiredHead(), [$fullPath]) !== '') {
                throw new \RuntimeException('IMPORT_ORIGINAL_EXISTS');
            }
            $this->commit([$fullPath => $bytes, $this->metadataPath($project, $path) => $this->json(['metadata' => $metadata])], 'Preserve imported model source');
            return $this->artifact($project, $path, $this->requiredHead());
        });
    }

    public function deleteArtifact(string $project, string $path, string $expectedRevision): void
    {
        $this->artifactPath($path);
        if (OriginalContent::isOriginal($path)) { throw new \RuntimeException('IMPORT_ORIGINAL_IMMUTABLE'); }
        $this->locked(true, function () use ($project, $path, $expectedRevision): null {
            $this->activeProject($project);
            $artifact = $this->artifact($project, $path, $this->requiredHead());
            if ($artifact['revision'] !== $expectedRevision) {
                throw new \RuntimeException('REVISION_CONFLICT');
            }
            $this->commit([$this->storagePath($project, $path) => null, $this->metadataPath($project, $path) => null], 'Delete model artifact ' . $path);
            return null;
        });
    }

    public function history(string $project, string $path): array
    {
        $this->artifactPath($path);
        return $this->locked(false, function () use ($project, $path): array {
            $this->project($project);
            $output = trim($this->git(['log', '--format=%H', '--max-count=1001', $this->requiredHead(), '--', $this->storagePath($project, $path), $this->metadataPath($project, $path)]));
            if ($output === '') {
                return [];
            }
            $revisions = explode("\n", $output);
            if (count($revisions) > 1000) {
                throw new \RuntimeException('GIT_HISTORY_LIMIT');
            }
            return array_map(fn (string $revision): array => $this->artifact($project, $path, $revision, true), array_reverse($revisions));
        });
    }

    public function createBranch(string $name, string $baseRevision): string
    {
        $this->branchName($name);
        return $this->locked(true, function () use ($name, $baseRevision): string {
            $this->assertReachable($baseRevision);
            if ($this->process->run($this->arguments(['show-ref', '--verify', '--quiet', 'refs/heads/' . $name]))['code'] === 0) {
                throw new \RuntimeException('GIT_BRANCH_EXISTS');
            }
            if ($this->remote !== '') {
                $existing = $this->process->run($this->arguments(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' . $name]));
                if ($existing['code'] === 0) {
                    throw new \RuntimeException('GIT_BRANCH_EXISTS');
                }
                if ($existing['code'] !== 2) {
                    throw new \RuntimeException('GIT_REMOTE_UNAVAILABLE');
                }
                $this->git(['push', '--porcelain', '--force-with-lease=refs/heads/' . $name . ':', 'origin', $baseRevision . ':refs/heads/' . $name], '', [], 'GIT_PUSH_FAILED');
            }
            $this->git(['update-ref', 'refs/heads/' . $name, $baseRevision, str_repeat('0', 40)]);
            return $baseRevision;
        });
    }

    public function diff(string $baseRevision, string $headRevision): array
    {
        return $this->locked(false, function () use ($baseRevision, $headRevision): array {
            $this->assertReachable($baseRevision);
            $this->assertReachable($headRevision);
            return ['base_revision' => $baseRevision, 'head_revision' => $headRevision,
                'patch' => $this->git(['diff', '--no-ext-diff', '--no-textconv', $baseRevision, $headRevision, '--'])];
        });
    }

    public function createReview(string $branch, string $title, string $body): string
    {
        return (string) ($this->provider ?? throw new \RuntimeException('REPOSITORY_REVIEW_NOT_SUPPORTED'))->requestReview($branch, $this->reviewTarget, $title, $body)['url'];
    }

    /** @return array<string, mixed> */
    private function project(string $id): array
    {
        $path = $this->projectPath($id);
        if ($this->head !== null && isset($this->tree[$path])) {
            $data = json_decode($this->blob($this->head, $path), true, 32, JSON_THROW_ON_ERROR);
            if (!is_array($data) || ($data['id'] ?? null) !== $id || !in_array($data['status'] ?? null, ['ACTIVE', 'ARCHIVED'], true)) {
                throw new \RuntimeException('GIT_INVALID_PROJECT');
            }
            return array_replace($data, ['revision' => $this->lastChange($this->head, [$path]), 'provider' => 'git']);
        }
        // Existing native model repositories are readable without adding assistant metadata.
        if ($id === 'default' && $this->head !== null) {
            foreach (array_keys($this->tree) as $file) {
                if (str_starts_with($file, $this->contentPrefix) && $this->logicalPath(substr($file, strlen($this->contentPrefix))) !== null) {
                    return ['id' => 'default', 'name' => 'Git model repository', 'description' => 'Imported model content',
                        'status' => 'ACTIVE', 'revision' => $this->head, 'provider' => 'git'];
                }
            }
        }
        throw new \RuntimeException('PROJECT_NOT_FOUND');
    }

    private function activeProject(string $id): void
    {
        if ($this->project($id)['status'] !== 'ACTIVE') {
            throw new \RuntimeException('PROJECT_ARCHIVED');
        }
    }

    /** @return array<string, mixed> */
    private function artifact(string $project, string $path, string $at, bool $allowDeleted = false): array
    {
        // Callers already resolved the repository head and checked project/revision access.
        // A commit change (including an external push or deletion) selects a new cache key.
        return $this->cache->remember(
            json_encode([$project, $path, $at, $allowDeleted], JSON_THROW_ON_ERROR),
            fn (): array => $this->uncachedArtifact($project, $path, $at, $allowDeleted)
        );
    }

    /** @return array<string, mixed> */
    private function uncachedArtifact(string $project, string $path, string $at, bool $allowDeleted): array
    {
        $fullPath = $this->storagePath($project, $path);
        $metadataPath = $this->metadataPath($project, $path);
        $tree = $at === $this->head ? $this->tree : $this->validatedTree($at);
        $deleted = !isset($tree[$fullPath]);
        $contentAt = $at;
        if ($deleted) {
            if (!$allowDeleted) {
                throw new \RuntimeException('ARTIFACT_NOT_FOUND');
            }
            $parent = $this->process->run($this->arguments(['rev-parse', '--verify', $at . '^']));
            $contentAt = trim($parent['output']);
            if ($parent['code'] !== 0 || !isset($this->validatedTree($contentAt)[$fullPath])) {
                throw new \RuntimeException('VERSION_NOT_FOUND');
            }
        }
        $content = $this->blob($contentAt, $fullPath);
        if (!OriginalContent::isOriginal($path) && preg_match('//u', $content) !== 1) {
            throw new \RuntimeException('GIT_INVALID_TEXT');
        }
        $metadata = isset($tree[$metadataPath]) ? json_decode($this->blob($at, $metadataPath), true, 32, JSON_THROW_ON_ERROR) : [];
        $revision = $this->lastChange($at, [$fullPath, $metadataPath]);
        return (OriginalContent::isOriginal($path) ? OriginalContent::envelope($content) : []) + ['path' => $path, 'content' => $content, 'metadata' => is_array($metadata) && is_array($metadata['metadata'] ?? null) ? $metadata['metadata'] : [],
            'status' => $deleted ? 'DELETED' : 'DRAFT', 'revision' => $revision, 'sha256' => hash('sha256', $content),
            'updated_at' => trim($this->git(['show', '-s', '--format=%cI', $revision])), 'provider' => 'git'];
    }

    /** @param array<string, string|null> $changes */
    private function commit(array $changes, string $message): void
    {
        $index = tempnam($this->directory, 'index-');
        if ($index === false) {
            throw new \RuntimeException('GIT_IO_FAILED');
        }
        unlink($index);
        $environment = ['GIT_INDEX_FILE' => $index];
        try {
            $this->git($this->head === null ? ['read-tree', '--empty'] : ['read-tree', $this->head], '', $environment);
            foreach ($changes as $path => $content) {
                if ($content === null) {
                    $this->git(['update-index', '--index-info'], '0 ' . str_repeat('0', 40) . "\t" . $path . "\n", $environment);
                } else {
                    $blob = trim($this->git(['hash-object', '-w', '--stdin'], $content));
                    $this->git(['update-index', '--add', '--cacheinfo', '100644,' . $blob . ',' . $path], '', $environment);
                }
            }
            $tree = trim($this->git(['write-tree'], '', $environment));
            $this->validatedTree($tree);
            $arguments = ['commit-tree', $tree];
            if ($this->head !== null) {
                $arguments = [...$arguments, '-p', $this->head];
            }
            $next = trim($this->git([...$arguments, '-m', $message]));
            if ($this->remote !== '') {
                // A competing remote writer causes rejection; local HEAD remains unchanged.
                $this->git(['push', '--porcelain', 'origin', $next . ':refs/heads/' . $this->branch], '', [], 'GIT_PUSH_FAILED');
            }
            $this->git(['update-ref', 'refs/heads/' . $this->branch, $next, $this->head ?? str_repeat('0', 40)]);
            $this->head = $next;
            $this->tree = $this->validatedTree($next);
            file_put_contents($this->directory . '/last-sync', (string) time());
        } finally {
            foreach ([$index, $index . '.lock'] as $file) {
                if (is_file($file)) {
                    unlink($file);
                }
            }
        }
    }

    /** @template T
     * @param callable(): T $operation
     * @return T
     */
    private function locked(bool $write, callable $operation): mixed
    {
        $lockPath = $this->directory . '/repository.lock';
        $this->safeAbsolutePath($lockPath);
        $lock = fopen($lockPath, 'c');
        if ($lock === false) {
            throw new \RuntimeException('REPOSITORY_LOCK_FAILED');
        }
        $started = microtime(true);
        while (!flock($lock, LOCK_EX | LOCK_NB)) {
            if (microtime(true) - $started > 30) {
                fclose($lock);
                throw new \RuntimeException('REPOSITORY_LOCK_TIMEOUT');
            }
            usleep(10000);
        }
        try {
            $repo = $this->directory . '/objects.git';
            $this->safeAbsolutePath($repo);
            if (!is_dir($repo)) {
                $this->git(['init', '--bare', '--initial-branch=' . $this->branch, $repo]);
            }
            // Every operation passes the bare repository path explicitly; no worktree is executed.
            $current = $this->process->run(['--git-dir=' . $repo, 'rev-parse', '--verify', 'refs/heads/' . $this->branch]);
            $this->head = $current['code'] === 0 ? trim($current['output']) : null;
            $this->sync($write);
            $this->tree = $this->head === null ? [] : $this->validatedTree($this->head);
            return $operation();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function sync(bool $write): void
    {
        if ($this->remote === '') {
            return;
        }
        $existing = $this->process->run($this->arguments(['remote', 'get-url', 'origin']));
        if ($existing['code'] !== 0) {
            $this->git(['remote', 'add', 'origin', $this->remote]);
        } elseif (trim($existing['output']) !== $this->remote) {
            throw new \RuntimeException('GIT_REMOTE_CHANGED_USE_NEW_PATH');
        }
        $stamp = $this->directory . '/last-sync';
        $this->safeAbsolutePath($stamp);
        if (!$write && is_file($stamp) && time() - (int) file_get_contents($stamp) < $this->syncSeconds) {
            return;
        }
        $remote = $this->process->run($this->arguments(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' . $this->branch]));
        if ($remote['code'] === 2) {
            if ($this->head !== null) {
                throw new \RuntimeException('GIT_REMOTE_BRANCH_REMOVED');
            }
        } elseif ($remote['code'] !== 0) {
            throw new \RuntimeException('GIT_REMOTE_UNAVAILABLE');
        } elseif ($this->head === null || trim($remote['output']) !== $this->head . "\trefs/heads/" . $this->branch) {
            // ls-remote already identifies unchanged content; fetching it again adds a network round trip.
            $this->git(['fetch', '--no-tags', 'origin', '+refs/heads/' . $this->branch . ':refs/remotes/origin/' . $this->branch]);
            $next = trim($this->git(['rev-parse', 'refs/remotes/origin/' . $this->branch]));
            $this->validatedTree($next);
            if ($this->head !== null && $this->process->run($this->arguments(['merge-base', '--is-ancestor', $this->head, $next]))['code'] !== 0) {
                throw new \RuntimeException('GIT_REMOTE_DIVERGED');
            }
            $this->git(['update-ref', 'refs/heads/' . $this->branch, $next, $this->head ?? str_repeat('0', 40)]);
            $this->head = $next;
        }
        file_put_contents($stamp, (string) time());
    }

    /** @return array<string, array{mode: string, size: int}> */
    private function validatedTree(string $revision): array
    {
        $output = $this->git(['ls-tree', '-rlz', '--full-tree', $revision]);
        $files = [];
        $total = 0;
        foreach (explode("\0", $output) as $record) {
            if ($record === '') {
                continue;
            }
            if (!preg_match('/^(100644|100755) blob [a-f0-9]+ +([0-9]+)\t([^\x00-\x1f\x7f]+)$/D', $record, $match)) {
                throw new \RuntimeException('GIT_UNSAFE_TREE');
            }
            $size = (int) $match[2];
            $total += $size;
            if ($size > 2097152 || $total > 33554432 || count($files) >= 10000) {
                throw new \RuntimeException('GIT_TREE_SIZE_LIMIT');
            }
            $files[$match[3]] = ['mode' => $match[1], 'size' => $size];
        }
        return $files;
    }

    private function blob(string $revision, string $path): string
    {
        return $this->git(['show', $revision . ':' . $path], '', [], 'ARTIFACT_NOT_FOUND');
    }

    /** @param list<string> $paths */
    private function lastChange(string $at, array $paths): string
    {
        return trim($this->git(['log', '-1', '--format=%H', $at, '--', ...$paths]));
    }

    private function assertReachable(string $revision): void
    {
        if (!preg_match('/^[a-f0-9]{40}$/D', $revision) || $this->head === null
            || $this->process->run($this->arguments(['merge-base', '--is-ancestor', $revision, $this->head]))['code'] !== 0) {
            throw new \RuntimeException('VERSION_NOT_FOUND');
        }
    }

    private function requiredHead(): string
    {
        return $this->head ?? throw new \RuntimeException('PROJECT_NOT_FOUND');
    }
    private function projectPath(string $id): string
    {
        return $this->prefix($id) . '.modelling/project.json';
    }
    private function metadataPath(string $id, string $path): string
    {
        return $this->prefix($id) . '.modelling/artifacts/' . hash('sha256', $path) . '.json';
    }
    private function prefix(string $id): string
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/D', $id)) {
            throw new \InvalidArgumentException('INVALID_PROJECT_ID');
        }
        return $this->contentPrefix . ($id === 'default' ? '' : 'projects/' . $id . '/');
    }
    private function logicalPath(string $relative): ?string
    {
        if ($this->flatLayout) {
            if (str_starts_with($relative, 'archetypes/') || str_starts_with($relative, 'templates/')) {
                return null;
            }
            if (!str_contains($relative, '/')) {
                if (preg_match('/\\.(adl|adls|adlf|a\\.json)$/D', $relative)) {
                    $relative = 'archetypes/' . $relative;
                } elseif (preg_match('/\\.(t\\.json|oet|opt)$/D', $relative)) {
                    $relative = 'templates/' . $relative;
                }
            }
        }
        return $this->isArtifactPath($relative) ? $relative : null;
    }

    private function storagePath(string $project, string $path): string
    {
        $relative = $path;
        if ($this->flatLayout && (str_starts_with($path, 'archetypes/') || str_starts_with($path, 'templates/'))) {
            $relative = substr($path, strpos($path, '/') + 1);
            if (str_contains($relative, '/') || $this->logicalPath($relative) !== $path) {
                throw new \InvalidArgumentException('GIT_FLAT_LAYOUT_REQUIRES_NATIVE_FILENAME');
            }
        }
        return $this->prefix($project) . $relative;
    }

    private function isArtifactPath(string $path): bool
    {
        if (OriginalContent::isOriginal($path)) {
            try { OriginalContent::assertPath($path); return true; }
            catch (\InvalidArgumentException) { return false; }
        }
        return strlen($path) <= 240 && preg_match('//u', $path) === 1
            && preg_match('~^(requirements|archetypes|templates|terminology|aql|tests|validation|decisions|documentation)/[^\\x00-\\x1f\\x7f]+$~D', $path) === 1
            && !str_contains($path, '\\') && !str_contains($path, '%') && !str_contains($path, '//')
            && !preg_match('~(^|/)\\.{1,2}(/|$)~D', $path) && !str_ends_with($path, '/');
    }
    private function artifactPath(string $path): void
    {
        if (!$this->isArtifactPath($path)) {
            throw new \InvalidArgumentException('INVALID_ARTIFACT_PATH');
        }
    }
    private function branchName(string $name): void
    {
        if (!preg_match('~^[A-Za-z0-9][A-Za-z0-9_./-]{0,119}$~D', $name) || str_contains($name, '..') || str_contains($name, '//') || str_ends_with($name, '/') || str_ends_with($name, '.lock')) {
            throw new \InvalidArgumentException('INVALID_GIT_BRANCH');
        }
    }
    private function validateRemote(string $remote): void
    {
        if ($remote === '') {
            return;
        }
        if (str_starts_with($remote, '/')) {
            $this->safeAbsolutePath($remote);
            return;
        }
        $parts = parse_url($remote);
        if ($parts === false || !in_array($parts['scheme'] ?? '', ['https', 'ssh'], true) || empty($parts['host'])
            || isset($parts['pass'], $parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || ($parts['scheme'] === 'https' && isset($parts['user'])) || preg_match('/[\x00-\x20\x7f]/', $remote)) {
            throw new \InvalidArgumentException('INVALID_GIT_REMOTE');
        }
    }
    private function safeAbsolutePath(string $path): void
    {
        if (!str_starts_with($path, '/') || preg_match('/[\x00-\x1f\x7f]/', $path)) {
            throw new \InvalidArgumentException('INVALID_REPOSITORY_PATH');
        }
        $current = '';
        foreach (explode('/', $path) as $part) {
            if ($part === '') {
                continue;
            }
            if ($part === '.' || $part === '..') {
                throw new \InvalidArgumentException('INVALID_REPOSITORY_PATH');
            }
            $current .= '/' . $part;
            if (is_link($current)) {
                throw new \InvalidArgumentException('REPOSITORY_SYMLINK_FORBIDDEN');
            }
        }
    }
    /** @param array<string, mixed> $value */
    private function json(array $value): string
    {
        return json_encode($value, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
    }
    /** @param list<string> $arguments
     * @return list<string> */
    private function arguments(array $arguments): array
    {
        return ['--git-dir=' . $this->directory . '/objects.git', ...$arguments];
    }
    /** @param list<string> $arguments
     * @param array<string, string> $environment */
    private function git(array $arguments, string $input = '', array $environment = [], string $error = 'GIT_OPERATION_FAILED'): string
    {
        $command = $arguments[0] === 'init' ? $arguments : $this->arguments($arguments);
        $result = $this->process->run($command, $input, $environment);
        if ($result['code'] !== 0) {
            throw new \RuntimeException($error);
        }
        return $result['output'];
    }
}
