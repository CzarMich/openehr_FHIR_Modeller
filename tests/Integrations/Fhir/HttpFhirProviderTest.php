<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Integrations\Fhir;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Fhir\HttpFhirProvider;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(HttpFhirProvider::class)]
final class HttpFhirProviderTest extends TestCase
{
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
