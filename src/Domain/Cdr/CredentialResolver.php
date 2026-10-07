<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Cdr;

/** Implementations may use encrypted application storage, environment, OS keychains or an external vault. */
interface CredentialResolver
{
    /**
     * @param array<string, mixed> $connection
     * @return array<string, string> */
    public function resolve(array $connection): array;
}
