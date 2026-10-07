<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Create-only native sources; ordinary model writes and deletions cannot alter this namespace. */
interface OriginalRepository
{
    /** @param array<string, mixed> $metadata
     * @return array<string, mixed> */
    public function storeOriginal(string $project, string $path, string $bytes, array $metadata): array;
}
