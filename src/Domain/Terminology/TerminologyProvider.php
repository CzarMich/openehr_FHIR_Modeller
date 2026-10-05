<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

interface TerminologyProvider
{
    /**
     * @return array<string, mixed> */
    public function lookup(string $system, string $code, ?string $version = null, ?string $language = null): array;
    /**
     * @return array<string, mixed> */
    public function validateCode(string $system, string $code, ?string $valueSet = null, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array;
    /**
     * @return array<string, mixed> */
    public function expand(string $valueSet, ?string $version = null, int $count = 50, int $offset = 0,
        ?string $language = null, ?string $filter = null): array;
}
