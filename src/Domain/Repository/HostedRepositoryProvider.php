<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Optional hosting capabilities; no provider or transport types enter the domain. */
interface HostedRepositoryProvider
{
    /** @return array<string, mixed> */
    public function metadata(): array;
    /** @return array<string, mixed> */
    public function branches(int $page = 1): array;
    /** @return array<string, mixed> */
    public function review(int $number): array;
    /** Creates a draft or returns the existing open request; never approves or merges.
     * @return array<string, mixed> */
    public function requestReview(string $branch, string $target, string $title, string $body): array;
}
