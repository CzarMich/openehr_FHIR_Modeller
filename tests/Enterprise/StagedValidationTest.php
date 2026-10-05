<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Validation\ModelValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class StagedValidationTest extends TestCase
{
    public static function validDocuments(): array
    {
        return [
            ['xml', '<root/>'],
            ['oet', ModelValidationTest::OET],
            ['opt', self::opt()],
            ['opt', str_replace('/v1', '/v2', self::opt())],
            ['flat', '{"ctx/language":"en","observations/body_temperature:0/temperature|magnitude":37.5,"observations/body_temperature:0/temperature|unit":"Cel"}'],
            ['flat', '{"observations/item|raw":{"_type":"DV_TEXT","value":"Synthetic"}}'],
            ['flat', '{"observations/item|raw":"{\"_type\":\"DV_TEXT\",\"value\":\"Synthetic\"}"}'],
            ['structured', '{"ctx":{"language":"en"},"observations":{"body_temperature":[{"temperature":[{"|magnitude":37.5,"|unit":"Cel"}],"time":["2026-01-01T00:00:00Z"]}]}}'],
            ['structured', '{"observations":{"item":[{"|raw":{"_type":"DV_TEXT","value":"Synthetic"}}]}}'],
            ['flat', '{"résumé/température:0|magnitude":37}'],
        ];
    }

    #[DataProvider('validDocuments')]
    public function test_profile_success_keeps_full_validation_distinct(string $format, string $content): void
    {
        $result = (new ModelValidator())->validate($content, $format);
        self::assertTrue($result['parse_valid']);
        self::assertTrue($result['structurally_valid']);
        self::assertFalse($result['release_eligible']);
        self::assertSame([], $result['errors']);
        $stages = array_column($result['stages'], null, 'name');
        self::assertSame('PASS', $stages['parse']['status']);
        self::assertSame('NOT_EXECUTED', $stages['repository_policy']['status']);
        if ($format !== 'xml') {
            self::assertNull($result['valid']);
            self::assertSame('NOT_EXECUTED', $stages['openehr_conformance']['status']);
            self::assertSame('NOT_EXECUTED', $stages['terminology']['status']);
            self::assertFalse($stages['structure']['qualified']);
        }
        $qa = (new QualityPipeline(new ModelValidator()))->run($content, $format);
        self::assertSame('INCOMPLETE', $qa['status']);
        self::assertFalse((new ReviewPolicy())->qualified($qa, hash('sha256', $content)));
        self::assertNotEmpty(array_filter($qa['findings'], static fn (array $f): bool => $f['code'] === 'CHECK_NOT_EXECUTED'));
    }

    public static function invalidDocuments(): array
    {
        return [
            ['flat', '[]', 'SIMPLIFIED_ROOT', true],
            ['flat', '{}', 'SIMPLIFIED_ROOT', true],
            ['flat', '{"x":1,"x":2}', 'DUPLICATE_JSON_KEY', false],
            ['flat', '{"x":1,"\u0078":2}', 'DUPLICATE_JSON_KEY', false],
            ['structured', '{"x":{"a":[],"a":[]}}', 'DUPLICATE_JSON_KEY', false],
            ['flat', '{"x":', 'JSON_MALFORMED', false],
            ['flat', '{"x/y":{}}', 'FLAT_VALUE_SHAPE', true],
            ['flat', '{"x/y":[1]}', 'FLAT_VALUE_SHAPE', true],
            ['flat', '{"x/y|raw":{}}', 'RAW_TYPE_REQUIRED', true],
            ['flat', '{"x/y|raw":"{\"_type\":\"DV_TEXT\",\"x\":1,\"x\":2}"}', 'RAW_JSON_INVALID', true],
            ['flat', '{"x//y":1}', 'FLAT_FIELD_IDENTIFIER', true],
            ['flat', '{"x/y:-1":1}', 'FLAT_FIELD_IDENTIFIER', true],
            ['flat', '{"x/y:01":1}', 'FLAT_FIELD_IDENTIFIER', true],
            ['flat', '{"x/y|value|code":1}', 'FLAT_FIELD_IDENTIFIER', true],
            ['flat', '{"x/y|magnitude":1e400}', 'JSON_NUMBER_RANGE', true],
            ['structured', '{"x":[]}', 'STRUCTURED_ROOT_VALUE', true],
            ['structured', '{"x":{"y":1}}', 'STRUCTURED_NODE_ARRAY', true],
            ['structured', '{"x":{"y":[[]]}}', 'STRUCTURED_NESTED_ARRAY', true],
            ['structured', '{"x":{"y/z":[]}}', 'STRUCTURED_FIELD_IDENTIFIER', true],
            ['structured', '{"x":{"y":[{"|value":[]}]}}', 'STRUCTURED_ATTRIBUTE_VALUE', true],
            ['oet', '<x/>', 'TEMPLATE_ROOT', true],
            ['oet', str_replace('<id>test</id>', '<id/>', ModelValidationTest::OET), 'TEMPLATE_EMPTY_IDENTITY', true],
            ['oet', str_replace('<id>test</id>', '<id>test</id><id>other</id>', ModelValidationTest::OET), 'TEMPLATE_REQUIRED_ELEMENT', true],
            ['oet', str_replace('min="0"', 'min="-1"', ModelValidationTest::OET), 'INVALID_OCCURRENCE_BOUND', true],
            ['oet', str_replace('min="0" max="1"', 'min="9999999999999999999999999999999999999999" max="9999999999999999999999999999999999999998"', ModelValidationTest::OET), 'REVERSED_OCCURRENCES', true],
            ['oet', str_replace('path="/data[at0001]"', 'path="data[at0001]"', ModelValidationTest::OET), 'INVALID_RULE_PATH', true],
            ['opt', self::opt('<occurrences><lower>3</lower><upper>1</upper></occurrences>'), 'REVERSED_INTERVAL', true],
            ['opt', self::opt('<occurrences><lower>-1</lower><upper>1</upper></occurrences>'), 'INVALID_INTERVAL_BOUND', true],
            ['opt', self::opt('<occurrences><lower>0</lower><upper_unbounded>yes</upper_unbounded></occurrences>'), 'INVALID_INTERVAL_FLAG', true],
            ['opt', self::opt('<occurrences><lower>0</lower><lower>1</lower><upper>1</upper></occurrences>'), 'DUPLICATE_INTERVAL_FIELD', true],
            ['opt', self::opt('<occurrences><lower>0</lower><upper>1</upper><upper_unbounded>true</upper_unbounded></occurrences>'), 'INVALID_INTERVAL_BOUND', true],
            ['opt', self::opt('<occurrences/>'), 'MISSING_INTERVAL_BOUND', true],
            ['opt', self::opt('<attributes><cardinality><interval><lower>3</lower><upper>1</upper></interval></cardinality></attributes>'), 'REVERSED_INTERVAL', true],
            ['opt', self::opt('<rm_type_name>bad type</rm_type_name>'), 'INVALID_RM_TYPE_SYNTAX', true],
        ];
    }

    #[DataProvider('invalidDocuments')]
    public function test_machine_findings_distinguish_parse_from_profile_failures(string $format, string $content, string $code, bool $parsed): void
    {
        $result = (new ModelValidator())->validate($content, $format);
        self::assertFalse($result['valid']);
        self::assertSame($parsed, $result['parse_valid']);
        self::assertSame($parsed ? false : null, $result['structurally_valid']);
        self::assertContains($code, array_column($result['findings'], 'code'));
        foreach ($result['findings'] as $finding) {
            self::assertSame(['severity', 'code', 'location', 'message', 'evidence', 'remediation'], array_keys($finding));
        }
        self::assertSame('FAIL', (new QualityPipeline(new ModelValidator()))->run($content, $format)['status']);
    }

    public function test_unbounded_intervals_and_decimal_bounds_do_not_overflow(): void
    {
        $document = self::opt('<occurrences><lower>0</lower><upper_unbounded>true</upper_unbounded></occurrences>');
        self::assertTrue((new ModelValidator())->validate($document, 'opt')['structurally_valid']);
        $document = str_replace('min="0" max="1"', 'min="9999999999999999999999999999999999999998" max="9999999999999999999999999999999999999999"', ModelValidationTest::OET);
        self::assertTrue((new ModelValidator())->validate($document, 'oet')['structurally_valid']);
    }

    public function test_adl_declaration_checks_do_not_masquerade_as_language_parsing(): void
    {
        $validator = new ModelValidator();
        $header = "archetype (adl_version=2.0.6)\nopenEHR-EHR-OBSERVATION.fixture.v1\nnot-a-valid-body";
        $result = $validator->validate($header, 'adl');
        self::assertNull($result['parse_valid']);
        self::assertNull($result['structurally_valid']);
        self::assertSame('PARTIAL', $result['status']);
        self::assertSame('NOT_EXECUTED', $result['stages'][0]['status']);
        foreach (["-- archetype\nopenEHR-EHR-OBSERVATION.fixture.v1\n", 'description <"' . $header . '">'] as $fake) {
            self::assertFalse($validator->validate($fake, 'adl')['valid']);
        }
        $query = $validator->validate('definitely not an AQL query', 'aql');
        self::assertSame('NOT_EXECUTED', $query['status']);
        self::assertNull($query['parse_valid']);
    }

    public function test_no_schema_location_or_raw_content_is_executed_and_findings_are_bounded(): void
    {
        $document = str_replace('<template ', '<template xsi:schemaLocation="openEHR/v1/Template http://127.0.0.1:1/never-fetch" ', ModelValidationTest::OET);
        self::assertTrue((new ModelValidator())->validate($document, 'oet')['structurally_valid']);
        $input = [];
        for ($i = 0; $i < 700; ++$i) {
            $input['invalid//' . $i] = ['never_execute' => '<?php exit; ?>'];
        }
        $result = (new ModelValidator())->validate(json_encode($input, JSON_THROW_ON_ERROR), 'flat');
        self::assertFalse($result['valid']);
        self::assertCount(501, $result['findings']);
        self::assertSame('FINDINGS_TRUNCATED', $result['findings'][500]['code']);
        self::assertStringNotContainsString('<?php', json_encode($result, JSON_THROW_ON_ERROR));
    }

    public function test_document_limits_fail_closed_without_certifying_other_stages(): void
    {
        foreach ([str_repeat('x', 2097153), "bad\0input", "bad\xFFinput", ''] as $input) {
            foreach (['xml', 'adl', 'flat', 'structured', 'aql'] as $format) {
                $result = (new ModelValidator())->validate($input, $format);
                self::assertFalse($result['valid']);
                self::assertFalse($result['release_eligible']);
            }
        }
    }

    public static function bundledSimplifiedExamples(): array
    {
        $cases = [];
        foreach (['flat', 'structured'] as $format) {
            foreach (glob(APP_RESOURCES_DIR . '/examples/' . $format . '/*.md') as $file) {
                preg_match_all('/```json\s*\n(.*?)\n```/s', file_get_contents($file), $blocks);
                foreach ($blocks[1] as $index => $content) {
                    $cases[$format . '/' . basename($file) . ':' . $index] = [$format, $content];
                }
            }
        }
        return $cases;
    }

    #[DataProvider('bundledSimplifiedExamples')]
    public function test_published_simplified_examples_pass_only_the_document_profile(string $format, string $content): void
    {
        $result = (new ModelValidator())->validate($content, $format);
        self::assertTrue($result['parse_valid'], json_encode($result['findings']));
        self::assertTrue($result['structurally_valid'], json_encode($result['findings']));
        self::assertNull($result['valid']);
        self::assertFalse($result['release_eligible']);
    }

    private static function opt(string $constraint = ''): string
    {
        return '<template xmlns="http://schemas.openehr.org/v1"><language><code_string>en</code_string></language><template_id><value>synthetic</value></template_id><concept>Synthetic test only</concept><definition>' . $constraint . '</definition></template>';
    }
}
