<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Traceability;

interface AnchorInspector
{
    /**
     * @param array{kind: string, value: string} $anchor
     * @return array<string, mixed> */
    public function inspect(string $content, array $anchor): array;
}
