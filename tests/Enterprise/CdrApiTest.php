<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Firebase\JWT\JWT;
use Nyholm\Psr7\ServerRequest;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Rest\CdrApi;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class CdrApiTest extends TestCase
{
    private string $directory;
    private CdrApi $api;
    private const string KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/cdr-api-' . bin2hex(random_bytes(8)); mkdir($this->directory, 0700);
        file_put_contents($this->directory . '/key', self::KEY);
        $settings = new Settings(['CDR_ENABLED' => 'true', 'CDR_DATA_DIR' => $this->directory, 'CDR_ENCRYPTION_KEY_FILE' => $this->directory . '/key',
            'GOVERNANCE_BROWSER_ORIGIN' => 'https://models.example', 'GOVERNANCE_LOCAL_IDENTITY_ISSUER' => 'https://models.example/identity/local',
            'GOVERNANCE_BROWSER_KEYS' => json_encode(['active' => self::KEY]), 'MCP_ALLOWED_HOSTS' => 'models.example']);
        $engine = $this->createStub(OpenEhrEngine::class); $engine->method('validate')->willReturn(['valid' => true, 'status' => 'PASS']);
        $this->api = new CdrApi($settings, new SqliteAuditStore(':memory:'), new NativeModels($engine));
    }
    protected function tearDown(): void { foreach (glob($this->directory . '/*') as $path) { unlink($path); } rmdir($this->directory); }
    private function request(string $operation, array $input = [], array $replace = [], string $purpose = 'cdr'): ServerRequest
    {
        $target = '/api/v1/cdr/' . $operation; $body = json_encode((object) $input);
        $claims = array_replace(['iss' => 'https://models.example', 'aud' => 'openehr-modelling-' . $purpose,
            'identity_issuer' => 'https://models.example/identity/local', 'identity_method' => 'interactive_local', 'sub' => 'alice',
            'tenant' => 'https://models.example/identity/local', 'roles' => [], 'iat' => time(), 'exp' => time() + 60, 'session_started' => time(),
            'jti' => bin2hex(random_bytes(32)), 'method' => 'POST', 'target' => $target, 'body_sha256' => hash('sha256', $body)], $replace);
        $token = JWT::encode($claims, self::KEY, 'HS256', 'active', ['typ' => 'openehr-' . $purpose . '+jwt']);
        return new ServerRequest('POST', 'https://models.example' . $target, ['Authorization' => 'Bearer ' . $token, 'Content-Type' => 'application/json'], $body);
    }
    public function test_purpose_body_target_replay_and_session_bindings(): void
    {
        self::assertSame(401, $this->api->handle($this->request('connections', purpose: 'review'))->getStatusCode());
        foreach ([['target' => '/api/v1/cdr/execute'], ['body_sha256' => str_repeat('f', 64)], ['session_started' => time() - 3601]] as $bad) { self::assertSame(401, $this->api->handle($this->request('connections', replace: $bad))->getStatusCode()); }
        $request = $this->request('connections'); self::assertSame(200, $this->api->handle($request)->getStatusCode()); self::assertSame(401, $this->api->handle($request)->getStatusCode());
        self::assertSame(200, $this->api->handle($this->request('connections', replace: ['session_started' => time() - 1800]))->getStatusCode());
    }
    public function test_connections_cannot_be_read_or_used_by_another_actor(): void
    {
        $response = $this->api->handle($this->request('connection-save', ['connection' => ['name' => 'Development', 'baseUrl' => 'https://cdr.example', 'auth' => 'bearer', 'secrets' => ['token' => 'never-display-fixture-secret']]]));
        self::assertSame(200, $response->getStatusCode()); self::assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $saved = json_decode((string) $response->getBody(), true); self::assertStringNotContainsString('never-display-fixture-secret', (string) $response->getBody());
        $bob = $this->api->handle($this->request('connections', replace: ['sub' => 'bob'])); self::assertSame([], json_decode((string) $bob->getBody(), true)['items']);
        self::assertSame(404, $this->api->handle($this->request('connection-test', ['id' => $saved['id']], ['sub' => 'bob']))->getStatusCode());
        self::assertSame(400, $this->api->handle($this->request('execute', ['id' => $saved['id'], 'query' => 'SELECT e FROM EHR e', 'token' => 'not-accepted']))->getStatusCode());
    }
    public function test_model_validation_works_without_a_cdr_connection_or_ai(): void
    {
        $response = $this->api->handle($this->request('validate', ['query' => 'SELECT e FROM EHR e']));
        self::assertSame(200, $response->getStatusCode()); self::assertTrue(json_decode((string) $response->getBody(), true)['valid']);
    }
}
