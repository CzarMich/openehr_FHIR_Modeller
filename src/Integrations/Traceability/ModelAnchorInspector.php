<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Traceability;

use OpenEHR\Assistant\Domain\Traceability\AnchorInspector;
use OpenEHR\Assistant\Validation\JsonDocument;
use OpenEHR\Assistant\Validation\ModelValidator;
use OpenEHR\Assistant\Validation\XmlLocations;

final class ModelAnchorInspector implements AnchorInspector
{
    public function inspect(string $content, array $anchor): array
    {
        if ($anchor['kind'] === 'openehr_path') {
            return ['status' => 'NOT_EXECUTED', 'reason' => 'Native inherited openEHR path resolution requires the qualified engine.'];
        }
        try {
            if ($anchor['kind'] === 'xml_location') {
                $index = XmlLocations::index(ModelValidator::xml($content));
                if (!isset($index[$anchor['value']])) {
                    throw new \InvalidArgumentException('TRACEABILITY_ANCHOR_NOT_FOUND');
                }
                $node = $index[$anchor['value']];
                $encoded = $node->ownerDocument?->saveXML($node);
                if ($encoded === false || $encoded === null) {
                    throw new \InvalidArgumentException('TRACEABILITY_ANCHOR_NOT_FOUND');
                }
            } elseif ($anchor['kind'] === 'json_pointer') {
                $value = JsonDocument::parse($content);
                $pointer = $anchor['value'];
                if (!str_starts_with($pointer, '/') || preg_match('/~(?![01])/', $pointer)) {
                    throw new \InvalidArgumentException('INVALID_JSON_POINTER');
                }
                $tokens = explode('/', substr($pointer, 1));
                if (count($tokens) > 64) {
                    throw new \InvalidArgumentException('JSON_POINTER_DEPTH_LIMIT');
                }
                foreach ($tokens as $token) {
                    $key = str_replace(['~1', '~0'], ['/', '~'], $token);
                    if ($value instanceof \stdClass && property_exists($value, $key)) {
                        $value = $value->{$key};
                    } elseif (is_array($value) && preg_match('/^(?:0|[1-9][0-9]{0,9})$/D', $key) && array_key_exists((int) $key, $value)) {
                        $value = $value[(int) $key];
                    } else {
                        throw new \InvalidArgumentException('TRACEABILITY_ANCHOR_NOT_FOUND');
                    }
                }
                $encoded = json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            } else {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_ANCHOR_KIND');
            }
            return ['status' => 'RESOLVED', 'target_sha256' => hash('sha256', $encoded),
                'scope' => 'Exact document location only; clinical meaning and inherited semantics are not certified.'];
        } catch (\InvalidArgumentException|\JsonException) {
            return ['status' => 'INVALID', 'reason' => 'The declared document location is absent, ambiguous or invalid for this source.'];
        }
    }
}
