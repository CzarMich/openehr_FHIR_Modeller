<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Mcp\Schema\ClientCapabilities;
use Mcp\Schema\Implementation;
use Mcp\Schema\Request\InitializeRequest;
use Mcp\Server\Session\InMemorySessionStore;
use Mcp\Server\Session\Session;
use OpenEHR\Assistant\Mcp\InitializeHandler;
use OpenEHR\Assistant\Mcp\ProtocolProfile;
use OpenEHR\Assistant\Mcp\RequestErrors;
use OpenEHR\Assistant\Configuration\Settings;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class McpProtocolTest extends TestCase
{
    public function test_negotiation_preserves_supported_versions_and_sdk_session_state(): void
    {
        $handler = new InitializeHandler(new Implementation('test', '1'), 'Instructions');
        foreach (['2025-03-26', '2025-06-18', '2025-11-25', 'future', '2024-11-05'] as $requested) {
            $session = new Session(new InMemorySessionStore());
            $request = new InitializeRequest($requested, new ClientCapabilities(), new Implementation('client', '1'));
            $request = $request->withId('request-42');
            self::assertTrue($handler->supports($request));
            $response = $handler->handle($request, $session);
            $wire = json_decode(json_encode($response, JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
            $expected = str_starts_with($requested, '2025-') ? $requested : '2025-11-25';
            self::assertSame('request-42', $wire['id']);
            self::assertSame($expected, $wire['result']['protocolVersion']);
            self::assertSame($expected, $session->get('protocol_version'));
            self::assertSame('client', $session->get('client_info')['name']);
            self::assertSame('Instructions', $wire['result']['instructions']);
        }
    }

    public function test_capabilities_do_not_advertise_absent_push_or_task_services(): void
    {
        $capabilities = json_decode(json_encode(ProtocolProfile::capabilities(), JSON_THROW_ON_ERROR), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame(['logging', 'completions', 'prompts', 'resources', 'tools'], array_keys($capabilities));
        self::assertEmpty($capabilities['resources']);
        self::assertEmpty($capabilities['tools']);
        self::assertEmpty($capabilities['prompts']);
    }

    public function test_unknown_method_correction_preserves_ids_and_other_errors(): void
    {
        $ids = RequestErrors::unknownIds('{"jsonrpc":"2.0","id":"42","method":"unknown"}');
        self::assertSame(['42'], $ids);
        $input = '{"jsonrpc":"2.0","id":"42","error":{"code":-32600,"message":"Unknown method"}}';
        $output = json_decode(RequestErrors::normalize($input, $ids), true, flags: JSON_THROW_ON_ERROR);
        self::assertSame('42', $output['id']);
        self::assertSame(-32601, $output['error']['code']);
        self::assertSame($input, RequestErrors::normalize($input, [42]));
        self::assertSame([], RequestErrors::unknownIds('{"jsonrpc":"2.0","id":42,"method":"tools/call"}'));
        self::assertSame([], RequestErrors::unknownIds('{"jsonrpc":"wrong","id":42,"method":"unknown"}'));
        self::assertSame([], RequestErrors::unknownIds('{'));
        self::assertSame([], RequestErrors::unknownIds('{"jsonrpc":"2.0","method":"notification/unknown"}'));
        $parse = '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}';
        self::assertSame($parse, RequestErrors::normalize($parse, $ids));
    }

    public function test_explicit_loopback_http_cors_is_only_permitted_outside_production(): void
    {
        foreach (['http://localhost:3000', 'http://127.0.0.1:8343', 'http://[::1]:8343'] as $origin) {
            self::assertSame($origin, (new Settings(['APP_ENV' => 'testing', 'CORS_ALLOWED_ORIGINS' => $origin]))->get('CORS_ALLOWED_ORIGINS'));
        }
        foreach (['http://localhost.evil:3000', 'http://192.168.1.2', 'http://localhost:65536', 'http://localhost/path', 'http://localhost@evil', 'http://127.1', 'null', '*'] as $origin) {
            try {
                new Settings(['APP_ENV' => 'testing', 'CORS_ALLOWED_ORIGINS' => $origin]);
                self::fail('Unsafe origin accepted');
            } catch (\InvalidArgumentException) {
                self::assertTrue(true);
            }
        }
        $this->expectException(\InvalidArgumentException::class);
        new Settings(['APP_ENV' => 'production', 'AUTH_MODE' => 'api_key', 'AUTH_API_KEY' => str_repeat('x', 40), 'CORS_ALLOWED_ORIGINS' => 'http://localhost:3000']);
    }
}
