<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Knowledge;

interface CkmSearchProvider
{
    /** @return array<string, string> Named, configured base URLs; no credentials. */
    public function sources(): array;

    /** @return array{items: list<array<string, mixed>>, total: int} */
    public function search(string $source, string $kind, string $keyword, int $limit, float $timeout): array;
}
