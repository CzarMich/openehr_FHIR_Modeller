<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

use OpenEHR\Assistant\Domain\Cdr\CdrAdapter;
use OpenEHR\Assistant\Domain\Cdr\CredentialResolver;

/** Standard openEHR Query and Definition APIs. No vendor persistence endpoints. */
final readonly class OpenEhrRestAdapter implements CdrAdapter
{
    public function __construct(private CdrHttp $http, private CredentialResolver $credentials) {}

    public function test(array $connection): array
    {
        $connection['timeout'] = min(15, $connection['timeout']);
        $started = microtime(true);
        $checks = ['network' => 'UNKNOWN', 'tls' => 'UNKNOWN', 'authentication' => 'UNKNOWN', 'openehr_api' => 'UNKNOWN', 'aql' => 'UNKNOWN'];
        try {
            $reply = $this->send($connection, $connection['apiUrl'], 'GET', null, static fn (): bool => false);
            $checks['network'] = 'PASS';
            $checks['tls'] = str_starts_with($connection['apiUrl'], 'https:') ? 'PASS' : 'NOT_APPLICABLE';
            $checks['openehr_api'] = $reply['status'] >= 200 && $reply['status'] < 300 ? 'PASS' : 'UNKNOWN';
            $version = $reply['headers']['openehr-rest-api-version'] ?? $reply['headers']['openehr-version'] ?? null;
            // A nil EHR identifier and a one-row bound avoid retrieving patient records during a connection test.
            $this->execute($connection, 'SELECT e/ehr_id/value FROM EHR e WHERE e/ehr_id/value = $connection_test_ehr', ['connection_test_ehr' => '00000000-0000-0000-0000-000000000000'], 1, 0, static fn (): bool => false);
            $checks['authentication'] = $connection['auth'] === 'none' ? 'NOT_CONFIGURED' : 'PASS';
            $checks['openehr_api'] = 'PASS'; $checks['aql'] = 'PASS';
            return ['ok' => true, 'checks' => $checks, 'version' => $version, 'duration_ms' => (int) round((microtime(true) - $started) * 1000)];
        } catch (\RuntimeException $error) {
            $code = $error->getMessage();
            if (in_array($code, ['CDR_AUTHENTICATION_FAILED', 'CDR_FORBIDDEN'], true)) { $checks['network'] = 'PASS'; $checks['authentication'] = 'FAIL'; }
            if ($code === 'CDR_TLS_FAILED') { $checks['tls'] = 'FAIL'; }
            $checks['aql'] = 'FAIL';
            return ['ok' => false, 'checks' => $checks, 'error' => ['code' => CdrErrors::safe($code)], 'duration_ms' => (int) round((microtime(true) - $started) * 1000)];
        }
    }

    public function execute(array $connection, string $query, array $parameters, ?int $fetch, ?int $offset, callable $cancelled): array
    {
        $payload = ['q' => $query, 'query_parameters' => (object) $parameters];
        if ($fetch !== null) { $payload['fetch'] = $fetch; }
        if ($offset !== null) { $payload['offset'] = $offset; }
        $reply = $this->send($connection, $connection['queryUrl'], 'POST', json_encode($payload, JSON_THROW_ON_ERROR), $cancelled);
        self::status($reply['status']);
        try { $data = json_decode($reply['body'], true, 64, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
        if (!is_array($data) || !isset($data['columns'], $data['rows']) || !is_array($data['columns']) || !array_is_list($data['columns'])
            || !is_array($data['rows']) || !array_is_list($data['rows']) || count($data['rows']) > 1000 || count($data['columns']) > 200) {
            throw new \RuntimeException('CDR_INVALID_RESPONSE');
        }
        foreach ($data['columns'] as $column) {
            if (!is_array($column) || !is_string($column['name'] ?? null)) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
        }
        foreach ($data['rows'] as $row) {
            if (!is_array($row) || !array_is_list($row) || count($row) !== count($data['columns'])) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
        }
        return ['columns' => $data['columns'], 'rows' => $data['rows'], 'count' => count($data['rows']), 'json' => $data, 'raw' => $reply['body'], 'content_type' => $reply['content_type']];
    }

    public function templates(array $connection, ?string $identifier = null): array
    {
        if ($identifier !== null && ($identifier === '' || strlen($identifier) > 300 || preg_match('/[\x00-\x1f\x7f]/', $identifier))) { throw new \InvalidArgumentException('CDR_INVALID_TEMPLATE_ID'); }
        $url = $connection['apiUrl'] . '/definition/template/adl1.4' . ($identifier === null ? '' : '/' . rawurlencode($identifier));
        $reply = $this->send($connection, $url, 'GET', null, static fn (): bool => false, $identifier === null ? 'application/json' : 'application/xml');
        self::status($reply['status']);
        if ($identifier !== null) {
            return ['source' => 'remote_cdr', 'identifier' => $identifier, 'format' => 'opt14', 'content' => $reply['body'], 'sha256' => hash('sha256', $reply['body'])];
        }
        try { $data = json_decode($reply['body'], true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
        if (!is_array($data) || !array_is_list($data) || count($data) > 10000) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
        $items = [];
        foreach ($data as $row) {
            if (!is_array($row) || !is_string($row['template_id'] ?? null)) { throw new \RuntimeException('CDR_INVALID_RESPONSE'); }
            $items[] = ['identifier' => $row['template_id'], 'concept' => is_string($row['concept'] ?? null) ? $row['concept'] : ''];
        }
        return ['source' => 'remote_cdr', 'items' => $items];
    }

    /**
     * @param array<string, mixed> $connection
     * @param callable(): bool $cancelled
     *
     * @return array{status: int, body: string, content_type: string, headers: array<string, string>} */
    private function send(array $connection, string $url, string $method, ?string $body, callable $cancelled, string $accept = 'application/json'): array
    {
        $secrets = $this->credentials->resolve($connection);
        $headers = ['Accept' => $accept, 'Content-Type' => 'application/json'];
        foreach ($connection['headers'] as $key => $value) { $headers[$key] = $value; }
        if ($connection['tenant'] !== '') { $headers[$connection['tenantHeader']] = $connection['tenant']; }
        switch ($connection['auth']) {
            case 'basic': $headers['Authorization'] = 'Basic ' . base64_encode($connection['username'] . ':' . $secrets['password']); break;
            case 'bearer': $headers['Authorization'] = 'Bearer ' . $secrets['token']; break;
            case 'api_key': $headers[$connection['apiKeyHeader']] = $secrets['apiKey']; break;
            case 'oauth2':
                $token = $this->http->request($connection['tokenUrl'], 'POST', ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'application/json'],
                    http_build_query(['grant_type' => 'client_credentials', 'client_id' => $connection['clientId'], 'client_secret' => $secrets['clientSecret'], 'scope' => $connection['scope']], '', '&', PHP_QUERY_RFC3986),
                    min(20, $connection['timeout']), $connection['caCertificate'], $cancelled);
                self::status($token['status']);
                try { $oauth = json_decode($token['body'], true, 16, JSON_THROW_ON_ERROR); }
                catch (\JsonException) { throw new \RuntimeException('CDR_OAUTH_FAILED'); }
                if (!is_array($oauth) || !is_string($oauth['access_token'] ?? null) || $oauth['access_token'] === '' || strlen($oauth['access_token']) > 8192
                    || preg_match('/[\x00-\x20\x7f]/', $oauth['access_token']) || strtolower((string) ($oauth['token_type'] ?? '')) !== 'bearer') { throw new \RuntimeException('CDR_OAUTH_FAILED'); }
                $secrets['accessToken'] = $oauth['access_token'];
                $headers['Authorization'] = 'Bearer ' . $oauth['access_token'];
        }
        $reply = $this->http->request($url, $method, $headers, $body, $connection['timeout'], $connection['caCertificate'], $cancelled);
        // Never forward a remote body that reflects a credential (including successful error-like responses).
        $reflectionSurface = $reply['body'] . json_encode($reply['headers'], JSON_THROW_ON_ERROR) . $reply['content_type'];
        foreach (array_merge(array_values($secrets), array_values($connection['headers']), isset($headers['Authorization']) ? [$headers['Authorization']] : []) as $secret) {
            if ($secret !== '' && (str_contains($reflectionSurface, $secret)
                || str_contains($reflectionSurface, substr(json_encode($secret, JSON_THROW_ON_ERROR), 1, -1)))) { throw new \RuntimeException('CDR_UNSAFE_RESPONSE'); }
        }
        return $reply;
    }

    private static function status(int $status): void
    {
        if ($status >= 200 && $status < 300) { return; }
        throw new \RuntimeException(match ($status) {
            301, 302, 303, 307, 308 => 'CDR_REDIRECT_REFUSED',
            400, 422 => 'CDR_QUERY_REJECTED', 401 => 'CDR_AUTHENTICATION_FAILED', 403 => 'CDR_FORBIDDEN',
            404, 405, 406, 415, 501 => 'CDR_API_UNSUPPORTED', 408, 504 => 'CDR_TIMEOUT', 429 => 'CDR_RATE_LIMITED',
            default => $status >= 500 ? 'CDR_SERVER_ERROR' : 'CDR_UNEXPECTED_STATUS',
        });
    }
}
