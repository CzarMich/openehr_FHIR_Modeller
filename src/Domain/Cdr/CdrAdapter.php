<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Cdr;

/** Remote CDR client boundary. No operational clinical persistence or model-repository writes. */
interface CdrAdapter
{
    /**
     * @param array<string, mixed> $connection
     * @return array<string, mixed> */
    public function test(array $connection): array;

    /**
     * @param array<string, mixed> $connection
     *
     * @param array<string, mixed> $parameters
     *
     * @param callable(): bool $cancelled
     *
     * @return array<string, mixed> */
    public function execute(array $connection, string $query, array $parameters, ?int $fetch, ?int $offset, callable $cancelled): array;

    /**
     * @param array<string, mixed> $connection
     * @return array<string, mixed> */
    public function templates(array $connection, ?string $identifier = null): array;
}
