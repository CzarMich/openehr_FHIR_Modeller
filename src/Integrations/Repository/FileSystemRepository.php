<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Domain\Repository\SnapshotRepository;

/** Compatible filesystem repository with shared snapshot-domain semantics. */
final class FileSystemRepository extends SnapshotRepository
{
    public function __construct(string $root, ?\OpenEHR\Assistant\Integrations\Cache\ModelReadCache $cache = null)
    {
        parent::__construct(new FileSnapshotStore($root, $cache), 'filesystem', true);
    }
}
