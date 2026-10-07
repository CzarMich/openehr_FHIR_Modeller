<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Integrations\Fhir;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;
use OpenEHR\Assistant\Integrations\Fhir\FhirConnections;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(FhirConnections::class)]
final class FhirConnectionsTest extends TestCase
{
    private string $directory;
    protected function setUp(): void
    { $this->directory = sys_get_temp_dir() . '/fhir-connection-' . bin2hex(random_bytes(8)); mkdir($this->directory, 0700); }
    protected function tearDown(): void
    { foreach (glob($this->directory . '/*') as $file) { unlink($file); } rmdir($this->directory); }

    private function settings(): Settings
    {
        file_put_contents($this->directory . '/login.json', '{"email":"agent@example.org","password":"test-only-secret"}');
        file_put_contents($this->directory . '/connections.json', json_encode(['ig-dev' => ['type' => 'ig', 'baseUrl' => 'https://ig.example.org',
            'loginFile' => $this->directory . '/login.json']], JSON_THROW_ON_ERROR));
        return new Settings(['FHIR_CONNECTIONS_FILE' => $this->directory . '/connections.json']);
    }

    public function testActualIgAuthenticationContractAndSafeSummary(): void
    {
        $settings = $this->settings(); $calls = [];
        $http = $this->createMock(CdrHttp::class);
        $http->expects(self::exactly(3))->method('request')->willReturnCallback(static function ($url, $method, $headers, $body) use (&$calls): array {
            $calls[] = [$url, $method, $headers, $body];
            return ['status' => 200, 'body' => str_ends_with($url, '/login') ? '{"token":"test-jwt"}' : '{"status":"ok"}', 'content_type' => 'application/json', 'headers' => []];
        });
        $connections = new FhirConnections($settings, $http);
        $summary = $connections->summaries()[0];
        self::assertTrue($summary['hasCredentials']); self::assertArrayNotHasKey('loginFile', $summary);
        $connections->test('ig-dev'); $connections->test('ig-dev');
        self::assertSame('https://ig.example.org/api/v1/auth/login', $calls[0][0]);
        self::assertSame('POST', $calls[0][1]); self::assertArrayNotHasKey('Authorization', $calls[0][2]);
        self::assertSame('agent@example.org', json_decode($calls[0][3], true)['email']);
        self::assertSame('Bearer test-jwt', $calls[1][2]['Authorization']);
        self::assertSame('https://ig.example.org/api/v1/admin/health', $calls[1][0]);
    }

    public function testDeniedLoginDoesNotReachProjectEndpointOrLeakResponse(): void
    {
        $settings = $this->settings(); $http = $this->createMock(CdrHttp::class);
        $http->expects(self::once())->method('request')->willReturn(['status' => 401, 'body' => 'private diagnostic', 'content_type' => 'text/plain', 'headers' => []]);
        $this->expectExceptionMessage('FHIR_CONNECTION_PERMISSION_DENIED');
        (new FhirConnections($settings, $http))->test('ig-dev');
    }

    public function testCallerCannotInjectRequestDestination(): void
    {
        $settings = $this->settings(); $http = $this->createMock(CdrHttp::class); $http->expects(self::never())->method('request');
        $this->expectExceptionMessage('FHIR_REQUEST_PATH_INVALID');
        (new FhirConnections($settings, $http))->request('ig-dev', 'ig', 'GET', '/metadata?redirect=https://other.example');
    }
}
