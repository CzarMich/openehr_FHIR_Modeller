<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Integrations\Fhir;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Fhir\HttpFhirProvider;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(HttpFhirProvider::class)]
final class HttpFhirProviderTest extends TestCase
{
    public function testEmptyCapabilityParametersAreAJsonObjectForTheEngine(): void
    {
        $keyFile = tempnam(sys_get_temp_dir(), 'fhir-key-');
        self::assertIsString($keyFile);
        file_put_contents($keyFile, str_repeat('fixture', 8));
        $history = [];
        $handler = HandlerStack::create(new MockHandler([new Response(200, [], '{"toolchainReleases":[]}')]));
        $handler->push(Middleware::history($history));
        try {
            $provider = new HttpFhirProvider(new Settings(['FHIR_ENGINE_URL' => 'http://fhir:8094', 'FHIR_ENGINE_KEY_FILE' => $keyFile]), 'shared', new Client(['handler' => $handler]));
            $provider->execute('capabilities.get', []);
            $body = json_decode((string) $history[0]['request']->getBody(), false, 16, JSON_THROW_ON_ERROR);
            self::assertInstanceOf(\stdClass::class, $body->parameters);
            self::assertSame('capabilities.get', $body->operation);
        } finally {
            unlink($keyFile);
        }
    }

    public function testConfiguredEngineMustHaveRealToolsToBeReady(): void
    {
        $client = new Client(['handler' => HandlerStack::create(new MockHandler([new Response(200, [], '{"status":"ok","toolsReady":false}')]))]);
        $this->expectExceptionMessage('FHIR_ENGINE_NOT_READY');
        (new HttpFhirProvider(new Settings(['FHIR_ENGINE_URL' => 'http://fhir:8094']), 'shared', $client))->assertReady();
    }
    public function testVerifiedToolingReadinessSucceeds(): void
    {
        $client = new Client(['handler' => HandlerStack::create(new MockHandler([new Response(200, [], '{"status":"ok","toolsReady":true}')]))]);
        (new HttpFhirProvider(new Settings(['FHIR_ENGINE_URL' => 'http://fhir:8094']), 'shared', $client))->assertReady();
        self::assertTrue(true);
    }
    public function testUnconfiguredOptionalEngineDoesNotProbeNetwork(): void
    {
        $client = new Client(['handler' => HandlerStack::create(new MockHandler([]))]);
        (new HttpFhirProvider(new Settings(), 'shared', $client))->assertReady();
        self::assertTrue(true);
    }
}
