<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Fhir;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Fhir\ProjectConfiguration;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;

/** Administrator-managed named destinations. Tool inputs cannot introduce an outbound URL or secret. */
class FhirConnections
{
    private CdrHttp $http;
    /** @var array<string, string> */
    private array $tokens = [];
    public function __construct(private readonly Settings $settings, ?CdrHttp $http = null)
    {
        $this->http = $http ?? new CdrHttp($settings->with(['CDR_ALLOWED_HOSTS' => $settings->get('FHIR_ALLOWED_HOSTS'),
            'CDR_ALLOW_HTTP' => $settings->get('FHIR_ALLOW_HTTP')]));
    }

    /** @return list<array<string, mixed>> */
    public function summaries(): array
    {
        $result = [];
        foreach ($this->configured() as $id => $entry) {
            $result[] = array_intersect_key($entry, array_flip(['type', 'name', 'baseUrl', 'projectId', 'linkId', 'repository', 'branch', 'rootPath', 'environment']))
                + ['id' => $id, 'hasCredentials' => !empty($entry['credentialFile']) || !empty($entry['loginFile']), 'managedBy' => 'deployment'];
        }
        return $result;
    }

    /** @return array<string, mixed> */
    public function get(string $id, ?string $type = null): array
    {
        $entry = $this->configured()[$id] ?? throw new \RuntimeException('FHIR_CONNECTION_NOT_FOUND');
        if ($type !== null && ($entry['type'] ?? null) !== $type) { throw new \InvalidArgumentException('FHIR_CONNECTION_TYPE_MISMATCH'); }
        return $entry;
    }

    /** @return array<string, mixed> */
    public function test(string $id): array
    {
        $entry = $this->get($id);
        $type = $entry['type'];
        $path = match ($type) { 'ig' => '/api/v1/admin/health', 'git' => '/repos/' . $this->repositoryName($entry), default => '/metadata' };
        $response = $this->request($id, $type, 'GET', $path);
        if (in_array($type, ['runtime', 'terminology'], true) && ($response['resourceType'] ?? null) !== 'CapabilityStatement') {
            throw new \RuntimeException('FHIR_CAPABILITY_STATEMENT_REQUIRED');
        }
        return ['id' => $id, 'type' => $type, 'connected' => true, 'capabilities' => $response, 'timestamp' => gmdate(DATE_ATOM)];
    }

    /** @param array<string, mixed>|null $body
     * @return array<string, mixed> */
    public function request(string $id, string $type, string $method, string $path, ?array $body = null): array
    {
        $entry = $this->get($id, $type);
        if (!str_starts_with($path, '/') || str_contains($path, '..') || str_contains($path, '?') || str_contains($path, '#')) {
            throw new \InvalidArgumentException('FHIR_REQUEST_PATH_INVALID');
        }
        $headers = ['Accept' => 'application/json', 'Content-Type' => 'application/json', 'User-Agent' => 'clinical-modeller-dev'];
        if (!empty($entry['loginFile'])) {
            $headers['Authorization'] = 'Bearer ' . ($this->tokens[$id] ??= $this->login($entry));
        } elseif (!empty($entry['credentialFile'])) {
            $file = $entry['credentialFile'];
            if (!is_string($file) || !str_starts_with($file, '/') || !is_readable($file) || filesize($file) > 8192) { throw new \RuntimeException('FHIR_CREDENTIAL_UNAVAILABLE'); }
            $token = trim((string) file_get_contents($file));
            if ($token === '' || strlen($token) > 8192 || preg_match('/[\x00-\x20\x7f]/', $token)) { throw new \RuntimeException('FHIR_CREDENTIAL_INVALID'); }
            $headers['Authorization'] = 'Bearer ' . $token;
        }
        $response = $this->http->request(rtrim($entry['baseUrl'], '/') . $path, $method, $headers,
            $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR), 120, '', static fn (): bool => false);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            throw new \RuntimeException(match ($response['status']) { 401, 403 => 'FHIR_CONNECTION_PERMISSION_DENIED', 409 => 'FHIR_REMOTE_CONFLICT', default => 'FHIR_REMOTE_REQUEST_FAILED' });
        }
        $result = json_decode($response['body'], true, 80, JSON_THROW_ON_ERROR);
        if (!is_array($result)) { throw new \RuntimeException('FHIR_REMOTE_RESPONSE_INVALID'); }
        return array_is_list($result) ? ['items' => $result, 'total' => count($result)] : $result;
    }

    /** Authenticate against the existing IG login contract; secrets never leave this adapter.
     * @param array<string, mixed> $entry */
    private function login(array $entry): string
    {
        $file = $entry['loginFile'];
        if ($entry['type'] !== 'ig' || !is_string($file) || !str_starts_with($file, '/') || !is_readable($file)
            || filesize($file) > 8192) { throw new \RuntimeException('FHIR_CREDENTIAL_UNAVAILABLE'); }
        try { $login = json_decode((string) file_get_contents($file), true, 4, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { throw new \RuntimeException('FHIR_CREDENTIAL_INVALID'); }
        if (!is_array($login) || !is_string($login['email'] ?? null) || !is_string($login['password'] ?? null)
            || $login['email'] === '' || $login['password'] === '') { throw new \RuntimeException('FHIR_CREDENTIAL_INVALID'); }
        $response = $this->http->request(rtrim($entry['baseUrl'], '/') . '/api/v1/auth/login', 'POST',
            ['Content-Type' => 'application/json', 'Accept' => 'application/json'],
            json_encode(['email' => $login['email'], 'password' => $login['password']], JSON_THROW_ON_ERROR), 15, '', static fn (): bool => false);
        if ($response['status'] !== 200) { throw new \RuntimeException('FHIR_CONNECTION_PERMISSION_DENIED'); }
        try { $result = json_decode($response['body'], true, 8, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { throw new \RuntimeException('FHIR_AUTH_RESPONSE_INVALID'); }
        $token = is_array($result) ? ($result['token'] ?? null) : null;
        if (!is_string($token) || $token === '' || strlen($token) > 8192 || preg_match('/[\x00-\x20\x7f]/', $token)) {
            throw new \RuntimeException('FHIR_AUTH_RESPONSE_INVALID');
        }
        return $token;
    }

    /** @param array<string, mixed> $entry */
    public function repositoryName(array $entry): string
    {
        $name = $entry['repository'] ?? '';
        if (!is_string($name) || !preg_match('~^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$~D', $name)) { throw new \InvalidArgumentException('FHIR_GIT_REPOSITORY_INVALID'); }
        return $name;
    }

    /** @return array<string, array<string, mixed>> */
    private function configured(): array
    {
        $file = $this->settings->get('FHIR_CONNECTIONS_FILE');
        if ($file === '') { return []; }
        if (!is_readable($file) || filesize($file) > 65536) { throw new \RuntimeException('FHIR_CONNECTION_CONFIGURATION_INVALID'); }
        $entries = json_decode((string) file_get_contents($file), true, 20, JSON_THROW_ON_ERROR);
        if (!is_array($entries)) { throw new \RuntimeException('FHIR_CONNECTION_CONFIGURATION_INVALID'); }
        foreach ($entries as $id => $entry) {
            if (!is_string($id) || !is_array($entry) || !in_array($entry['type'] ?? null, ['ig', 'runtime', 'terminology', 'git'], true)) {
                throw new \RuntimeException('FHIR_CONNECTION_CONFIGURATION_INVALID');
            }
            ProjectConfiguration::url($entry['baseUrl'] ?? null);
        }
        return $entries;
    }
}
