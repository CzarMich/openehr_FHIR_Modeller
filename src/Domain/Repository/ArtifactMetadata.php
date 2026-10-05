<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Repository;

/** Metadata must remain readable inside every provider's bounded revision envelope. */
final class ArtifactMetadata
{
    /** @param array<string, mixed> $metadata */
    public static function validate(array $metadata): void
    {
        try { $json = json_encode($metadata, JSON_THROW_ON_ERROR, 16); }
        catch (\JsonException) { throw new \InvalidArgumentException('INVALID_ARTIFACT_METADATA'); }
        if (strlen($json) > 65536) { throw new \InvalidArgumentException('ARTIFACT_TOO_LARGE'); }
        foreach (['status', 'validation', 'approved_by', 'released_by', 'revision', 'created_by'] as $field) {
            if (array_key_exists($field, $metadata)) { throw new \InvalidArgumentException('RESERVED_METADATA_FIELD: ' . $field); }
        }
    }
}
