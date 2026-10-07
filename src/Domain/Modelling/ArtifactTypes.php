<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Modelling;

/** Representation types, not assertions of clinical or semantic validity. */
final class ArtifactTypes
{
    public const array ALL = ['ADL_ARCHETYPE', 'ADL_TEMPLATE', 'OET_TEMPLATE', 'OPT', 'WEB_TEMPLATE',
        'DESIGNER_AUTHORING_JSON', 'CANONICAL_COMPOSITION', 'FLAT_COMPOSITION', 'STRUCTURED_COMPOSITION',
        'TERMINOLOGY_ARTEFACT', 'MODEL_PACKAGE', 'OTHER', 'UNKNOWN'];

    public static function assert(string $type): void
    {
        if (!in_array($type, self::ALL, true)) {
            throw new \InvalidArgumentException('IMPORT_ARTIFACT_TYPE_INVALID');
        }
    }
}
