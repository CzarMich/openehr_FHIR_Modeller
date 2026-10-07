<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Standards;

/** Standards processors remain independent of repositories, agents and publication servers. */
interface StandardsProvider
{
    public function standard(): string;

    /** @param array<string, mixed> $parameters
     * @return array<string, mixed> */
    public function execute(string $operation, array $parameters): array;
}
