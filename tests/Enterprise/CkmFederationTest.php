<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Apis\CkmClient;
use OpenEHR\Assistant\Application\FederatedCkmSearch;
use OpenEHR\Assistant\Configuration\CkmAuthentication;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Knowledge\CkmSearchProvider;
use OpenEHR\Assistant\Integrations\Knowledge\ConfiguredCkmSearch;
use OpenEHR\Assistant\Tools\CkmSourcesService;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

#[CoversNothing]
final class CkmFederationTest extends TestCase
{
    private static function client(array $responses, array &$history, string $base): Client
    {
        $handler = HandlerStack::create(new MockHandler($responses));
        $handler->push(Middleware::history($history));
        return new Client(['handler' => $handler, 'base_uri' => $base, 'allow_redirects' => false]);
    }

    public static function methods(): array
    {
        return [
            [['method' => 'basic', 'username' => 'fixture-user', 'secret' => 'fixture:password'], 'Authorization', 'Basic ' . base64_encode('fixture-user:fixture:password')],
            [['method' => 'bearer', 'secret' => 'fixture.token'], 'Authorization', 'Bearer fixture.token'],
            [['method' => 'session', 'secret' => 'fixture-session.node1'], 'JSESSIONID', 'fixture-session.node1'],
            [['method' => 'api_key', 'header' => 'X-Fixture-Key', 'secret' => 'fixture-key'], 'X-Fixture-Key', 'fixture-key'],
        ];
    }

    #[DataProvider('methods')]
    public function test_credentials_are_bound_to_the_named_source_for_sync_and_async_calls(array $profile, string $header, string $expected): void
    {
        $settings = new Settings(['CKM_SOURCES' => '{"regional":"https://regional.example/ckm/rest/"}', 'CKM_AUTH' => json_encode(['regional' => $profile], JSON_THROW_ON_ERROR)]);
        $history = [];
        $defaultHistory = [];
        $regional = self::client([new Response(200, [], '[]'), new Response(200, [], '[]')], $history, 'https://regional.example/ckm/rest/');
        $default = self::client([new Response(200, [], '[]')], $defaultHistory, 'https://ckm.openehr.org/ckm/rest/');
        $client = new CkmClient(new NullLogger(), null, $settings, ['default' => $default, 'regional' => $regional]);
        $selected = $client->forSource('regional');
        $selected->request('GET', 'v1/archetypes', ['headers' => [strtolower($header) => 'must-not-override', 'Accept' => 'application/json']]);
        $selected->requestAsync('GET', 'v1/templates')->wait();
        $selected->forSource('default')->request('GET', 'v1/archetypes');
        foreach ($history as $request) {
            self::assertSame($expected, $request['request']->getHeaderLine($header));
            self::assertFalse($request['options']['allow_redirects']);
            self::assertFalse($request['options']['cookies']);
            self::assertSame('regional.example', $request['request']->getUri()->getHost());
        }
        self::assertFalse($defaultHistory[0]['request']->hasHeader($header));
        $discovery = json_encode((new CkmSourcesService($client))->sources(), JSON_THROW_ON_ERROR);
        self::assertStringNotContainsString($profile['secret'], $discovery);
        self::assertStringNotContainsString($profile['username'] ?? 'not-a-public-user', $discovery);
    }

