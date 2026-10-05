<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

/** Validates configuration at its trust boundary; public summaries contain no credential material. */
final readonly class CdrConnection
{
    public function __construct(private CdrHttp $http) {}

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $previous
     * @return array<string, mixed> */
    public function validate(array $input, array $previous = [], bool $administrator = false): array
    {
        $keys = ['id', 'name', 'vendor', 'baseUrl', 'apiUrl', 'queryUrl', 'auth', 'username', 'apiKeyHeader', 'tokenUrl', 'clientId', 'scope', 'tenant', 'tenantHeader', 'headers', 'caCertificate', 'timeout', 'enabled', 'secrets'];
        if ($administrator) { $keys[] = 'secretRefs'; }
        if ($administrator && !empty($input['secrets'])) { throw new \InvalidArgumentException('CDR_ADMIN_SECRET_REFERENCE_REQUIRED'); }
        if (array_diff(array_keys($input), $keys) !== []) { throw new \InvalidArgumentException('CDR_INVALID_CONNECTION'); }
        $result = [];
        foreach (['name' => 100, 'vendor' => 100, 'baseUrl' => 1000, 'apiUrl' => 1000, 'queryUrl' => 1000, 'username' => 200,
            'apiKeyHeader' => 80, 'tokenUrl' => 1000, 'clientId' => 300, 'scope' => 1000, 'tenant' => 300, 'tenantHeader' => 80] as $key => $maximum) {
            $value = $input[$key] ?? $previous[$key] ?? '';
            if (!is_string($value) || strlen($value) > $maximum || preg_match('/[\x00-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('CDR_INVALID_CONNECTION'); }
            $result[$key] = trim($value);
        }
        if ($result['name'] === '') { throw new \InvalidArgumentException('CDR_NAME_REQUIRED'); }
        $result['id'] = $previous['id'] ?? $input['id'] ?? bin2hex(random_bytes(16));
        if (!is_string($result['id']) || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/D', $result['id'])) { throw new \InvalidArgumentException('CDR_INVALID_CONNECTION'); }
        $result['adapter'] = 'openehr_rest';
        $result['auth'] = $input['auth'] ?? $previous['auth'] ?? 'none';
        if (!in_array($result['auth'], ['none', 'basic', 'bearer', 'api_key', 'oauth2'], true)) { throw new \InvalidArgumentException('CDR_AUTH_UNSUPPORTED'); }
        $result['apiUrl'] = rtrim($result['apiUrl'] ?: rtrim($result['baseUrl'], '/') . '/openehr/v1', '/');
        $result['queryUrl'] = $result['queryUrl'] ?: $result['apiUrl'] . '/query/aql';
        $base = $this->http->validateUrl($result['baseUrl']);
        foreach (['apiUrl', 'queryUrl'] as $key) {
            if ($this->http->validateUrl($result[$key]) !== $base) { throw new \InvalidArgumentException('CDR_ENDPOINT_ORIGIN_MISMATCH'); }
        }
        if ($result['auth'] === 'oauth2') {
            $this->http->validateUrl($result['tokenUrl']);
            if ($result['clientId'] === '') { throw new \InvalidArgumentException('CDR_CLIENT_ID_REQUIRED'); }
        }
        $result['timeout'] = $input['timeout'] ?? $previous['timeout'] ?? 60;
        $result['enabled'] = $input['enabled'] ?? $previous['enabled'] ?? true;
        if (!is_int($result['timeout']) || $result['timeout'] < 1 || $result['timeout'] > 120 || !is_bool($result['enabled'])) { throw new \InvalidArgumentException('CDR_INVALID_CONNECTION'); }
        $result['caCertificate'] = $input['caCertificate'] ?? $previous['caCertificate'] ?? '';
        if (!is_string($result['caCertificate']) || strlen($result['caCertificate']) > 32768 || ($result['caCertificate'] !== '' && !openssl_x509_read($result['caCertificate']))) { throw new \InvalidArgumentException('CDR_INVALID_CA'); }
        $result['secrets'] = $previous['secrets'] ?? [];
        if (isset($input['secrets'])) {
            if (!is_array($input['secrets']) || array_diff(array_keys($input['secrets']), ['password', 'token', 'apiKey', 'clientSecret']) !== []) { throw new \InvalidArgumentException('CDR_INVALID_CREDENTIAL'); }
            foreach ($input['secrets'] as $key => $value) {
                if (!is_string($value) || strlen($value) > 8192 || preg_match('/[\x00-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('CDR_INVALID_CREDENTIAL'); }
                // A blank password field preserves the stored credential when editing.
                if ($value !== '') { $result['secrets'][$key] = $value; }
            }
        }
        $result['secretRefs'] = $administrator ? ($input['secretRefs'] ?? []) : [];
        if (!is_array($result['secretRefs'])) { throw new \InvalidArgumentException('CDR_INVALID_CREDENTIAL'); }
        foreach ($result['secretRefs'] as $key => $reference) {
            if (!in_array($key, ['password', 'token', 'apiKey', 'clientSecret'], true) || !is_string($reference) || !preg_match('/^env:CDR_SECRET_[A-Z0-9_]+$/D', $reference)) { throw new \InvalidArgumentException('CDR_INVALID_CREDENTIAL'); }
        }
        $required = match ($result['auth']) { 'basic' => 'password', 'bearer' => 'token', 'api_key' => 'apiKey', 'oauth2' => 'clientSecret', default => null };
        if ($required !== null && empty($result['secrets'][$required]) && empty($result['secretRefs'][$required])) { throw new \InvalidArgumentException('CDR_CREDENTIAL_REQUIRED'); }
        if ($result['auth'] === 'basic' && ($result['username'] === '' || str_contains($result['username'], ':'))) { throw new \InvalidArgumentException('CDR_USERNAME_REQUIRED'); }
        $result['headers'] = $input['headers'] ?? $previous['headers'] ?? [];
        if (!is_array($result['headers']) || count($result['headers']) > 10) { throw new \InvalidArgumentException('CDR_INVALID_HEADER'); }
        foreach ($result['headers'] as $key => $value) {
            self::header($key);
            if (!is_string($value) || strlen($value) > 8192 || preg_match('/[\x00-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('CDR_INVALID_HEADER'); }
        }
        if ($result['auth'] === 'api_key') { self::header($result['apiKeyHeader']); }
        if ($result['tenant'] !== '') { self::header($result['tenantHeader']); }
        return $result;
    }

    private static function header(mixed $name): void
    {
        if (!is_string($name) || !preg_match('/^[A-Za-z][A-Za-z0-9-]{0,79}$/D', $name)
            || in_array(strtolower($name), ['authorization', 'proxy-authorization', 'host', 'cookie', 'connection', 'content-type', 'content-length', 'transfer-encoding', 'accept', 'expect', 'trailer', 'upgrade'], true)) {
            throw new \InvalidArgumentException('CDR_INVALID_HEADER');
        }
    }

    /**
     * @param array<string, mixed> $connection
     * @return array<string, mixed> */
    public static function summary(array $connection): array
    {
        $safe = array_intersect_key($connection, array_flip(['id', 'name', 'vendor', 'baseUrl', 'apiUrl', 'queryUrl', 'auth', 'timeout', 'enabled', 'username', 'apiKeyHeader', 'tokenUrl', 'clientId', 'scope', 'tenant', 'tenantHeader']));
        $safe['hasCredentials'] = ($connection['secrets'] ?? []) !== [] || ($connection['secretRefs'] ?? []) !== [];
        $safe['headerNames'] = array_keys($connection['headers'] ?? []);
        $safe['hasCustomCa'] = ($connection['caCertificate'] ?? '') !== '';
        $safe['readOnly'] = ($connection['source'] ?? '') === 'administrator';
        return $safe;
    }
}
