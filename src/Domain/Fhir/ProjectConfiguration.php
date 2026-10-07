<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Fhir;

final class ProjectConfiguration
{
    public const array RELEASES = ['R4' => '4.0.1', 'R4B' => '4.3.0', 'R5' => '5.0.0'];

    /** @param array<string, mixed> $input
     * @return array<string, mixed> */
    public static function validate(array $input): array
    {
        self::noSecrets($input);
        foreach (['name', 'fhirVersion', 'canonical', 'packageId', 'version', 'publisher'] as $key) {
            if (!is_string($input[$key] ?? null) || trim($input[$key]) === '' || strlen($input[$key]) > 1000) {
                throw new \InvalidArgumentException('FHIR_PROJECT_FIELD_REQUIRED');
            }
        }
        $input['fhirVersion'] = self::RELEASES[$input['fhirVersion']] ?? $input['fhirVersion'];
        if (strlen($input['name']) > 200) { throw new \InvalidArgumentException('FHIR_PROJECT_NAME_TOO_LONG'); }
        if (!in_array($input['fhirVersion'], self::RELEASES, true)) { throw new \InvalidArgumentException('FHIR_RELEASE_UNSUPPORTED'); }
        self::url($input['canonical']);
        $input['canonical'] = rtrim($input['canonical'], '/');
        if (!preg_match('/^[a-z][a-z0-9.-]{2,150}$/D', $input['packageId']) || !self::exactVersion($input['version'])) {
            throw new \InvalidArgumentException('FHIR_PACKAGE_ID_OR_VERSION_INVALID');
        }
        $input += ['sourceFormat' => 'fsh', 'language' => 'en', 'jurisdiction' => '', 'clinicalProjectId' => null,
            'dependencies' => [], 'sources' => [], 'repository' => [], 'connections' => [], 'policy' => []];
        if (!in_array($input['sourceFormat'], ['fsh', 'json'], true)) { throw new \InvalidArgumentException('FHIR_SOURCE_FORMAT_INVALID'); }
        foreach (['dependencies', 'sources', 'repository', 'connections', 'policy'] as $key) {
            if (!is_array($input[$key]) || count($input[$key]) > 100) { throw new \InvalidArgumentException('FHIR_PROJECT_CONFIGURATION_INVALID'); }
        }
        $versions = [];
        foreach ($input['dependencies'] as $dependency) {
            if (!is_array($dependency) || !is_string($dependency['id'] ?? null) || !preg_match('/^[a-z][a-z0-9.-]{2,150}$/D', $dependency['id'])
                || !is_string($dependency['version'] ?? null) || !self::exactVersion($dependency['version'])) {
                throw new \InvalidArgumentException('FHIR_EXACT_DEPENDENCY_REQUIRED');
            }
            if (isset($versions[$dependency['id']]) && $versions[$dependency['id']] !== $dependency['version']) {
                throw new \InvalidArgumentException('FHIR_DEPENDENCY_CONFLICT');
            }
            $versions[$dependency['id']] = $dependency['version'];
            if (preg_match('/^hl7\.fhir\.(r4|r4b|r5)\.core$/D', $dependency['id'], $match)) {
                if (self::RELEASES[strtoupper($match[1])] !== $input['fhirVersion'] || $dependency['version'] !== $input['fhirVersion']) {
                    throw new \InvalidArgumentException('FHIR_DEPENDENCY_RELEASE_MISMATCH');
                }
            }
        }
        foreach ($input['sources'] as $source) {
            if (!is_array($source) || !is_string($source['id'] ?? null) || !is_string($source['url'] ?? null)) {
                throw new \InvalidArgumentException('FHIR_SOURCE_INVALID');
            }
            self::url($source['url']);
        }
        if (isset($input['repository']['url'])) { self::url($input['repository']['url']); }
        foreach (['ig', 'runtime', 'terminology'] as $kind) {
            if (isset($input['connections'][$kind]) && (!is_string($input['connections'][$kind]) || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $input['connections'][$kind]))) {
                throw new \InvalidArgumentException('FHIR_CONNECTION_REFERENCE_INVALID');
            }
        }
        $input['standard'] = 'FHIR';
        $input['policy']['publication'] = 'manual-review-required';
        $input['policy']['reuseFirst'] = true;
        return $input;
    }

    public static function exactVersion(string $version): bool
    {
        return preg_match('/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/D', $version) === 1;
    }

    public static function url(mixed $url): void
    {
        $parts = is_string($url) ? parse_url($url) : false;
        if (!is_array($parts) || !in_array($parts['scheme'] ?? '', ['https', 'http'], true) || empty($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || strlen($url) > 1000 || preg_match('/[\x00-\x20\x7f]/', $url)) { throw new \InvalidArgumentException('FHIR_URL_INVALID'); }
    }

    /** @param array<mixed> $input */
    public static function noSecrets(array $input): void
    {
        foreach ($input as $key => $value) {
            if (is_string($key) && preg_match('/^(password|token|apiKey|authorization|secret|clientSecret|credentialFile|headers)$/iD', $key)) {
                throw new \InvalidArgumentException('FHIR_SECRET_IN_ARTIFACT_FORBIDDEN');
            }
            if (is_array($value)) { self::noSecrets($value); }
        }
    }
}