    public function test_mounted_secret_rotation_is_read_without_rebuilding_the_client(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'ckm-credential-');
        try {
            $profile = ['method' => 'session', 'secret_file' => $file];
            file_put_contents($file, "fixture-one\n");
            self::assertSame(['JSESSIONID' => 'fixture-one'], CkmAuthentication::headers($profile));
            file_put_contents($file, "fixture-two\r\n");
            self::assertSame(['JSESSIONID' => 'fixture-two'], CkmAuthentication::headers($profile));
            unlink($file);
            $this->expectExceptionMessage('CKM_CREDENTIAL_UNAVAILABLE');
            CkmAuthentication::headers($profile);
        } finally {
            if (is_file($file)) {
                unlink($file);
            }
        }
    }

    public static function invalidProfiles(): array
    {
        return [
            ['[]'], ['{"default":{}}'], ['{"unknown":{"method":"session","secret":"x"}}'],
            ['{"default":{"method":"session","secret":"x","secret_file":"/tmp/x"}}'],
            ['{"default":{"method":"session","secret_file":"https://example.org/key"}}'],
            ['{"default":{"method":"session","secret_file":"relative/key"}}'],
            ['{"default":{"method":"basic","username":"u:other","secret":"x"}}'],
            ['{"default":{"method":"basic","username":"u"}}'],
            ['{"default":{"method":"bearer","secret":"x\\r\\ny"}}'],
            ['{"default":{"method":"bearer","secret":"token with spaces"}}'],
            ['{"default":{"method":"session","secret":"x","base_url":"https://evil.example/"}}'],
            ['{"default":{"method":"api_key","header":"Host","secret":"x"}}'],
            ['{"default":{"method":"api_key","header":"Cookie","secret":"x"}}'],
            ['{"default":{"method":"api_key","header":"Authorization","secret":"x"}}'],
            ['{"default":{"method":"api_key","header":"X-Key\\r\\nHost","secret":"x"}}'],
            ['{"default":{"method":"session","secret":"x","secret":"y"}}'],
        ];
    }

    #[DataProvider('invalidProfiles')]
    public function test_invalid_or_ambiguous_auth_configuration_fails_closed(string $json): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Settings(['CKM_AUTH' => $json]);
    }

    public function test_redirects_are_not_followed_and_source_failure_is_explicit(): void
    {
        $settings = new Settings(['CKM_AUTH' => '{"default":{"method":"bearer","secret":"fixture-secret-never-return"}}']);
        $history = [];
        $transport = self::client([new Response(302, ['Location' => 'https://unrelated.example/collect'], '[]')], $history, $settings->get('CKM_API_BASE_URL'));
        $provider = new ConfiguredCkmSearch(new CkmClient(new NullLogger(), $transport, $settings), new NullLogger());
        $result = (new FederatedCkmSearch($provider, $settings))->search('archetype', 'synthetic');
        self::assertSame('UNAVAILABLE', $result['status']);
        self::assertSame('CKM_SOURCE_UNAVAILABLE', $result['source_results'][0]['error']);
        self::assertCount(1, $history);
        self::assertStringNotContainsString('fixture-secret', json_encode($result));
    }

    public function test_federation_preserves_provenance_versions_partial_failures_and_bounded_totals(): void
    {
        $provider = new class () implements CkmSearchProvider {
            public function sources(): array
            {
                return ['a' => 'https://a.example/', 'b' => 'https://b.example/', 'down' => 'https://down.example/'];
            }
            public function search(string $source, string $kind, string $keyword, int $limit, float $timeout): array
            {
                if ($source === 'down') {
                    throw new \RuntimeException('sensitive upstream response must not leak');
                }
                return ['items' => [['cid' => '1.2.3', 'archetypeId' => 'openEHR-EHR-OBSERVATION.fixture.v1', 'revision' => $source === 'a' ? '1' : '2', 'score' => 100]], 'total' => 30];
            }
        };
        $search = new FederatedCkmSearch($provider, new Settings());
        $result = $search->search('archetype', 'synthetic', ['b', 'down', 'a'], 50);
        self::assertSame('PARTIAL', $result['status']);
        self::assertSame(['a', 'b'], array_column($result['items'], 'source'));
        self::assertSame(['1', '2'], array_column($result['items'], 'revision'));
        self::assertSame(2, $result['total']);
        self::assertTrue($result['truncated']);
        self::assertFalse($result['all_sources_responded']);
        self::assertStringNotContainsString('sensitive upstream', json_encode($result));
        self::assertSame($result['items'], $search->search('archetype', 'synthetic', ['a', 'b', 'down'], 50)['items']);
        $limited = $search->search('archetype', 'synthetic', ['a', 'b'], 1);
        self::assertCount(1, $limited['items']);
        self::assertSame(2, $limited['total']);
        self::assertSame('COMPLETE', $limited['status']);
        self::assertTrue($limited['truncated']);
    }

    public function test_shared_deadline_reports_unattempted_sources_instead_of_silent_omission(): void
    {
        $provider = new class () implements CkmSearchProvider {
            public array $attempted = [];
            public function sources(): array
            {
                return ['a' => 'https://a.example/', 'b' => 'https://b.example/'];
            }
            public function search(string $source, string $kind, string $keyword, int $limit, float $timeout): array
            {
                $this->attempted[] = $source;
                usleep(1100000);
                return ['items' => [], 'total' => 0];
            }
        };
        $result = (new FederatedCkmSearch($provider, new Settings(['CKM_FEDERATION_TIMEOUT' => '1'])))->search('template', 'synthetic');
        self::assertSame(['a'], $provider->attempted);
        self::assertSame('NOT_EXECUTED', $result['source_results'][1]['status']);
        self::assertSame('PARTIAL', $result['status']);
    }

    public function test_bad_queries_are_rejected_before_any_upstream_request(): void
    {
        $provider = $this->createMock(CkmSearchProvider::class);
        $provider->method('sources')->willReturn(['default' => 'https://ckm.example/']);
        $provider->expects(self::never())->method('search');
        $search = new FederatedCkmSearch($provider, new Settings());
        foreach ([['archetype', '', [], 20], ['archetype', 'x', [], 0], ['execute', 'x', [], 20],
            ['template', 'x', ['default', 'default'], 20], ['template', 'x', ['https://other.example/'], 20],
            ['template', 'x', ['missing'], 20], ['template', 'x', [null], 20], ['template', 'x', [1 => 'default'], 20],
            ['template', 'x', array_fill(0, 10000, 'default'), 20], ['archetype', "x\r\ny", [], 20]] as $arguments) {
            try {
                $search->search(...$arguments);
                self::fail('Invalid federated query was accepted.');
            } catch (\InvalidArgumentException) {
                self::assertTrue(true);
            }
        }
    }
}
