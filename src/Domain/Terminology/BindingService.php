<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

use OpenEHR\Assistant\Validation\ModelValidator;

final readonly class BindingService
{
    public function __construct(private TerminologyProvider $external)
    {
    }

    /**
     * @param array<string, mixed> $binding
     * @return array<string, mixed> */
    public function validate(array $binding, ValueSet $valueSet, string $model): array
    {
        foreach (['id', 'artifact', 'node', 'strength', 'value_set', 'value_set_version'] as $key) {
            if (!is_string($binding[$key] ?? null) || $binding[$key] === '') {
                throw new \InvalidArgumentException('Missing binding field: ' . $key);
            }
        }
        if (!in_array($binding['strength'], ['REQUIRED', 'EXTENSIBLE', 'PREFERRED', 'EXAMPLE'], true)) {
            throw new \InvalidArgumentException('Unsupported platform binding policy.');
        }
        $errors = [];
        if ($binding['value_set'] !== $valueSet->id || $binding['value_set_version'] !== $valueSet->version) {
            $errors[] = 'VALUE_SET_REFERENCE_OR_VERSION_MISMATCH';
        }
        $document = ModelValidator::xml($model);
        $targets = [];
        $location = $binding['target_location'] ?? null;
        if ($location !== null && (!is_string($location) || !preg_match('~^/1(?:/[1-9][0-9]*)*$~D', $location))) {
            throw new \InvalidArgumentException('Invalid target element location.');
        }
        foreach (\OpenEHR\Assistant\Validation\XmlLocations::index($document) as $address => $element) {
            if ($element->getAttribute('path') === $binding['node'] && ($location === null || $location === $address)) {
                $targets[] = $address;
            }
        }
        if (count($targets) > 1) { $errors[] = 'BINDING_TARGET_AMBIGUOUS'; }
        if ($targets === []) {
            $errors[] = 'BINDING_TARGET_NOT_EXPLICIT_IN_TEMPLATE';
        }
        $provider = $valueSet->source === 'local' ? new LocalTerminologyProvider($valueSet) : $this->external;
        $results = [];
        $notExecuted = false;
        $codes = $binding['codes'] ?? [];
        if (!is_array($codes) || !array_is_list($codes) || count($codes) > 100) {
            throw new \InvalidArgumentException('Binding codes must be a list of at most 100 codes.');
        }
        if ($codes === [] && $valueSet->source === 'external') {
            $expansion = $provider->expand((string) $valueSet->canonical, $valueSet->version, 1);
            $results[] = $expansion;
            $notExecuted = ($expansion['status'] ?? '') !== 'VALIDATED';
        }
        foreach ($codes as $code) {
            if (!is_string($code) || $code === '') {
                throw new \InvalidArgumentException('Binding codes must be non-empty strings.');
            }
            $result = $provider->validateCode($valueSet->system, $code, $valueSet->canonical ?? $valueSet->id, $valueSet->version, $valueSet->codeSystemVersion);
            $results[] = $result;
            if (($result['status'] ?? '') !== 'VALIDATED') {
                $notExecuted = true;
            } elseif (($result['valid'] ?? null) !== true) {
                $errors[] = 'CODE_NOT_VALID_IN_VALUE_SET: ' . $code;
            }
        }
        return ['binding' => $binding['id'], 'status' => $notExecuted ? 'NOT_EXECUTED' : ($errors === [] ? 'PARTIAL' : 'INVALID'),
            'valid' => $errors === [] ? null : false, 'terminology_valid' => $notExecuted ? null : $errors === [],
            'target_locations' => $targets, 'codes_checked' => count($codes), 'value_set_version' => $valueSet->version,
            'content_sha256' => hash('sha256', $model), 'results' => $results, 'errors' => $errors,
            'warnings' => ['Binding strength is platform policy, not native openEHR syntax.',
                'Explicit XML path presence does not resolve inherited archetype nodes. OET/OPT binding preservation is not verified.'],
            'validated_at' => gmdate(DATE_ATOM)];
    }

    /**
     * @return array<string, mixed> */
    public function diff(ValueSet $before, ValueSet $after): array
    {
        $a = array_column($before->concepts, null, 'code');
        $b = array_column($after->concepts, null, 'code');
        if ($before->system !== $after->system) {
            return ['system_changed' => true, 'removed' => array_values($a), 'added' => array_values($b), 'review_required' => true];
        }
        $changed = [];
        $inactive = [];
        $replacements = [];
        foreach ($b as $code => $concept) {
            if (isset($a[$code]) && $a[$code] !== $concept) {
                $changed[] = ['code' => (string) $code, 'before' => $a[$code], 'after' => $concept];
            }
            if (($concept['inactive'] ?? false) && !($a[$code]['inactive'] ?? false)) {
                $inactive[] = (string) $code;
            }
            if (isset($concept['replacement'])) {
                $replacements[] = ['code' => (string) $code, 'suggestion' => $concept['replacement']];
            }
        }
        $hierarchy = $this->hierarchyDiff($a, $b);
        return ['system' => $before->system, 'before_version' => $before->version, 'after_version' => $after->version,
            'added' => array_values(array_diff_key($b, $a)), 'removed' => array_values(array_diff_key($a, $b)),
            'changed' => $changed, 'inactive' => $inactive, 'replacements' => $replacements,
            'hierarchy' => $hierarchy, 'review_required' => true, 'codes_replaced_automatically' => false];
    }

    /** @param array<string, array<string, mixed>> $before
     * @param array<string, array<string, mixed>> $after
     * @return array<string, mixed> */
    private function hierarchyDiff(array $before, array $after): array
    {
        $beforeComplete = $before !== [] && array_reduce($before, static fn (bool $carry, array $concept): bool => $carry && array_key_exists('parents', $concept), true);
        $afterComplete = $after !== [] && array_reduce($after, static fn (bool $carry, array $concept): bool => $carry && array_key_exists('parents', $concept), true);
        if (!$beforeComplete || !$afterComplete) {
            return ['status' => 'NOT_COMPARABLE', 'reason' => 'Explicit parent relationships are required for every concept in both versions.'];
        }
        $edges = static function (array $concepts): array {
            $result = [];
            foreach ($concepts as $code => $concept) {
                foreach ($concept['parents'] as $parent) {
                    $result[json_encode([(string) $code, $parent], JSON_THROW_ON_ERROR)] = ['child' => (string) $code, 'parent' => $parent];
                }
            }
            ksort($result);
            return $result;
        };
        $oldEdges = $edges($before);
        $newEdges = $edges($after);
        return ['status' => 'COMPARED_DECLARED_RELATIONSHIPS', 'added' => array_values(array_diff_key($newEdges, $oldEdges)),
            'removed' => array_values(array_diff_key($oldEdges, $newEdges)), 'review_required' => true,
            'scope' => 'explicit_parent_edges_only'];
    }

    /**
     * @param list<array<string, mixed>> $bindings
     * @return array<string, mixed> */
    public function manifest(string $artifact, array $bindings): array
    {
        $dependencies = [];
        foreach ($bindings as $binding) {
            if (($binding['artifact'] ?? '') !== $artifact) {
                continue;
            }
            foreach (['id', 'node', 'system', 'value_set', 'value_set_version'] as $field) {
                if (!is_string($binding[$field] ?? null) || $binding[$field] === '') {
                    throw new \InvalidArgumentException('Manifest binding missing: ' . $field);
                }
            }
            $dependencies[] = array_intersect_key($binding, array_flip(['id', 'node', 'system', 'value_set', 'value_set_version', 'code_system_version', 'requirements']));
        }
        return ['artifact' => $artifact, 'terminology_dependencies' => $dependencies,
            'status' => 'DECLARED_DEPENDENCIES', 'generated_at' => gmdate(DATE_ATOM)];
    }
}
