<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Integrations\Engine\HttpOpenEhrEngine;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class NativeEngineTest extends TestCase
{
    private string $secret;
    protected function setUp(): void
    {
        $this->secret = tempnam(sys_get_temp_dir(), 'engine-key-');
        file_put_contents($this->secret, str_repeat('a', 64));
    }
    protected function tearDown(): void
    {
        unlink($this->secret);
    }

    /** @return array<string, mixed> */
    public static function report(string $content = 'model', string $operation = 'validate/archetype'): array
    {
        return ['schema_version' => 1, 'operation' => $operation, 'content_sha256' => hash('sha256', $content),
            'engine' => ['adapter' => '1.0.0', 'archie' => '3.20.0', 'aql' => '2.35.0'], 'clinical_approval' => false,
            'valid' => true, 'status' => 'PASS', 'findings' => [], 'profile' => 'ADL2_AOM2_BMM',
            'completed_stage' => 'native_validation', 'dependencies' => []];
    }

    private function settings(): Settings
    {
        return new Settings(['OPENEHR_ENGINE_URL' => 'http://127.0.0.1:8090', 'OPENEHR_ENGINE_KEY_FILE' => $this->secret]);
    }
    /** @param array<string, mixed> $report */
    private static function response(array $report): Response
    {
        return new Response(200, ['Content-Type' => 'application/json'], json_encode(['ok' => true, 'data' => $report], JSON_THROW_ON_ERROR));
    }

    public function test_request_is_bound_to_fixed_operation_and_rotated_secret(): void
    {
        $history = [];
        $stack = HandlerStack::create(new MockHandler([self::response(self::report()), self::response(self::report())]));
        $stack->push(Middleware::history($history));
        $engine = new HttpOpenEhrEngine($this->settings(), new Client(['handler' => $stack]));
        self::assertTrue($engine->validate('model', 'adl2')['valid']);
        file_put_contents($this->secret, str_repeat('b', 64));
        $engine->validate('model', 'adl2');
        self::assertSame('http://127.0.0.1:8090/v1/validate/archetype', (string) $history[0]['request']->getUri());
        self::assertSame(str_repeat('a', 64), $history[0]['request']->getHeaderLine('X-Engine-Key'));
        self::assertSame(str_repeat('b', 64), $history[1]['request']->getHeaderLine('X-Engine-Key'));
        self::assertFalse($history[0]['options']['allow_redirects']);
    }

    public function test_unconfigured_engine_fails_explicitly_without_optional_services(): void
    {
        $this->expectExceptionMessage('ENGINE_NOT_CONFIGURED');
        (new HttpOpenEhrEngine(new Settings()))->validate('x', 'aql');
    }

    public function test_url_key_and_timeout_configuration_fail_closed(): void
    {
        foreach ([['OPENEHR_ENGINE_URL' => 'http://engine:8090'], ['OPENEHR_ENGINE_URL' => 'http://127.0.0.1:9000'],
            ['OPENEHR_ENGINE_URL' => 'https://engine.example/path'], ['OPENEHR_ENGINE_URL' => 'https://user:pass@engine.example'],
            ['OPENEHR_ENGINE_TIMEOUT' => '61'], ['OPENEHR_ENGINE_KEY_FILE' => 'relative']] as $bad) {
            try {
                new Settings($bad + ['OPENEHR_ENGINE_URL' => 'https://engine.example', 'OPENEHR_ENGINE_KEY_FILE' => $this->secret]);
                self::fail('Accepted unsafe configuration.');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
        file_put_contents($this->secret, "secret\r\nInjected: value");
        $this->expectExceptionMessage('ENGINE_CREDENTIAL_INVALID');
        (new HttpOpenEhrEngine($this->settings()))->validate('model', 'adl2');
    }

    public function test_invalid_or_inconsistent_response_cannot_attest_validation(): void
    {
        foreach ([['content_sha256' => str_repeat('0', 64)], ['operation' => 'validate/opt'], ['clinical_approval' => true],
            ['status' => 'FAIL'], ['profile' => 'full_conformance'], ['engine' => []], ['dependencies' => [['identifier' => 'unexpected']]],
            ['findings' => [['severity' => 'error', 'code' => 'ERROR', 'message' => 'bad', 'location' => '/', 'evidence' => [], 'remediation' => 'fix']]]] as $override) {
            $engine = new HttpOpenEhrEngine($this->settings(), new Client(['handler' => new MockHandler([self::response($override + self::report())])]));
            try {
                $engine->validate('model', 'adl2');
                self::fail('Accepted inconsistent engine report.');
            } catch (\RuntimeException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function test_redirect_authentication_timeout_and_invalid_json(): void
    {
        foreach ([new Response(302, ['Location' => 'https://untrusted.example']), new Response(401), new Response(504),
            new Response(200, ['Content-Type' => 'application/json'], '{"ok":true,"ok":false}'),
            new Response(200, ['Content-Type' => 'text/html'], '<html>login</html>')] as $response) {
            $engine = new HttpOpenEhrEngine($this->settings(), new Client(['handler' => new MockHandler([$response])]));
            try {
                $engine->validate('model', 'adl2');
                self::fail('Accepted failed transport.');
            } catch (\RuntimeException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function test_compiled_output_hash_is_verified(): void
    {
        $report = self::report('template', 'compile/template');
        $report['output'] = ['format' => 'opt2_adl', 'content' => 'generated', 'sha256' => str_repeat('0', 64)];
        $this->expectExceptionMessage('ENGINE_OUTPUT_HASH_MISMATCH');
        (new HttpOpenEhrEngine($this->settings(), new Client(['handler' => new MockHandler([self::response($report)])])))->compile('template', []);
    }

    public function test_legacy_compilation_is_bound_to_its_format_and_limited_validation_profile(): void
    {
        $source = '<template xmlns="openEHR/v1/Template"/>';
        $report = self::report($source, 'compile/template');
        $report['profile'] = 'OET14_COMPILATION_RM_STRUCTURE';
        $report['rm_release_basis'] = 'explicit_legacy_compatibility_profile';
        $report['checks'] = ['full_aom_semantics' => 'NOT_EXECUTED', 'clinical_review' => 'NOT_EXECUTED'];
        $report['limitations'] = ['Not full AOM conformance.'];
        $report['output'] = ['format' => 'opt14_xml', 'content' => '<template/>', 'sha256' => hash('sha256', '<template/>')];
        $engine = new HttpOpenEhrEngine($this->settings(), new Client(['handler' => new MockHandler([self::response($report)])]));
        self::assertSame('opt14_xml', $engine->compile($source, [])['output']['format']);
        foreach ([['profile' => 'ADL2_AOM2_BMM'], ['checks' => ['full_aom_semantics' => 'PASS', 'clinical_review' => 'NOT_EXECUTED']],
            ['output' => ['format' => 'opt2_adl', 'content' => '<template/>', 'sha256' => hash('sha256', '<template/>')]]] as $override) {
            $invalid = new HttpOpenEhrEngine($this->settings(), new Client(['handler' => new MockHandler([self::response($override + $report)])]));
            try {
                $invalid->compile($source, []);
                self::fail('Accepted an inconsistent legacy compiler attestation.');
            } catch (\RuntimeException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function test_application_pins_and_sorts_dependencies_and_rejects_duplicates(): void
    {
        $port = $this->createMock(OpenEhrEngine::class);
        $port->expects(self::once())->method('compile')->with('template', [
            ['identifier' => 'a.v1.0.0', 'content' => 'first', 'sha256' => hash('sha256', 'first')],
            ['identifier' => 'b.v1.0.0', 'content' => 'second', 'sha256' => hash('sha256', 'second')],
        ])->willReturn(['valid' => true]);
        $service = new NativeModels($port);
        $service->compile('template', [['identifier' => 'b.v1.0.0', 'content' => 'second'], ['identifier' => 'a.v1.0.0', 'content' => 'first']]);
        $this->expectExceptionMessage('ENGINE_DEPENDENCY_AMBIGUOUS');
        $service->compile('template', [['identifier' => 'a.v1.0.0', 'content' => 'first'], ['identifier' => 'a.v1.0.0', 'content' => 'changed']]);
    }
}
