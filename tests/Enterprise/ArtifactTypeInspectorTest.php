<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Validation\ArtifactTypeInspector;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ArtifactTypeInspectorTest extends TestCase
{
    public static function documents(): array
    {
        return [
            ['<template xmlns="openEHR/v1/Template"/>', 'OET_TEMPLATE', 'oet', 'PASS'],
            ['<template xmlns="http://schemas.openehr.org/v1"/>', 'OPT', 'opt14_xml', 'PASS'],
            ['{"resourceType":"ValueSet"}', 'TERMINOLOGY_ARTEFACT', 'fhir_terminology_json', 'PASS'],
            ['{"_type":"COMPOSITION"}', 'CANONICAL_COMPOSITION', 'canonical_json', 'PASS'],
            ['{"templateId":"Synthetic","tree":{"rmType":"COMPOSITION"}}', 'WEB_TEMPLATE', 'web_template_json', 'PASS'],
            ["archetype (adl_version=1.4)\nopenEHR-EHR-CLUSTER.test.v1\ninvalid body", 'ADL_ARCHETYPE', 'adl14', 'NOT_EXECUTED'],
            ["template (adl_version=2.0.6; rm_release=1.0.4)\nopenEHR-EHR-COMPOSITION.test.v1.0.0\n", 'ADL_TEMPLATE', 'adlt2', 'NOT_EXECUTED'],
        ];
    }

    #[DataProvider('documents')]
    public function test_content_markers_identify_representation_without_claiming_conformance(string $source, string $type, string $format, string $syntax): void
    {
        $result = (new ArtifactTypeInspector())->inspect($source, 'neutral-name.bin');
        self::assertSame($type, $result['detected_type']);
        self::assertSame($format, $result['format']);
        self::assertSame($syntax, $result['syntax']);
        self::assertSame('NOT_EXECUTED', $result['conformance']);
        self::assertSame(hash('sha256', $source), $result['source_sha256']);
        self::assertFalse($result['source_system_verified']);
    }

    public function test_designer_json_and_filename_hints_cannot_become_opt_or_web_template(): void
    {
        $inspector = new ArtifactTypeInspector();
        $opaque = '{"templateId":"Unknown","tree":{"rmType":"COMPOSITION"},"unknownSourceField":{"preserved":true}}';
        $result = $inspector->inspect($opaque, 'model.t.json');
        self::assertSame('UNKNOWN', $result['detected_type']);
        self::assertSame('UNKNOWN', $result['effective_type']);
        self::assertSame('DESIGNER_AUTHORING_JSON', $result['filename_hint']);
        $declared = $inspector->inspect($opaque, 'source.json', 'DESIGNER_AUTHORING_JSON');
        self::assertSame('DESIGNER_AUTHORING_JSON', $declared['effective_type']);
        self::assertSame('CALLER_DECLARED', $declared['classification_basis']);
        self::assertSame('UNKNOWN', $inspector->inspect('{"unknown":true}', 'misleading.opt')['detected_type']);
        self::assertContains('DECLARED_TYPE_CONFLICT', $inspector->inspect('<template xmlns="openEHR/v1/Template"/>', 'source.xml', 'OPT')['finding_codes']);
    }

    public function test_failed_parsing_and_binary_input_produce_bounded_evidence_with_original_hash(): void
    {
        $inspector = new ArtifactTypeInspector();
        foreach (['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', '<broken', '{"x":1,"\\u0078":2}'] as $source) {
            $result = $inspector->inspect($source, 'untrusted');
            self::assertSame('FAIL', $result['syntax']);
            self::assertSame(hash('sha256', $source), $result['source_sha256']);
            self::assertContains('SOURCE_SYNTAX_UNSAFE_OR_INVALID', $result['finding_codes']);
        }
        $source = "\xff\xfe<\0x\0/\0>\0";
        $result = $inspector->inspect($source, 'source.xml');
        self::assertSame('NOT_EXECUTED', $result['syntax']);
        self::assertSame(hash('sha256', $source), $result['source_sha256']);
        self::assertContains('NON_UTF8_OR_BINARY_SOURCE_PRESERVED', $result['finding_codes']);
    }
}
