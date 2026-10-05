<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Atomic project snapshots. A failed conditional commit must never publish the candidate state. */
interface SnapshotStore
{
    /** @return list<string> */
    public function listIds(): array;
    /** @return array<string, mixed> */
    public function read(string $id): array;
    /** @param callable(array<string, mixed>): array{array<string, mixed>, array<string, mixed>} $operation
     * @return array<string, mixed> */
    public function transaction(string $id, callable $operation, bool $create = false): array;
}
