<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Apis\CkmClient;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use Nyholm\Psr7\ServerRequest;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;

#[CoversNothing]
final class ConfigurationAndAuthTest extends TestCase
{
    public function test_named_ckms_and_branding_are_configuration_driven(): void
    {
        $settings = new Settings(['PRODUCT_NAME' => 'Another organisation',
            'CKM_SOURCES' => '{"regional":"https://regional.example.org/ckm/rest"}', 'CKM_DEFAULT_SOURCE' => 'regional']);
        self::assertSame('Another organisation', $settings->get('PRODUCT_NAME'));
        $client = new CkmClient(new NullLogger(), settings: $settings);
        self::assertSame('regional', $client->defaultSource());
        self::assertSame('https://regional.example.org/ckm/rest/', $client->sources()['regional']);
        $http = HttpClientFactory::create($client->sources()['regional'], 5, $settings);
        self::assertSame('https://regional.example.org/ckm/rest/', (string) $http->getConfig('base_uri'));
        self::assertFalse($http->getConfig('allow_redirects'));
        self::assertTrue($http->getConfig('verify'));
        self::assertCount(2, $client->sources());
    }

    #[DataProvider('badConfiguration')]
    public function test_bad_configuration_fails_closed(array $values): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Settings($values);
    }

    public static function badConfiguration(): array
    {
        return [
            [['AUTH_MODE' => 'api_key', 'AUTH_API_KEY' => 'short']], [['AUTH_MODE' => 'unknown']],
            [['CKM_API_BASE_URL' => 'http://example.org']], [['CKM_API_BASE_URL' => 'https://user:secret@example.org']],
            [['CKM_SOURCES' => '{invalid']], [['CKM_SOURCES' => '["https://example.org"]']],
            [['CKM_DEFAULT_SOURCE' => 'missing']], [['CKM_SOURCES' => '{"../x":"https://example.org"}']],
            [['HTTP_SSL_VERIFY' => 'false']], [['MCP_PORT' => '65536']], [['CKM_TIMEOUT' => '0']],
            [['MCP_ALLOWED_HOSTS' => '*']], [['CORS_ALLOWED_ORIGINS' => '*']],
        ];
    }

    public function test_api_key_hosts_origins_and_size_are_enforced_independently(): void
    {
        $key = str_repeat('a', 32);
        $guard = new HttpGuard(new Settings(['AUTH_MODE' => 'api_key', 'AUTH_API_KEY' => $key,
            'CORS_ALLOWED_ORIGINS' => 'https://client.example', 'MAX_REQUEST_BYTES' => '100']));
        $request = new ServerRequest('POST', 'http://localhost/mcp', ['X-API-Key' => $key], '{}');
        self::assertNull($guard->check($request));
        self::assertSame(401, $guard->check($request->withoutHeader('X-API-Key'))->getStatusCode());
        self::assertSame(401, $guard->check($request->withHeader('X-API-Key', 'wrong'))->getStatusCode());
        self::assertSame(403, $guard->check($request->withHeader('Host', 'evil.example')->withHeader('Origin', 'https://client.example'))->getStatusCode());
        self::assertSame(403, $guard->check($request->withHeader('Host', 'localhost,evil.example'))->getStatusCode());
        self::assertSame(403, $guard->check($request->withHeader('Origin', 'https://evil.example'))->getStatusCode());
        self::assertSame(413, $guard->check(new ServerRequest('POST', 'http://localhost/mcp', ['X-API-Key' => $key], str_repeat('a', 101)))->getStatusCode());
        $preflight = $guard->check($request->withMethod('OPTIONS')->withoutHeader('X-API-Key')->withHeader('Origin', 'https://client.example'));
        self::assertSame(204, $preflight->getStatusCode());
        self::assertStringContainsString('PUT', $preflight->getHeaderLine('Access-Control-Allow-Methods'));
    }

    public function test_no_auth_and_oidc_do_not_open_a_production_endpoint(): void
    {
        $request = new ServerRequest('POST', 'http://localhost/mcp', [], '{}');
        self::assertSame(401, (new HttpGuard(new Settings(['APP_ENV' => 'production'])))->check($request)->getStatusCode());
        self::assertSame(401, (new HttpGuard(new Settings(['AUTH_MODE' => 'oidc'])))->check($request)->getStatusCode());
        self::assertNull((new HttpGuard(new Settings()))->check($request));
    }

    public function test_unknown_size_sapi_stream_is_bounded_and_rewound(): void
    {
        $stream = $this->createStub(\Psr\Http\Message\StreamInterface::class);
        $stream->method('getSize')->willReturn(null);
        $stream->method('isSeekable')->willReturn(true);
        $stream->method('read')->willReturn('{}');
        $request = (new ServerRequest('POST', 'http://localhost/mcp'))->withBody($stream);
        self::assertNull((new HttpGuard(new Settings()))->check($request));
        $oversize = $this->createStub(\Psr\Http\Message\StreamInterface::class);
        $oversize->method('getSize')->willReturn(null);
        $oversize->method('isSeekable')->willReturn(true);
        $oversize->method('read')->willReturn(str_repeat('x', 101));
        self::assertSame(413, (new HttpGuard(new Settings(['MAX_REQUEST_BYTES' => '100'])))->check($request->withBody($oversize))->getStatusCode());
    }

    #[DataProvider('unsafePaths')]
    public function test_outbound_paths_cannot_escape_configured_origin(string $path): void
    {
        $this->expectException(\InvalidArgumentException::class);
        HttpClientFactory::relativePath($path);
    }

    public static function unsafePaths(): array
    {
        return [['https://evil.example'], ['//evil.example'], ['../metadata'], ['v1/../../admin'], ['v1/%2e%2e/admin'], ['v1/test?x=y'], ["v1/line\n"]];
    }
}
