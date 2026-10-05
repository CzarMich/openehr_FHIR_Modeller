<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Modelling;

interface ArchetypeSource
{
    /**
     * @return array{id: string, rm_class: string, content: string, provenance: array<string, mixed>} */
    public function fetch(string $identifier, ?string $source = null): array;
}
