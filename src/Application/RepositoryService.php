<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\GitRepository;
use OpenEHR\Assistant\Domain\Repository\HostedGitRepository;
use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;

/** Shared application operations, independent of MCP/REST/CLI presentation. */
final readonly class RepositoryService
{
    public function __construct(private ModelRepository $repository, private AccessPolicy $access, private Settings $settings) {}

    /** @return array<string, mixed> */
    public function info(): array
    {
        $hosting = $this->repository instanceof HostedGitRepository ? $this->repository->hosting() : null;
        return ['capabilities' => $this->repository->capabilities(), 'hosting' => $hosting?->metadata(),
            'active_branch' => $this->repository instanceof GitRepository ? $this->settings->get('MODEL_GIT_BRANCH') : null];
    }

    /** @return array<string, mixed> */
    public function branches(int $page = 1): array { return $this->hosting()->branches($page); }

    /** @return array<string, mixed> */
    public function createBranch(string $branch, string $baseRevision): array
    {
        $this->access->assertModelWrite();
        return ['branch' => $branch, 'revision' => $this->git()->createBranch($branch, $baseRevision), 'active_branch_changed' => false];
    }

    /** @return array<string, mixed> */
    public function requestReview(string $branch, string $title, string $body): array
    {
        $this->access->assertModelWrite();
        return $this->hosting()->requestReview($branch, $this->settings->get('MODEL_GIT_REVIEW_TARGET'), $title, $body);
    }

    /** @return array<string, mixed> */
    public function review(int $number): array { return $this->hosting()->review($number); }

    /** @return array<string, mixed> */
    public function diff(string $baseRevision, string $headRevision): array { return $this->git()->diff($baseRevision, $headRevision); }

    private function hosting(): HostedRepositoryProvider
    {
        return ($this->repository instanceof HostedGitRepository ? $this->repository->hosting() : null)
            ?? throw new \RuntimeException('HOSTED_REPOSITORY_NOT_CONFIGURED');
    }

    private function git(): GitRepository
    {
        return $this->repository instanceof GitRepository ? $this->repository : throw new \RuntimeException('GIT_REPOSITORY_REQUIRED');
    }
}
