<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

use OpenEHR\Assistant\Domain\Modelling\ArtifactTypes;
use OpenEHR\Assistant\Domain\Repository\OriginalContent;

/** Local bounded detection only. Filename hints and caller declarations never establish conformance. */
final class ArtifactTypeInspector
{
    /** @return array<string, mixed> */
    public function inspect(string $bytes, string $filename, string $declaredType = 'UNKNOWN'): array
    {
        ArtifactTypes::assert($declaredType);
        $payload = OriginalContent::envelope($bytes);
        $result = ['schema_version' => 1, 'inspector' => 'model-artifact-types/1', 'source_sha256' => $payload['sha256'],
            'detected_type' => 'UNKNOWN', 'declared_type' => $declaredType, 'effective_type' => $declaredType,
            'classification_basis' => $declaredType === 'UNKNOWN' ? 'UNKNOWN' : 'CALLER_DECLARED',
            'format' => 'opaque', 'syntax' => 'NOT_EXECUTED', 'identifier' => null, 'finding_codes' => [],
            'conformance' => 'NOT_EXECUTED', 'source_system_verified' => false,
            'filename_hint' => str_ends_with(strtolower($filename), '.t.json') ? 'DESIGNER_AUTHORING_JSON' : null];
        if ($payload['content_encoding'] !== 'utf8') {
            $result['finding_codes'][] = 'NON_UTF8_OR_BINARY_SOURCE_PRESERVED';
            return $result;
        }
        $content = str_starts_with($bytes, "\xEF\xBB\xBF") ? substr($bytes, 3) : $bytes;
        $trimmed = ltrim($content);
        try {
            if (str_starts_with($trimmed, '<')) {
                $result['format'] = 'xml';
                $document = ModelValidator::xml($content);
                $root = $document->documentElement;
                $result['syntax'] = 'PASS';
                if ($root !== null && $root->localName === 'template') {
                    if ($root->namespaceURI === 'openEHR/v1/Template') {
                        $result['detected_type'] = 'OET_TEMPLATE';
                        $result['format'] = 'oet';
                    } elseif ($root->namespaceURI === 'http://schemas.openehr.org/v1') {
                        $result['detected_type'] = 'OPT';
                        $result['format'] = 'opt14_xml';
                    }
                }
            } elseif (str_starts_with($trimmed, '{') || str_starts_with($trimmed, '[')) {
                $result['format'] = 'json';
                $json = JsonDocument::parse($content);
                $result['syntax'] = 'PASS';
                if ($json instanceof \stdClass && $result['filename_hint'] !== 'DESIGNER_AUTHORING_JSON' && $declaredType !== 'DESIGNER_AUTHORING_JSON') {
                    if (($json->_type ?? null) === 'COMPOSITION') {
                        $result['detected_type'] = 'CANONICAL_COMPOSITION';
                        $result['format'] = 'canonical_json';
                    } elseif (in_array($json->resourceType ?? null, ['CodeSystem', 'ValueSet', 'ConceptMap'], true)) {
                        $result['detected_type'] = 'TERMINOLOGY_ARTEFACT';
                        $result['format'] = 'fhir_terminology_json';
                    } elseif (is_string($json->templateId ?? null) && isset($json->tree) && $json->tree instanceof \stdClass
                        && ($json->tree->rmType ?? null) === 'COMPOSITION') {
                        $result['detected_type'] = 'WEB_TEMPLATE';
                        $result['format'] = 'web_template_json';
                    }
                }
            } elseif (preg_match('/\A(?:\s|--[^\r\n]*(?:\r?\n|$))*(archetype|template|operational_template)\b(?:[ \t]*\(([^\r\n()]{0,1000})\))?\s+(openEHR-[^\s;]+)(?:\s|$)/', $content, $header)
                && preg_match(ModelValidator::ARCHETYPE_ID, $header[3])) {
                $result['detected_type'] = match ($header[1]) {
                    'archetype' => 'ADL_ARCHETYPE', 'template' => 'ADL_TEMPLATE', default => 'OPT'
                };
                $result['format'] = 'adl_unspecified';
                if (preg_match('/(?:^|;)\s*adl_version\s*=\s*(1\.4|2\.0(?:\.6)?)\s*(?:;|$)/D', $header[2], $version)) {
                    $result['format'] = $version[1] === '1.4' ? 'adl14' : match ($header[1]) {
                        'archetype' => 'adl2', 'template' => 'adlt2', default => 'opt2_adl'
                    };
                }
                $result['identifier'] = $header[3];
                $result['finding_codes'][] = 'ADL_HEADER_RECOGNIZED_GRAMMAR_NOT_EXECUTED';
            }
        } catch (\InvalidArgumentException|\JsonException) {
            $result['syntax'] = 'FAIL';
            $result['finding_codes'][] = 'SOURCE_SYNTAX_UNSAFE_OR_INVALID';
        }
        if ($result['detected_type'] !== 'UNKNOWN') {
            $result['effective_type'] = $result['detected_type'];
            $result['classification_basis'] = 'CONTENT_MARKERS';
            if (!in_array($declaredType, ['UNKNOWN', $result['detected_type']], true)) {
                $result['finding_codes'][] = 'DECLARED_TYPE_CONFLICT';
            }
        } else {
            $result['finding_codes'][] = 'SOURCE_TYPE_UNVERIFIED';
        }
        return $result;
    }
}
