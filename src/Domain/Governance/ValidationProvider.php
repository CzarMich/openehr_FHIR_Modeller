<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Governance;

/** Reports come from an installed deterministic executor, never a caller's JSON artefact. */
interface ValidationProvider
{
    /** @return array<string, mixed> */
    public function evaluate(string $content, string $format): array;
}
