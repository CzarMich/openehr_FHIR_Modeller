<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;

// Read-only live acceptance. Credentials and dataset identifiers are environment configuration.
try {
    $provider = new FhirTerminologyProvider(Settings::fromEnvironment());
    $system = getenv('SMOKE_TERMINOLOGY_SYSTEM') ?: '';
    $code = getenv('SMOKE_TERMINOLOGY_CODE') ?: '';
    if ($system === '' || $code === '') { throw new RuntimeException('A test system and code are required.'); }
    $version = getenv('SMOKE_TERMINOLOGY_VERSION') ?: null;
    $checks = []; $failed = false;
    $record = static function (string $name, array $result, bool $required = true) use (&$checks, &$failed): void {
        $passed = ($result['status'] ?? '') === 'VALIDATED' && ($result['valid'] ?? true) !== false;
        $checks[] = ['check' => $name, 'status' => $passed ? 'PASS' : ($required ? 'FAIL' : 'NOT_EXECUTED'),
            'errors' => $result['errors'] ?? [], 'version_confirmed' => $result['version_confirmed'] ?? null,
            'warnings' => $result['warnings'] ?? [], 'item_count' => isset($result['items']) ? count($result['items']) : null];
        $failed = $failed || ($required && !$passed);
    };
    $record('capability statement', $provider->capabilities());
    $record('code lookup', $provider->lookup($system, $code, $version));
    $record('code-system validation', $provider->validateCode($system, $code, null, $version));
    foreach (['CodeSystem', 'ValueSet', 'ConceptMap'] as $type) { $record($type . ' discovery', $provider->search($type, count: 2), false); }
    $set = getenv('SMOKE_VALUE_SET') ?: null;
    if ($set !== null) {
        $setVersion = getenv('SMOKE_VALUE_SET_VERSION') ?: null;
        $expansion = $provider->expand($set, $setVersion, 2);
        $record('value-set expansion', $expansion);
        $members = $expansion['result']['expansion']['contains'] ?? [];
        $member = $members[0] ?? null;
        if (is_array($member) && is_string($member['system'] ?? null) && is_string($member['code'] ?? null)) {
            $record('returned expansion member validation', $provider->validateCode($member['system'], $member['code'], $set, $setVersion, $member['version'] ?? null));
        } else { $record('returned expansion member validation', ['status' => 'NOT_EXECUTED', 'errors' => ['NO_TESTABLE_EXPANSION_MEMBER']]); }
    }
    $map = getenv('SMOKE_CONCEPT_MAP') ?: null;
    if ($map !== null) { $record('concept-map translation', $provider->translate($map, $system, $code, getenv('SMOKE_CONCEPT_MAP_VERSION') ?: null, $version)); }
    echo json_encode(['status' => $failed ? 'FAIL' : 'PASS', 'scope' => 'read-only configured terminology server acceptance',
        'timestamp' => gmdate(DATE_ATOM), 'checks' => $checks, 'live_translation_executed' => $map !== null,
        'live_value_set_executed' => $set !== null], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
    exit($failed ? 1 : 0);
} catch (Throwable) {
    fwrite(STDERR, "Terminology acceptance could not complete. Verify test identifiers, configured endpoint and credentials. No secrets are included in this report.\n");
    exit(1);
}
