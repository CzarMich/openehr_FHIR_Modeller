<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Terminology;

use GuzzleHttp\Client;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Terminology\TerminologyProvider;

/** FHIR is an adapter format. No FHIR resource classes enter the modelling domain. */
final readonly class FhirTerminologyProvider implements TerminologyProvider, \OpenEHR\Assistant\Domain\Terminology\MappingProvider
{
    private ?Client $client;
    private string $endpoint;
    private string $codeSystemParameter;
    private int $maxBytes;
    /** @var array<string, string> */
    private array $headers;

    public function __construct(Settings $settings, ?Client $client = null)
    {
        $this->endpoint = $settings->get('TERMINOLOGY_FHIR_BASE_URL');
        $this->codeSystemParameter = $settings->get('TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER');
        $this->maxBytes = (int) $settings->get('MAX_UPSTREAM_BYTES');
        $headers = ['Accept' => 'application/fhir+json'];
        if ($settings->get('TERMINOLOGY_API_KEY') !== '') {
            $headers[$settings->get('TERMINOLOGY_API_KEY_HEADER')] = $settings->get('TERMINOLOGY_API_KEY');
        }
        $this->headers = $headers;
        $this->client = $client ?? ($this->endpoint === '' ? null : HttpClientFactory::create(
            $this->endpoint, (int) $settings->get('HTTP_TIMEOUT'), $settings, $settings->get('TERMINOLOGY_BEARER_TOKEN')));
    }

    public function lookup(string $system, string $code, ?string $version = null, ?string $language = null): array
    {
        return $this->operation('CodeSystem/$lookup', ['system' => $system, 'code' => $code, 'version' => $version,
            'displayLanguage' => $language], 'lookup');
    }

    public function validateCode(string $system, string $code, ?string $valueSet = null, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array
    {
        $parameters = ['system' => $system, 'code' => $code, 'display' => $display, 'displayLanguage' => $language];
        if ($valueSet !== null) {
            $parameters['url'] = $valueSet;
            $parameters['valueSetVersion'] = $version;
            $parameters['systemVersion'] = $codeSystemVersion;
        } else {
            if ($version !== null && $codeSystemVersion !== null && $version !== $codeSystemVersion) {
                throw new \InvalidArgumentException('Conflicting code-system versions.');
            }
            unset($parameters['system']);
            $parameters[$this->codeSystemParameter] = $system;
            $parameters['version'] = $version ?? $codeSystemVersion;
        }
        return $this->operation(($valueSet === null ? 'CodeSystem' : 'ValueSet') . '/$validate-code', $parameters,
            $valueSet === null ? 'validate-system' : 'validate-set');
    }

    public function expand(string $valueSet, ?string $version = null, int $count = 50, int $offset = 0,
        ?string $language = null, ?string $filter = null): array
    {
        self::page($count, $offset);
        return $this->operation('ValueSet/$expand', ['url' => $valueSet, 'valueSetVersion' => $version,
            'count' => $count, 'offset' => $offset, 'displayLanguage' => $language, 'filter' => $filter,
            'includeDesignations' => 'true', 'excludeNested' => 'true'], 'expand');
    }

    /** All matches remain proposals requiring human review, including equivalent matches.
     * @return array<string, mixed> */
    public function translate(string $conceptMap, string $system, string $code, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $sourceValueSet = null, ?string $targetValueSet = null,
        ?string $targetSystem = null): array
    {
        return $this->operation('ConceptMap/$translate', ['url' => $conceptMap, 'conceptMapVersion' => $version,
            'system' => $system, 'code' => $code, 'version' => $codeSystemVersion, 'source' => $sourceValueSet,
            'target' => $targetValueSet, 'targetsystem' => $targetSystem], 'translate');
    }

    /** Search only the configured server. Canonicals are identifiers, never fetched URLs.
     * @return array<string, mixed> */
    public function search(string $resourceType, ?string $canonical = null, ?string $version = null,
        ?string $name = null, int $count = 50): array
    {
        self::resourceType($resourceType);
        if ($count < 1 || $count > 100) {
            throw new \InvalidArgumentException('Terminology search count must be between 1 and 100.');
        }
        return $this->operation($resourceType, ['url' => $canonical, 'version' => $version, 'name' => $name, '_count' => $count], 'search');
    }

    /** Resolve an exact canonical/version without silently selecting another version.
     * @return array<string, mixed> */
    public function resource(string $resourceType, string $canonical, ?string $version = null): array
    {
        $result = $this->search($resourceType, $canonical, $version, null, 2);
        if ($result['status'] !== 'VALIDATED') {
            return $result;
        }
        $items = $result['items'];
        if (count($items) === 0 && $result['complete']) {
            return $this->failure('TERMINOLOGY_RESOURCE_NOT_FOUND', $result['provenance']);
        }
        if (count($items) !== 1 || !$result['complete']) {
            return $this->failure('TERMINOLOGY_RESOURCE_AMBIGUOUS_OR_INCOMPLETE', $result['provenance']);
        }
        return ['status' => 'VALIDATED', 'valid' => null, 'result' => $items[0],
            'requested_version' => $version, 'returned_version' => $items[0]['version'] ?? null,
            'version_confirmed' => $version !== null && ($items[0]['version'] ?? null) === $version,
            'provenance' => $result['provenance'], 'errors' => [], 'warnings' => []];
    }

    /** @return array<string, mixed> */
    public function capabilities(): array
    {
        return $this->operation('metadata', [], 'metadata');
    }

    /** @param array<string, string|int|null> $parameters
     * @return array<string, mixed> */
    private function operation(string $path, array $parameters, string $kind): array
    {
        $provenance = ['provider' => 'fhir', 'endpoint' => $this->endpoint, 'operation' => $path, 'timestamp' => gmdate(DATE_ATOM)];
        foreach ($parameters as $key => $value) {
            if ($value !== null && (strlen((string) $value) > 2048 || (string) $value === '' || preg_match('/[\x00-\x1f\x7f]/', (string) $value))) {
                throw new \InvalidArgumentException('Invalid terminology parameter: ' . $key);
            }
        }
        if ($this->client === null) {
            return $this->failure('TERMINOLOGY_NOT_CONFIGURED', $provenance);
        }
        try {
            $response = $this->client->request('GET', $path, ['headers' => $this->headers,
                'allow_redirects' => false, 'cookies' => false, 'http_errors' => false,
                'query' => array_filter($parameters, static fn ($value): bool => $value !== null)]);
            if ($response->getStatusCode() !== 200) {
                return $this->failure('TERMINOLOGY_HTTP_' . $response->getStatusCode(), $provenance);
            }
            $body = \GuzzleHttp\Psr7\Utils::copyToString($response->getBody(), $this->maxBytes + 1);
            if (strlen($body) > $this->maxBytes || !$response->getBody()->eof()) {
                return $this->failure('TERMINOLOGY_RESPONSE_TOO_LARGE', $provenance);
            }
            $data = json_decode($body, true, 64, JSON_THROW_ON_ERROR);
            $expected = match ($kind) { 'expand' => 'ValueSet', 'metadata' => 'CapabilityStatement', 'search' => 'Bundle', default => 'Parameters' };
            if (!is_array($data) || ($data['resourceType'] ?? '') !== $expected) {
                return $this->failure('TERMINOLOGY_INVALID_RESPONSE', $provenance);
            }
            if ($kind === 'search') {
                return $this->searchResult($path, $parameters, $data, $provenance);
            }
            $parsed = new FhirParameters($data);
            $values = $parsed->values();
            $validate = in_array($kind, ['validate-system', 'validate-set'], true);
            $valid = $validate || $kind === 'translate' ? $parsed->one('result', 'Boolean') : null;
            if (($validate || $kind === 'translate') && !is_bool($valid)) {
                return $this->failure('TERMINOLOGY_MISSING_RESULT', $provenance);
            }
            if ($kind === 'lookup' && !is_string($parsed->one('display', 'String'))) {
                return $this->failure('TERMINOLOGY_MISSING_DISPLAY', $provenance);
            }
            $versions = match ($kind) {
                'expand' => ['value_set' => [$parameters['valueSetVersion'] ?? null, $data['version'] ?? null]],
                'validate-set' => ['value_set' => [$parameters['valueSetVersion'] ?? null, $parsed->one('valueSetVersion', 'String')],
                    'code_system' => [$parameters['systemVersion'] ?? null, $parsed->one('systemVersion', 'String')]],
                'translate' => ['concept_map' => [$parameters['conceptMapVersion'] ?? null, $parsed->one('conceptMapVersion', 'String')],
                    'code_system' => [$parameters['version'] ?? null, $parsed->one('systemVersion', 'String')]],
                default => ['code_system' => [$parameters['version'] ?? null, $parsed->one('version', 'String')]],
            };
            $versionEvidence = []; $warnings = [];
            foreach ($versions as $name => [$requested, $returned]) {
                if ($returned !== null && !is_string($returned)) {
                    throw new \UnexpectedValueException('Invalid returned terminology version.');
                }
                if ($requested !== null && $returned !== null && $requested !== $returned) {
                    return $this->failure('TERMINOLOGY_VERSION_MISMATCH', $provenance);
                }
                $versionEvidence[$name] = ['requested' => $requested, 'returned' => $returned,
                    'confirmed' => $requested !== null && $requested === $returned];
                if ($requested !== null && $returned === null) {
                    $warnings[] = 'Provider did not confirm the requested ' . $name . ' version.';
                }
            }
            $first = reset($versionEvidence);
            $result = ['status' => 'VALIDATED', 'valid' => $validate ? $valid : null,
                'result' => in_array($kind, ['lookup', 'validate-system', 'validate-set', 'translate'], true) ? $values : $data,
                'parameters' => $parsed->parameters, 'versions' => $versionEvidence,
                'requested_version' => $first['requested'], 'returned_version' => $first['returned'], 'version_confirmed' => $first['confirmed'],
                'provenance' => $provenance, 'errors' => [], 'warnings' => $warnings];
            if ($kind === 'expand') {
                if (isset($data['url']) && $data['url'] !== $parameters['url']) {
                    return $this->failure('TERMINOLOGY_CANONICAL_MISMATCH', $provenance);
                }
                $result['page'] = FhirExpansion::inspect($data, (int) ($parameters['offset'] ?? 0), (int) ($parameters['count'] ?? 50));
                $result['page']['filtered'] = isset($parameters['filter']);
                $result['page']['scope'] = isset($parameters['filter']) ? 'filtered_expansion' : 'expansion';
            }
            if ($kind === 'translate') {
                $result += FhirTranslation::inspect($parsed, $valid === true, $parameters);
            }
            return $result;
        } catch (\UnexpectedValueException|\JsonException) {
            return $this->failure('TERMINOLOGY_INVALID_RESPONSE', $provenance);
        } catch (\GuzzleHttp\Exception\GuzzleException|\RuntimeException) {
            return $this->failure('TERMINOLOGY_UNAVAILABLE_OR_INVALID', $provenance);
        }
    }

    /** @param array<string, string|int|null> $parameters
     * @param array<string, mixed> $data
     * @param array<string, mixed> $provenance
     * @return array<string, mixed> */
    private function searchResult(string $type, array $parameters, array $data, array $provenance): array
    {
        if (($data['type'] ?? '') !== 'searchset' || !is_array($data['entry'] ?? []) || !array_is_list($data['entry'] ?? [])) {
            throw new \UnexpectedValueException('Invalid search bundle.');
        }
        $items = [];
        foreach ($data['entry'] ?? [] as $entry) {
            if (!is_array($entry)) {
                throw new \UnexpectedValueException('Invalid search entry.');
            }
            $mode = $entry['search']['mode'] ?? 'match';
            if ($mode === 'include') {
                continue;
            }
            if ($mode !== 'match') {
                throw new \UnexpectedValueException('Search did not return deterministic matches.');
            }
            $resource = $entry['resource'] ?? null;
            if (!is_array($resource) || ($resource['resourceType'] ?? '') !== $type || !is_string($resource['url'] ?? null)) {
                throw new \UnexpectedValueException('Invalid terminology search match.');
            }
            if (isset($parameters['url']) && $resource['url'] !== $parameters['url']) {
                return $this->failure('TERMINOLOGY_CANONICAL_MISMATCH', $provenance);
            }
            if (isset($parameters['version']) && ($resource['version'] ?? null) !== $parameters['version']) {
                return $this->failure('TERMINOLOGY_VERSION_MISMATCH', $provenance);
            }
            $items[] = $resource;
        }
        if (count($items) > (int) $parameters['_count']) {
            throw new \UnexpectedValueException('Search exceeded requested limit.');
        }
        $next = false;
        if (!is_array($data['link'] ?? []) || !array_is_list($data['link'] ?? [])) {
            throw new \UnexpectedValueException('Invalid search links.');
        }
        foreach ($data['link'] ?? [] as $link) {
            if (is_array($link) && ($link['relation'] ?? '') === 'next') {
                $next = true;
            }
        }
        $total = $data['total'] ?? null;
        if ($total !== null && (!is_int($total) || $total < count($items))) {
            throw new \UnexpectedValueException('Invalid search total.');
        }
        return ['status' => 'VALIDATED', 'valid' => null, 'items' => $items, 'total' => $total,
            'complete' => !$next && $total !== null && $total === count($items), 'has_next_page' => $next,
            'provenance' => $provenance, 'errors' => [], 'warnings' => $next ? ['Additional search results were not fetched.'] : []];
    }

    private static function resourceType(string $type): void
    {
        if (!in_array($type, ['CodeSystem', 'ValueSet', 'ConceptMap'], true)) {
            throw new \InvalidArgumentException('Unsupported terminology resource type.');
        }
    }

    private static function page(int $count, int $offset): void
    {
        if ($count < 0 || $count > 500 || $offset < 0 || $offset > 1000000) {
            throw new \InvalidArgumentException('Invalid terminology expansion page.');
        }
    }

    /** @param array<string, mixed> $provenance
     * @return array<string, mixed> */
    private function failure(string $code, array $provenance): array
    {
        return ['status' => 'NOT_EXECUTED', 'valid' => null, 'errors' => [$code],
            'message' => 'TERMINOLOGY OPERATION NOT EXECUTED', 'provenance' => $provenance];
    }
}
