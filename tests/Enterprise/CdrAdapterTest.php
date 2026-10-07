<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;
use OpenEHR\Assistant\Integrations\Cdr\CdrConnection;
use OpenEHR\Assistant\Integrations\Cdr\ConfiguredCredentials;
use OpenEHR\Assistant\Integrations\Cdr\OpenEhrRestAdapter;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class CdrAdapterTest extends TestCase
{
    public static function reply(int $status = 200, string $body = '{"columns":[{"name":"value","path":"/ehr_id/value"}],"rows":[]}'): array
    { return ['status' => $status, 'body' => $body, 'content_type' => 'application/json', 'headers' => []]; }
    private function connection(array $replace = []): array
    { return (new CdrConnection(new CdrHttp(new Settings())))->validate($replace + ['name' => 'Development', 'baseUrl' => 'https://cdr.example', 'auth' => 'bearer', 'secrets' => ['token' => 'private-fixture-token']]); }
    public function test_standard_query_payload_authentication_empty_and_tabular_results(): void
    {
        $transport = $this->createMock(CdrHttp::class);
        $transport->expects(self::once())->method('request')->willReturnCallback(static function ($url, $method, $headers, $body, $timeout, $ca, $cancelled): array {
            self::assertSame('https://cdr.example/openehr/v1/query/aql', $url); self::assertSame('POST', $method);
            self::assertSame('Bearer private-fixture-token', $headers['Authorization']);
            self::assertSame(['q' => 'SELECT e FROM EHR e', 'query_parameters' => ['ehr' => 'synthetic'], 'fetch' => 25, 'offset' => 3], json_decode($body, true));
            return self::reply();
        });
        $result = (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->execute($this->connection(), 'SELECT e FROM EHR e', ['ehr' => 'synthetic'], 25, 3, static fn () => false);
        self::assertSame(0, $result['count']); self::assertSame([], $result['rows']);
    }
    public function test_http_failure_bodies_are_never_exposed(): void
    {
        foreach ([400 => 'CDR_QUERY_REJECTED', 401 => 'CDR_AUTHENTICATION_FAILED', 403 => 'CDR_FORBIDDEN', 404 => 'CDR_API_UNSUPPORTED', 429 => 'CDR_RATE_LIMITED', 500 => 'CDR_SERVER_ERROR', 504 => 'CDR_TIMEOUT'] as $status => $code) {
            $transport = $this->createStub(CdrHttp::class); $transport->method('request')->willReturn(self::reply($status, 'Sensitive upstream detail'));
            try { (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->execute($this->connection(), 'SELECT e FROM EHR e', [], 1, 0, static fn () => false); self::fail(); }
            catch (\RuntimeException $error) { self::assertSame($code, $error->getMessage()); }
        }
    }
    public function test_malformed_oversized_and_reflected_secret_responses_fail_closed(): void
    {
        $bodies = ['<html>not JSON</html>', '{"columns":[],"rows":[[1]]}', '{"columns":[{"name":"x"}],"rows":[["private-fixture-token"]]}', json_encode(['columns' => [['name' => 'x']], 'rows' => array_fill(0, 1001, [1])])];
        foreach ($bodies as $body) {
            $transport = $this->createStub(CdrHttp::class); $transport->method('request')->willReturn(self::reply(200, $body));
            try { (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->execute($this->connection(), 'SELECT e FROM EHR e', [], 1, 0, static fn () => false); self::fail(); }
            catch (\RuntimeException $error) { self::assertContains($error->getMessage(), ['CDR_INVALID_RESPONSE', 'CDR_UNSAFE_RESPONSE']); }
        }
    }
    public function test_connection_diagnostics_timeout_and_authentication(): void
    {
        foreach (['CDR_TIMEOUT', 'CDR_TLS_FAILED', 'CDR_UNAVAILABLE'] as $code) {
            $transport = $this->createStub(CdrHttp::class); $transport->method('request')->willThrowException(new \RuntimeException($code));
            $test = (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->test($this->connection());
            self::assertFalse($test['ok']); self::assertSame($code, $test['error']['code']);
        }
        $transport = $this->createStub(CdrHttp::class); $transport->method('request')->willReturn(self::reply());
        $test = (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->test($this->connection()); self::assertTrue($test['ok']); self::assertSame('PASS', $test['checks']['aql']);
    }
    public function test_oauth_credentials_are_scoped_to_token_endpoint_and_not_returned(): void
    {
        $calls = []; $transport = $this->createMock(CdrHttp::class);
        $transport->expects(self::exactly(2))->method('request')->willReturnCallback(static function ($url, $method, $headers, $body) use (&$calls): array {
            $calls[] = compact('url', 'headers', 'body');
            return count($calls) === 1 ? self::reply(200, '{"token_type":"Bearer","access_token":"access-fixture-token"}') : self::reply();
        });
        $connection = $this->connection(['auth' => 'oauth2', 'tokenUrl' => 'https://identity.example/token', 'clientId' => 'client', 'secrets' => ['clientSecret' => 'private-client-secret']]);
        (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->execute($connection, 'SELECT e FROM EHR e', [], 1, 0, static fn () => false);
        self::assertSame('https://identity.example/token', $calls[0]['url']); self::assertStringContainsString('grant_type=client_credentials', $calls[0]['body']);
        self::assertSame('Bearer access-fixture-token', $calls[1]['headers']['Authorization']); self::assertStringNotContainsString('private-client-secret', $calls[1]['body']);
    }
    public function test_connection_schema_blocks_credential_urls_header_injection_and_origin_changes(): void
    {
        foreach ([['baseUrl' => 'https://user:secret@cdr.example'], ['queryUrl' => 'https://other.example/query'], ['headers' => ['Authorization' => 'unsafe']], ['headers' => ['X-Key' => "x\r\nHost: other"]], ['timeout' => 121], ['baseUrl' => 'http://127.0.0.1'], ['secretRefs' => ['token' => 'env:HOME']]] as $bad) {
            try { $this->connection($bad); self::fail('Accepted unsafe configuration'); } catch (\InvalidArgumentException) { self::addToAssertionCount(1); }
        }
        $this->expectExceptionMessage('CDR_CREDENTIAL_REFERENCE_INVALID'); (new ConfiguredCredentials())->resolve(['secretRefs' => ['token' => 'env:HOME']]);
    }
    public function test_remote_templates_remain_distinct_and_use_definition_api(): void
    {
        $transport = $this->createMock(CdrHttp::class);
        $transport->expects(self::once())->method('request')->willReturnCallback(static function ($url): array { self::assertSame('https://cdr.example/openehr/v1/definition/template/adl1.4', $url); return self::reply(200, '[{"template_id":"Test","concept":"Synthetic"}]'); });
        $result = (new OpenEhrRestAdapter($transport, new ConfiguredCredentials()))->templates($this->connection()); self::assertSame('remote_cdr', $result['source']); self::assertSame('Test', $result['items'][0]['identifier']);
    }
}
