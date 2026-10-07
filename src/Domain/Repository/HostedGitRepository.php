<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

interface HostedGitRepository extends GitRepository
{
    public function hosting(): ?HostedRepositoryProvider;
}
