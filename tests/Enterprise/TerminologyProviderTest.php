<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Terminology\BindingService;
use OpenEHR\Assistant\Domain\Terminology\ValueSet;
use OpenEHR\Assistant\Domain\Terminology\LocalTerminologyProvider;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TerminologyProviderTest extends TestCase
{
    public function test_fhir_lookup_and_validation_use_correct_parameters_and_preserve_version(): void
    {
        $responses = [new Response(200, [], json_encode(['resourceType' => 'Parameters', 'parameter' => [
            ['name' => 'display', 'valueString' => 'Test unit'], ['name' => 'version', 'valueString' => '1']]])),
            new Response(200, [], '{"resourceType":"Parameters","parameter":[{"name":"result","valueBoolean":true}]}'),
            new Response(200, [], '{"resourceType":"Parameters","parameter":[{"name":"result","valueBoolean":false}]}')];
        $history = [];
        $stack = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($history));
        $provider = new FhirTerminologyProvider(new Settings(['TERMINOLOGY_FHIR_BASE_URL' => 'https://terminology.example/fhir']), new Client(['handler' => $stack, 'base_uri' => 'https://terminology.example/fhir/']));
        $lookup = $provider->lookup('https://example.org/units', 'u', '1');
        self::assertSame('Test unit', $lookup['result']['display']);
        self::assertTrue($lookup['version_confirmed']);
        self::assertTrue($provider->validateCode('https://example.org/units', 'u', null, '1')['valid']);
        self::assertFalse($provider->validateCode('https://example.org/units', 'bad', 'https://example.org/vs', '2')['valid']);
        parse_str($history[1]['request']->getUri()->getQuery(), $codeSystemQuery);
        self::assertSame('https://example.org/units', $codeSystemQuery['url']);
        self::assertArrayNotHasKey('system', $codeSystemQuery);
        parse_str($history[2]['request']->getUri()->getQuery(), $valueSetQuery);
        self::assertSame('2', $valueSetQuery['valueSetVersion']);
        self::assertSame('https://example.org/units', $valueSetQuery['system']);
    }

    public function test_service_api_key_and_explicit_parameter_compatibility(): void
    {
        $history = [];
        $stack = HandlerStack::create(new MockHandler([new Response(200, [], '{"resourceType":"Parameters","parameter":[{"name":"result","valueBoolean":true}]}')]));
        $stack->push(Middleware::history($history));
        $settings = new Settings(['TERMINOLOGY_API_KEY' => 'test-service-key', 'TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER' => 'system']);
        $provider = new FhirTerminologyProvider($settings, new Client(['handler' => $stack, 'base_uri' => 'https://terminology.example/fhir/']));
        $result = $provider->validateCode('https://example.org/system', 'a');
        self::assertTrue($result['valid']);
        self::assertSame('test-service-key', $history[0]['request']->getHeaderLine('X-API-Key'));
        parse_str($history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame('https://example.org/system', $query['system']);
        self::assertArrayNotHasKey('url', $query);
        self::assertStringNotContainsString('test-service-key', json_encode($result));
    }

    #[DataProvider('failedResponses')]
    public function test_failure_never_becomes_successful_validation(int $status, string $body): void
    {
        $client = new Client(['handler' => HandlerStack::create(new MockHandler([new Response($status, [], $body)])), 'base_uri' => 'https://terminology.example/']);
        $provider = new FhirTerminologyProvider(new Settings(), $client);
        $result = $provider->validateCode('https://example.org', 'code');
        self::assertSame('NOT_EXECUTED', $result['status']);
        self::assertNull($result['valid']);
        self::assertStringNotContainsString('secret-marker', json_encode($result));
    }

    public static function failedResponses(): array
    {
        return [[401, 'secret-marker'], [403, 'secret-marker'], [404, '{}'], [500, 'secret-marker'],
            [302, 'login'], [200, '<html>login</html>'], [200, '{"resourceType":"OperationOutcome"}'],
            [200, '{"resourceType":"Parameters","parameter":[]}'], [200, '{"resourceType":"Parameters","parameter":"malformed"}']];
    }

    public function test_expansion_pagination_is_preserved_and_requested_version_is_not_invented(): void
    {
        $body = ['resourceType' => 'ValueSet', 'url' => 'https://example.org/vs', 'version' => '2',
            'expansion' => ['total' => 20, 'offset' => 0, 'contains' => [['system' => 'https://example.org', 'code' => 'x']]]];
        $client = new Client(['handler' => HandlerStack::create(new MockHandler([new Response(200, [], json_encode($body))])), 'base_uri' => 'https://terminology.example/']);
        $result = (new FhirTerminologyProvider(new Settings(), $client))->expand('https://example.org/vs', '1', 1);
        self::assertSame('NOT_EXECUTED', $result['status']);
        self::assertContains('TERMINOLOGY_VERSION_MISMATCH', $result['errors']);
    }

    public function test_local_value_sets_reject_unknown_inactive_and_wrong_version_codes(): void
    {
        $set = new ValueSet('feeding', 'https://example.org/local', '1', [
            ['code' => 'mixed', 'display' => 'Mixed'], ['code' => 'old', 'display' => 'Old', 'inactive' => true]]);
        $provider = new LocalTerminologyProvider($set);
        self::assertTrue($provider->validateCode($set->system, 'mixed', 'feeding', '1')['valid']);
        self::assertFalse($provider->validateCode($set->system, 'invented', 'feeding', '1')['valid']);
        self::assertFalse($provider->validateCode($set->system, 'old', 'feeding', '1')['valid']);
        self::assertFalse($provider->validateCode($set->system, 'mixed', 'feeding', '2')['valid']);
        self::assertFalse($provider->expand('feeding', '1', 1)['complete']);
    }

    public function test_binding_checks_codes_and_target_without_claiming_native_binding_validity(): void
    {
        $service = new BindingService(new FhirTerminologyProvider(new Settings()));
        $set = new ValueSet('feeding', 'https://example.org/local', '1', [['code' => 'mixed', 'display' => 'Mixed']]);
        $binding = ['id' => 'feeding-binding', 'artifact' => 'admission', 'node' => '/data[at0001]', 'strength' => 'REQUIRED',
            'value_set' => 'feeding', 'value_set_version' => '1', 'codes' => ['mixed']];
        $result = $service->validate($binding, $set, ModelValidationTest::OET);
        self::assertTrue($result['terminology_valid']);
        self::assertNull($result['valid']);
        self::assertSame('PARTIAL', $result['status']);
        $binding['codes'] = ['invented'];
        self::assertFalse($service->validate($binding, $set, ModelValidationTest::OET)['terminology_valid']);
        $external = new ValueSet('feeding', 'https://example.org/local', '1', [], 'https://example.org/vs', 'external');
        self::assertSame('NOT_EXECUTED', $service->validate($binding, $external, ModelValidationTest::OET)['status']);
    }

    public function test_semantic_terminology_diff_and_manifest_preserve_actual_dependencies(): void
    {
        $service = new BindingService(new FhirTerminologyProvider(new Settings()));
        $before = new ValueSet('set', 'https://example.org/local', '1', [['code' => 'a', 'display' => 'A'], ['code' => 'c', 'display' => 'C']]);
        $after = new ValueSet('set', 'https://example.org/local', '2', [['code' => 'a', 'display' => 'Renamed', 'inactive' => true, 'replacement' => 'b'], ['code' => 'b', 'display' => 'B']]);
        $diff = $service->diff($before, $after);
        self::assertSame('b', $diff['added'][0]['code']);
        self::assertSame('c', $diff['removed'][0]['code']);
        self::assertSame(['a'], $diff['inactive']);
        self::assertFalse($diff['codes_replaced_automatically']);
        $manifest = $service->manifest('t', [
            ['id' => 'binding', 'artifact' => 't', 'node' => '/data', 'system' => 'https://example.org/local', 'value_set' => 'set', 'value_set_version' => '2', 'requirements' => ['REQ-1']],
            ['artifact' => 'unrelated']]);
        self::assertCount(1, $manifest['terminology_dependencies']);
        self::assertSame(['REQ-1'], $manifest['terminology_dependencies'][0]['requirements']);
    }

    public function test_terminology_diff_compares_explicit_hierarchy_edges_without_inference(): void
    {
        $service = new BindingService(new FhirTerminologyProvider(new Settings()));
        $before = new ValueSet('set', 'https://example.org/local', '1', [
            ['code' => 'root', 'display' => 'Root', 'parents' => []],
            ['code' => 'child', 'display' => 'Child', 'parents' => ['root']],
        ]);
        $after = new ValueSet('set', 'https://example.org/local', '2', [
            ['code' => 'root', 'display' => 'Root', 'parents' => []],
            ['code' => 'child', 'display' => 'Child', 'parents' => []],
        ]);
        $hierarchy = $service->diff($before, $after)['hierarchy'];
        self::assertSame('COMPARED_DECLARED_RELATIONSHIPS', $hierarchy['status']);
        self::assertSame([['child' => 'child', 'parent' => 'root']], $hierarchy['removed']);
        self::assertSame([], $hierarchy['added']);
    }
}
