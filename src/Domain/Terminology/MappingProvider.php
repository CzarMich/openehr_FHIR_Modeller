<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

interface MappingProvider
{
    /** @return array<string, mixed> */
    public function translate(string $conceptMap, string $system, string $code, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $sourceValueSet = null, ?string $targetValueSet = null,
        ?string $targetSystem = null): array;
}
