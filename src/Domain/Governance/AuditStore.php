<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Governance;

/** Authoritative governance state is separate from user-editable model artefacts. */
interface AuditStore
{
    /** @return list<array<string, mixed>> */
    public function subjects(string $tenant, string $project, int $limit = 100, int $offset = 0, ?string $firstType = null): array;
    /** @return list<array<string, mixed>> */
    public function events(string $tenant, string $subject): array;
    /** Atomic append against the observed sequence. The store assigns sequence/time/hash.
     * @param array<string, mixed> $event
     * @return array<string, mixed> */
    public function append(string $tenant, string $subject, int $expectedSequence, array $event): array;
    /** Atomically consume a short-lived transport assertion identifier. */
    public function consumeNonce(string $nonce, int $expires): void;
}
