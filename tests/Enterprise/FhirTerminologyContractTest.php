<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Terminology\LocalTerminologyProvider;
use OpenEHR\Assistant\Domain\Terminology\ValueSet;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class FhirTerminologyContractTest extends TestCase
{
    private function provider(array $resources, ?array &$history = null, array $settings = []): FhirTerminologyProvider
    {
        $history = [];
        $responses = array_map(static fn ($r) => $r instanceof Response ? $r : new Response(200, [], json_encode($r, JSON_THROW_ON_ERROR)), $resources);
        $stack = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($history));
        return new FhirTerminologyProvider(new Settings($settings), new Client(['handler' => $stack, 'base_uri' => 'https://terminology.example/fhir/']));
    }

    private static function parameters(array $parameters): array
    {
        return ['resourceType' => 'Parameters', 'parameter' => $parameters];
    }

    private static function part(string $name, string $type, mixed $value): array
    {
        return ['name' => $name, 'value' . $type => $value];
    }

    private static function match(string $relation, ?array $coding, string $source = 'https://example.org/map'): array
    {
        $parts = [self::part('equivalence', 'Code', $relation), self::part('source', 'Uri', $source)];
        if ($coding !== null) { $parts[] = self::part('concept', 'Coding', $coding); }
        return ['name' => 'match', 'part' => $parts];
    }

    public function test_lookup_preserves_repeated_designations_and_nested_properties(): void
    {
        $designations = [
            ['name' => 'designation', 'part' => [self::part('language', 'Code', 'de'), self::part('value', 'String', 'Blutdruck')]],
            ['name' => 'designation', 'part' => [self::part('language', 'Code', 'en'), self::part('value', 'String', 'Blood pressure')]],
        ];
        $property = ['name' => 'property', 'part' => [self::part('code', 'Code', 'parent'), self::part('value', 'Code', '123'),
            ['name' => 'subproperty', 'part' => [self::part('code', 'Code', 'status'), self::part('value', 'String', 'active')]]]];
        $provider = $this->provider([self::parameters([self::part('display', 'String', 'Blutdruck'), ...$designations, $property])], $history);
        $result = $provider->lookup('urn:oid:1.2.3', '456', null, 'de');
        self::assertSame('VALIDATED', $result['status']);
        self::assertCount(2, $result['result']['designation']);
        self::assertSame('Blood pressure', $result['result']['designation'][1][1]['valueString']);
        self::assertSame($property, $result['parameters'][3]);
        parse_str($history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame('de', $query['displayLanguage']);
    }

    public function test_value_set_and_code_system_versions_are_independent(): void
    {
        $provider = $this->provider([self::parameters([self::part('result', 'Boolean', true), self::part('version', 'String', 'cs-2025'),
            self::part('valueSetVersion', 'String', 'vs-3'), self::part('systemVersion', 'String', 'cs-2025')])], $history);
        $result = $provider->validateCode('https://example.org/cs', 'code', 'https://example.org/vs', 'vs-3', 'cs-2025', 'Display', 'de');
        self::assertTrue($result['valid']);
        self::assertTrue($result['versions']['value_set']['confirmed']);
        self::assertTrue($result['versions']['code_system']['confirmed']);
        parse_str($history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame('vs-3', $query['valueSetVersion']);
        self::assertSame('cs-2025', $query['systemVersion']);
        self::assertSame('Display', $query['display']);
        self::assertSame('de', $query['displayLanguage']);
    }

    public function test_generic_version_does_not_confirm_value_set_edition(): void
    {
        $result = $this->provider([self::parameters([self::part('result', 'Boolean', true), self::part('version', 'String', '2025')])])
            ->validateCode('https://example.org/cs', 'code', 'https://example.org/vs', '3');
        self::assertTrue($result['valid']); self::assertFalse($result['version_confirmed']);
        self::assertNull($result['returned_version']); self::assertNotEmpty($result['warnings']);
    }

    public function test_local_value_set_version_is_not_a_code_system_version(): void
    {
        $set = new ValueSet('set', 'https://example.org/cs', 'vs-3', [['code' => 'x', 'display' => 'X',
            'designation' => [['language' => 'de', 'value' => 'Deutsch']]]], null, 'local', 'cs-2025');
        $provider = new LocalTerminologyProvider($set);
        self::assertTrue($provider->validateCode($set->system, 'x', 'set', 'vs-3', 'cs-2025', 'Deutsch', 'de')['valid']);
        self::assertFalse($provider->lookup($set->system, 'x', 'vs-3')['valid']);
        self::assertTrue($provider->lookup($set->system, 'x', 'cs-2025')['valid']);
        $page = $provider->expand('set', 'vs-3', 1, 0, 'de', 'Deutsch');
        self::assertSame('Deutsch', $page['items'][0]['display']); self::assertTrue($page['filtered']);
        $unknown = new LocalTerminologyProvider(new ValueSet('set', $set->system, 'vs-3', $set->concepts));
        self::assertSame('NOT_EXECUTED', $unknown->lookup($set->system, 'x', 'cs-2025')['status']);
        self::assertTrue($unknown->validateCode($set->system, 'x', 'set', 'vs-3')['valid']);
    }

    public function test_translation_keeps_all_candidates_and_never_applies_them(): void
    {
        $matches = [self::match('equivalent', ['system' => 'https://example.org/target', 'version' => '7', 'code' => 'a']),
            self::match('wider', ['system' => 'https://example.org/target', 'code' => 'b']), self::match('unmatched', null)];
        $result = $this->provider([self::parameters([self::part('result', 'Boolean', true), ...$matches])], $history)
            ->translate('https://example.org/map', 'https://example.org/source', 'x', 'map-2', 'source-8',
                'https://example.org/source-vs', 'https://example.org/target-vs', 'https://example.org/target');
        self::assertSame('VALIDATED', $result['status']); self::assertTrue($result['mapping_found']);
        self::assertCount(3, $result['matches']); self::assertCount(2, $result['candidates']);
        self::assertFalse($result['applied']); self::assertTrue($result['requires_review']); self::assertNull($result['valid']);
        self::assertFalse($result['version_confirmed']);
        parse_str($history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame('map-2', $query['conceptMapVersion']); self::assertSame('source-8', $query['version']);
        self::assertSame('https://example.org/source-vs', $query['source']);
        self::assertSame('/fhir/ConceptMap/$translate', $history[0]['request']->getUri()->getPath());
    }

    public function test_negative_translation_is_a_completed_operation_with_no_candidates(): void
    {
        $result = $this->provider([self::parameters([self::part('result', 'Boolean', false), self::match('unmatched', null)])])
            ->translate('https://example.org/map', 'https://example.org/cs', 'x');
        self::assertSame('VALIDATED', $result['status']); self::assertFalse($result['mapping_found']); self::assertSame([], $result['candidates']);
    }

    #[DataProvider('invalidTranslations')]
    public function test_malformed_or_inconsistent_translation_fails_closed(array $parameters): void
    {
        $result = $this->provider([self::parameters($parameters)])->translate('https://example.org/map', 'https://example.org/cs', 'x',
            targetSystem: 'https://example.org/target');
        self::assertSame('NOT_EXECUTED', $result['status']); self::assertNull($result['valid']);
    }

    public static function invalidTranslations(): array
    {
        $good = self::match('equivalent', ['system' => 'https://example.org/target', 'code' => 'a']);
        return [
            [[self::part('result', 'Boolean', true)]],
            [[self::part('result', 'Boolean', false), $good]],
            [[self::part('result', 'Boolean', true), self::match('unmatched', null)]],
            [[self::part('result', 'Boolean', true), self::match('made-up', ['system' => 'https://example.org/target', 'code' => 'a'])]],
            [[self::part('result', 'Boolean', true), self::match('equal', null)]],
            [[self::part('result', 'Boolean', true), self::match('equal', ['system' => 'https://wrong.example/', 'code' => 'a'])]],
            [[self::part('result', 'Boolean', true), self::match('equal', ['display' => 'Invented'])]],
            [[self::part('result', 'Boolean', 'true'), $good]],
        ];
    }

    #[DataProvider('ambiguousParameters')]
    public function test_ambiguous_result_is_not_silently_overwritten(array $parameters): void
    {
        $result = $this->provider([self::parameters($parameters)])->validateCode('https://example.org/cs', 'x');
        self::assertSame('NOT_EXECUTED', $result['status']); self::assertNull($result['valid']);
    }

    public static function ambiguousParameters(): array
    {
        return [
            [[self::part('result', 'Boolean', false), self::part('result', 'Boolean', true)]],
            [[['name' => 'result', 'valueBoolean' => true, 'valueString' => 'true']]],
            [[['name' => 'result', 'valueBoolean' => true, 'part' => [self::part('other', 'String', 'x')]]]],
            [[self::part('result', 'Boolean', true), self::part('version', 'String', '1'), self::part('version', 'String', '2')]],
            [[self::part('result', 'String', 'true')]], [[null]], [[['name' => 'result']]],
        ];
    }

    #[DataProvider('expansions')]
    public function test_expansion_completeness_is_conservative(array $expansion, int $offset, bool $complete, bool $confirmed): void
    {
        $result = $this->provider([['resourceType' => 'ValueSet', 'url' => 'https://example.org/vs', 'version' => '1', 'expansion' => $expansion]], $history)
            ->expand('https://example.org/vs', '1', 2, $offset, 'de', 'x');
        self::assertSame('VALIDATED', $result['status']); self::assertSame($complete, $result['page']['complete']);
        self::assertSame($confirmed, $result['page']['page_confirmed']); self::assertTrue($result['page']['filtered']);
        parse_str($history[0]['request']->getUri()->getQuery(), $query);
        self::assertSame((string) $offset, $query['offset']); self::assertSame('true', $query['includeDesignations']);
    }

    public static function expansions(): array
    {
        $item = ['system' => 'https://example.org/cs', 'code' => 'x'];
        return [
            [['total' => 1, 'offset' => 0, 'contains' => [$item]], 0, true, true],
            [['total' => 20, 'offset' => 0, 'contains' => [$item]], 0, false, true],
            [['total' => 2, 'offset' => 1, 'contains' => [$item]], 1, false, true],
            [['total' => 2, 'contains' => [$item]], 1, false, false],
            [['contains' => [$item]], 0, false, true],
            [['total' => 1, 'contains' => [['contains' => [$item]]]], 0, false, false],
            [['total' => 1, 'contains' => [$item], 'extension' => [['url' => 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed', 'valueBoolean' => true]]], 0, false, true],
        ];
    }

    public function test_expansion_size_request_and_no_provider_modes(): void
    {
        $result = $this->provider([['resourceType' => 'ValueSet', 'expansion' => ['total' => 90]]], $history)->expand('https://example.org/vs', count: 0);
        self::assertSame(90, $result['page']['total']); self::assertFalse($result['page']['complete']);
        parse_str($history[0]['request']->getUri()->getQuery(), $query); self::assertSame('0', $query['count']);
        $offline = new FhirTerminologyProvider(new Settings());
        foreach ([$offline->translate('https://example.org/map', 'https://example.org/cs', 'x'),
            $offline->search('ConceptMap'), $offline->resource('ValueSet', 'https://example.org/vs')] as $report) {
            self::assertSame(['TERMINOLOGY_NOT_CONFIGURED'], $report['errors']); self::assertNull($report['valid']);
        }
    }

    private static function bundle(array $resources, ?int $total = null, bool $next = false): array
    {
        return ['resourceType' => 'Bundle', 'type' => 'searchset', 'total' => $total,
            'entry' => array_map(static fn ($r) => ['resource' => $r], $resources),
            'link' => $next ? [['relation' => 'next', 'url' => 'https://attacker.example/credentials']] : []];
    }

    public function test_canonical_resolution_is_exact_and_never_fetches_canonical_or_next_link(): void
    {
        $resource = ['resourceType' => 'ValueSet', 'url' => 'https://untrusted.example/value-set', 'version' => '2'];
        $provider = $this->provider([self::bundle([$resource], 1), self::bundle([$resource], 4, true)], $history, ['TERMINOLOGY_API_KEY' => 'fixture-secret']);
        self::assertSame($resource, $provider->resource('ValueSet', $resource['url'], '2')['result']);
        $search = $provider->search('ValueSet'); self::assertFalse($search['complete']); self::assertTrue($search['has_next_page']);
        self::assertCount(2, $history);
        foreach ($history as $call) { self::assertSame('terminology.example', $call['request']->getUri()->getHost()); }
        self::assertStringNotContainsString('fixture-secret', json_encode($search));
    }

    #[DataProvider('ambiguousResources')]
    public function test_resource_resolution_rejects_substitution_or_unproven_uniqueness(array $bundle): void
    {
        $result = $this->provider([$bundle])->resource('ValueSet', 'https://example.org/vs', '1');
        self::assertSame('NOT_EXECUTED', $result['status']); self::assertNull($result['valid']);
    }

    public static function ambiguousResources(): array
    {
        $resource = ['resourceType' => 'ValueSet', 'url' => 'https://example.org/vs', 'version' => '1'];
        return [[self::bundle([], 0)], [self::bundle([$resource], null)], [self::bundle([$resource], 2, true)],
            [self::bundle([$resource, $resource], 2)], [self::bundle([array_replace($resource, ['version' => '2'])], 1)],
            [self::bundle([array_replace($resource, ['url' => 'https://wrong.example/vs'])], 1)],
            [self::bundle([array_replace($resource, ['resourceType' => 'CodeSystem'])], 1)]];
    }

    public function test_redirect_never_forwards_credentials_to_another_host(): void
    {
        $provider = $this->provider([new Response(302, ['Location' => 'https://attacker.example/secret'])], $history,
            ['TERMINOLOGY_API_KEY' => 'fixture-secret']);
        $result = $provider->lookup('https://example.org/cs', 'x');
        self::assertSame(['TERMINOLOGY_HTTP_302'], $result['errors']); self::assertCount(1, $history);
    }

    public function test_response_limit_is_configured_and_error_body_is_redacted(): void
    {
        $provider = $this->provider([new Response(200, [], str_repeat('secret-marker', 100000))], $history, ['MAX_UPSTREAM_BYTES' => '1048576']);
        $result = $provider->lookup('https://example.org/cs', 'x');
        self::assertSame(['TERMINOLOGY_RESPONSE_TOO_LARGE'], $result['errors']);
        self::assertStringNotContainsString('secret-marker', json_encode($result));
    }

    #[DataProvider('invalidExpansionPages')]
    public function test_expansion_bounds_are_rejected_without_network(int $count, int $offset): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->provider([])->expand('https://example.org/vs', count: $count, offset: $offset);
    }

    public static function invalidExpansionPages(): array
    {
        return [[-1, 0], [501, 0], [1, -1], [1, 1000001]];
    }

    public function test_abstract_local_concept_is_not_a_selectable_code(): void
    {
        $provider = new LocalTerminologyProvider(new ValueSet('set', 'https://example.org/cs', '1',
            [['code' => 'category', 'display' => 'Category', 'abstract' => true]]));
        self::assertFalse($provider->validateCode('https://example.org/cs', 'category', 'set', '1')['valid']);
    }

    public function test_deeply_nested_parameters_fail_without_recursion_overflow(): void
    {
        $part = self::part('nested', 'String', 'x');
        for ($i = 0; $i < 20; $i++) { $part = ['name' => 'nested', 'part' => [$part]]; }
        $result = $this->provider([self::parameters([self::part('result', 'Boolean', true), $part])])->validateCode('https://example.org/cs', 'x');
        self::assertSame('NOT_EXECUTED', $result['status']);
    }

    public function test_search_error_outcome_cannot_certify_empty_search(): void
    {
        $result = $this->provider([['resourceType' => 'Bundle', 'type' => 'searchset', 'total' => 0,
            'entry' => [['search' => ['mode' => 'outcome'], 'resource' => ['resourceType' => 'OperationOutcome']]]]])->search('ValueSet');
        self::assertSame('NOT_EXECUTED', $result['status']);
    }

    public function test_search_rejects_arbitrary_relative_resource_paths(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->provider([])->search('../Patient');
    }

    public function test_conflicting_code_system_versions_are_rejected_before_request(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->provider([])->validateCode('https://example.org/cs', 'x', null, '1', '2');
    }
}
