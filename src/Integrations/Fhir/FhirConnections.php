<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Fhir;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Fhir\ProjectConfiguration;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;

/** Administrator-managed named destinations. Tool inputs cannot introduce an outbound URL or secret. */
class FhirConnections
{
    public const array DEFINITION_TYPES = ['StructureDefinition', 'ValueSet', 'CodeSystem', 'ConceptMap', 'ImplementationGuide', 'SearchParameter', 'OperationDefinition', 'CapabilityStatement', 'StructureMap', 'NamingSystem'];
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
     * @param array<string, mixed> $query
     * @return array<string, mixed> */
    public function request(string $id, string $type, string $method, string $path, ?array $body = null, array $query = [], bool $original = false): array
    {
        $entry = $this->get($id, $type);
        if (!str_starts_with($path, '/') || str_contains($path, '..') || str_contains($path, '?') || str_contains($path, '#')) {
            throw new \InvalidArgumentException('FHIR_REQUEST_PATH_INVALID');
        }
        foreach ($query as $key => $value) {
            if (!in_array($key, ['url', 'version', 'name', '_count'], true) || (!is_string($value) && !is_int($value)) || strlen((string) $value) > 1000
                || preg_match('/[\x00-\x1f\x7f]/', (string) $value)) { throw new \InvalidArgumentException('FHIR_DEFINITION_QUERY_INVALID'); }
        }
        $url = rtrim($entry['baseUrl'], '/') . $path . ($query === [] ? '' : '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986));
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
        $response = $this->http->request($url, $method, $headers,
            $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR), 120, '', static fn (): bool => false);
        if ($response['status'] < 200 || $response['status'] >= 300) {
            throw new \RuntimeException(match ($response['status']) { 401, 403 => 'FHIR_CONNECTION_PERMISSION_DENIED', 409 => 'FHIR_REMOTE_CONFLICT', default => 'FHIR_REMOTE_REQUEST_FAILED' });
        }
        $result = json_decode($response['body'], true, 80, JSON_THROW_ON_ERROR);
        if (!is_array($result)) { throw new \RuntimeException('FHIR_REMOTE_RESPONSE_INVALID'); }
        if ($original) { return ['resource' => $result, 'content' => $response['body'], 'sourceUrl' => $url, 'sha256' => hash('sha256', $response['body'])]; }
        return array_is_list($result) ? ['items' => $result, 'total' => count($result)] : $result;
    }

    /** Browse definition resources only; never follow server-provided pagination URLs.
     * @param array<string, mixed> $args
     * @return array<string, mixed> */
    public function definitions(string $id, string $action, array $args): array
    {
        $entry = $this->get($id);
        if (!in_array($entry['type'], ['runtime', 'terminology'], true)) { throw new \DomainException('FHIR_DEFINITION_CONNECTION_REQUIRED'); }
        $type = $args['resourceType'] ?? null;
        if (!is_string($type) || !in_array($type, self::DEFINITION_TYPES, true)) { throw new \DomainException('FHIR_DEFINITION_TYPE_REQUIRED'); }
        if ($action === 'read') {
            $resourceId = $args['resourceId'] ?? null;
            if (!is_string($resourceId) || !preg_match('/^[A-Za-z0-9.-]{1,64}$/D', $resourceId)) { throw new \InvalidArgumentException('FHIR_DEFINITION_ID_INVALID'); }
            $result = $this->request($id, $entry['type'], 'GET', '/' . $type . '/' . $resourceId, null, [], true);
            if (strlen($result['content']) > 2097152 || ($result['resource']['resourceType'] ?? '') !== $type) { throw new \DomainException('FHIR_DEFINITION_RESPONSE_INVALID'); }
            return ['kind' => 'resource', 'identity' => array_intersect_key($result['resource'], array_flip(['resourceType', 'id', 'url', 'version', 'name', 'title', 'fhirVersion'])),
                'provenance' => ['connectionId' => $id, 'sourceUrl' => $result['sourceUrl'], 'sha256' => $result['sha256'], 'retrievedAt' => gmdate(DATE_ATOM), 'clinicalApproval' => false]] + $result;
        }
        if ($action !== 'search') { throw new \InvalidArgumentException('FHIR_DEFINITION_OPERATION_UNSUPPORTED'); }
        $query = ['_count' => 50];
        foreach (['url', 'version', 'name'] as $key) { if (isset($args[$key])) { $query[$key] = $args[$key]; } }
        $bundle = $this->request($id, $entry['type'], 'GET', '/' . $type, null, $query);
        if (($bundle['resourceType'] ?? '') !== 'Bundle' || ($bundle['type'] ?? '') !== 'searchset') { throw new \DomainException('FHIR_DEFINITION_RESPONSE_INVALID'); }
        $items = [];
        foreach ($bundle['entry'] ?? [] as $item) {
            $resource = $item['resource'] ?? [];
            if (($resource['resourceType'] ?? '') !== $type) { throw new \DomainException('FHIR_DEFINITION_RESPONSE_INVALID'); }
            $items[] = array_intersect_key($resource, array_flip(['resourceType', 'id', 'url', 'version', 'name', 'title', 'fhirVersion', 'baseDefinition']));
        }
        if (count($items) > 50) { throw new \DomainException('FHIR_DEFINITION_PAGE_TOO_LARGE'); }
        return ['items' => $items, 'returned' => count($items), 'total' => $bundle['total'] ?? null,
            'hasMore' => array_filter($bundle['link'] ?? [], static fn (array $link): bool => ($link['relation'] ?? '') === 'next') !== [],
            'connectionId' => $id, 'resourceType' => $type, 'note' => 'Refine canonical, name or version to narrow results; external pagination links are not followed.'];
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
        $token = is_array($result) ? ($result['accessToken'] ?? null) : null;
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
