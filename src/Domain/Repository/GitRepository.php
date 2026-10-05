<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Git storage and branch/diff boundary. Hosted review creation is an optional capability. */
interface GitRepository extends ModelRepository
{
    public function createBranch(string $name, string $baseRevision): string;
    /**
     * @return array<string, mixed> */
    public function diff(string $baseRevision, string $headRevision): array;
    public function createReview(string $branch, string $title, string $body): string;
}
