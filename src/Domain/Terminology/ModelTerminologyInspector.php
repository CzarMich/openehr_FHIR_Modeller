<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

interface ModelTerminologyInspector
{
    /** Inspect source constraints without changing the model or asserting engine conformance.
     * @return array<string, mixed> */
    public function inspect(string $content, string $format): array;
}
