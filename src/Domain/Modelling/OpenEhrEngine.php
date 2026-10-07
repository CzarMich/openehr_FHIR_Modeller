<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Modelling;

/** Native language operations; dependencies have already been selected by the application. */
interface OpenEhrEngine
{
    /** @param list<array{identifier: string, content: string, sha256: string}> $dependencies
     * @return array<string, mixed> */
    public function validate(string $content, string $format, array $dependencies = []): array;

    /** @param list<array{identifier: string, content: string, sha256: string}> $dependencies
     * @return array<string, mixed> */
    public function compile(string $content, array $dependencies): array;

    /** @param list<array{identifier: string, content: string, sha256: string}> $dependencies
     * @return array<string, mixed> */
    public function inspect(string $content, string $format, array $dependencies = []): array;
}
