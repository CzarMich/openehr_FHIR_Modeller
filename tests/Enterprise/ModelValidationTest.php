<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Validation\ModelValidator;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ModelValidationTest extends TestCase
{
    public const string OET = '<template xmlns="openEHR/v1/Template" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><id>test</id><name>Test</name><definition xsi:type="COMPOSITION" archetype_id="openEHR-EHR-COMPOSITION.fixture.v1"><Content xsi:type="OBSERVATION" archetype_id="openEHR-EHR-OBSERVATION.fixture.v1" path="/content"><Rule path="/data[at0001]" min="0" max="1"/></Content></definition></template>';

    #[DataProvider('maliciousXml')]
    public function test_unsafe_or_malformed_xml_is_rejected(string $xml): void
    {
        $result = (new ModelValidator())->validate($xml, 'xml');
        self::assertFalse($result['valid']);
        self::assertSame('INVALID', $result['status']);
        self::assertNotEmpty($result['errors']);
    }

    public static function maliciousXml(): array
    {
        return [[''], ['<unclosed>'], ['<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'],
            ['<!DOCTYPE x SYSTEM "https://example.org/evil.dtd"><x/>'], [str_repeat('x', 2097153)], ["<x>\0</x>"]];
    }

    public function test_xml_success_is_not_full_oet_or_opt_validation(): void
    {
        $validator = new ModelValidator();
        self::assertTrue($validator->validate('<root/>', 'xml')['valid']);
        $oet = $validator->validate(self::OET, 'oet');
        self::assertNull($oet['valid']);
        self::assertTrue($oet['structurally_valid']);
        self::assertSame('PARTIAL', $oet['status']);
        self::assertFalse($validator->validate(self::OET, 'opt')['valid']);
        self::assertFalse($validator->validate(str_replace('min="0"', 'min="2"', self::OET), 'oet')['valid']);
        self::assertSame('NOT_EXECUTED', $validator->validate('SELECT e FROM EHR e', 'aql')['status']);
        self::assertFalse((new QualityPipeline($validator))->run(self::OET, 'oet')['release_eligible']);
    }

    public function test_oet_profile_checks_typed_placement_identity_and_parent_kind(): void
    {
        $validator = new ModelValidator();
        $valid = $validator->validate(self::OET, 'oet');
        self::assertTrue($valid['structurally_valid']);
        $mismatch = $validator->validate(str_replace('xsi:type="OBSERVATION"', 'xsi:type="EVALUATION"', self::OET), 'oet');
        self::assertFalse($mismatch['structurally_valid']);
        self::assertContains('OET_RM_TYPE_REFERENCE_MISMATCH', array_column($mismatch['findings'], 'code'));
        $wrongPlacement = $validator->validate(str_replace('<Content ', '<Items ', str_replace('</Content>', '</Items>', self::OET)), 'oet');
        self::assertFalse($wrongPlacement['structurally_valid']);
        self::assertContains('OET_PLACEMENT_KIND_INVALID', array_column($wrongPlacement['findings'], 'code'));
        $missingReference = $validator->validate(str_replace(' archetype_id="openEHR-EHR-OBSERVATION.fixture.v1"', '', self::OET), 'oet');
        self::assertFalse($missingReference['structurally_valid']);
        self::assertContains('MISSING_ARCHETYPE_REFERENCE', array_column($missingReference['findings'], 'code'));
    }

    public function test_semantic_diff_ignores_attribute_order_but_reports_constraints(): void
    {
        $validator = new ModelValidator();
        $same = str_replace('min="0" max="1"', 'max="1" min="0"', self::OET);
        self::assertSame([], $validator->diff(self::OET, $same)['changed']);
        $diff = $validator->diff(self::OET, str_replace('min="0"', 'min="1"', self::OET));
        self::assertCount(1, $diff['changed']);
        self::assertSame('PARTIAL', $diff['status']);
        self::assertSame('occurrences_and_cardinalities', $diff['semantic_differences'][0]['dimension']);
    }

    public function test_semantic_diff_classifies_terminology_and_language_changes(): void
    {
        $validator = new ModelValidator();
        $before = '<template><languages><language>en</language></languages><terminology><value_set id="one"/></terminology></template>';
        $after = '<template><languages><language>nl</language></languages><terminology><value_set id="two"/></terminology></template>';
        $diff = $validator->diff($before, $after);
        $dimensions = array_column($diff['semantic_differences'], 'dimension');
        self::assertContains('languages', $dimensions);
        self::assertContains('terminology_bindings', $dimensions);
        self::assertSame('bounded_xml_semantic_projection', $diff['scope']);
    }

    public function test_semantic_diff_reports_unique_explicit_placement_moves(): void
    {
        $before = '<template><definition><Content archetype_id="openEHR-EHR-OBSERVATION.fixture.v1" path="/content"/></definition></template>';
        $after = str_replace('path="/content"', 'path="/other"', $before);
        $diff = (new ModelValidator())->diff($before, $after);
        self::assertSame([], array_filter($diff['semantic_differences'], static fn (array $change): bool => in_array($change['change'], ['added', 'removed'], true)));
        self::assertSame('moved', $diff['semantic_differences'][0]['change']);
        self::assertSame('paths', $diff['semantic_differences'][0]['dimension']);
        self::assertStringContainsString('/content', $diff['semantic_differences'][0]['before_location']);
        self::assertStringContainsString('/other', $diff['semantic_differences'][0]['location']);
    }

    public function test_semantic_diff_does_not_pair_ambiguous_repeated_placements(): void
    {
        $before = '<template><definition><Content archetype_id="same" path="/a"/><Content archetype_id="same" path="/b"/></definition></template>';
        $after = '<template><definition><Content archetype_id="same" path="/c"/><Content archetype_id="same" path="/d"/></definition></template>';
        $changes = (new ModelValidator())->diff($before, $after)['semantic_differences'];
        self::assertSame([], array_filter($changes, static fn (array $change): bool => $change['change'] === 'moved'));
        self::assertCount(4, $changes);
    }

    public function test_adl_preflight_distinguishes_invalid_identifiers_and_partial_validation(): void
    {
        $validator = new ModelValidator();
        self::assertFalse($validator->validate('archetype\nnot-an-archetype ', 'adl')['valid']);
        $adl = file_get_contents(APP_RESOURCES_DIR . '/examples/archetypes/openEHR-EHR-CLUSTER.anatomical_location.v1.adl');
        $result = $validator->validate($adl, 'adl');
        self::assertSame('PARTIAL', $result['status']);
        self::assertNull($result['valid']);
    }
}
