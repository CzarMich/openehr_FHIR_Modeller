<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

use InvalidArgumentException;

/** Internal modelling metadata; not a native openEHR binding serialization. */
final readonly class ValueSet
{
    /**
     * @param list<array<string, mixed>> $concepts */
    public function __construct(
        public string $id, public string $system, public string $version,
        public array $concepts = [], public ?string $canonical = null,
        public string $source = 'local', public ?string $codeSystemVersion = null,
    ) {
        if ($id === '' || $version === '' || filter_var($system, FILTER_VALIDATE_URL) === false
            || !in_array($source, ['local', 'external'], true) || count($concepts) > 5000) {
            throw new InvalidArgumentException('Value set requires id, version, code system URI and a supported source.');
        }
        if ($source === 'external' && ($canonical === null || filter_var($canonical, FILTER_VALIDATE_URL) === false)) {
            throw new InvalidArgumentException('External value sets require a canonical URL.');
        }
        if ($codeSystemVersion !== null && ($codeSystemVersion === '' || strlen($codeSystemVersion) > 2048)) {
            throw new InvalidArgumentException('Code-system version must be a bounded non-empty string.');
        }
        $codes = [];
        foreach ($concepts as $concept) {
            if (!is_string($concept['code'] ?? null) || $concept['code'] === '' || !is_string($concept['display'] ?? null)
                || isset($codes[$concept['code']])) {
                throw new InvalidArgumentException('Value set concepts require unique codes and displays.');
            }
            foreach (['inactive', 'abstract'] as $flag) {
                if (isset($concept[$flag]) && !is_bool($concept[$flag])) {
                    throw new InvalidArgumentException('Concept status flags must be booleans.');
                }
            }
            if (isset($concept['parents'])) {
                if (!is_array($concept['parents']) || !array_is_list($concept['parents']) || count($concept['parents']) > 50) {
                    throw new InvalidArgumentException('Concept parents must be a bounded list.');
                }
                $parents = [];
                foreach ($concept['parents'] as $parent) {
                    if (!is_string($parent) || $parent === '' || strlen($parent) > 500 || isset($parents[$parent])) {
                        throw new InvalidArgumentException('Concept parents must be unique non-empty codes.');
                    }
                    $parents[$parent] = true;
                }
            }
            $designations = $concept['designation'] ?? [];
            if (!is_array($designations) || !array_is_list($designations) || count($designations) > 100) {
                throw new InvalidArgumentException('Concept designations must be a bounded list.');
            }
            foreach ($designations as $designation) {
                if (!is_array($designation) || !is_string($designation['language'] ?? null) || $designation['language'] === ''
                    || !is_string($designation['value'] ?? null) || $designation['value'] === '') {
                    throw new InvalidArgumentException('Designations require a language and display value.');
                }
            }
            $codes[$concept['code']] = true;
        }
    }

    /**
     * @param array<string, mixed> $data */
    public static function fromArray(array $data): self
    {
        foreach (['id', 'system', 'version'] as $key) {
            if (!is_string($data[$key] ?? null)) {
                throw new InvalidArgumentException('Value set field missing: ' . $key);
            }
        }
        $concepts = $data['concepts'] ?? [];
        if (!is_array($concepts) || !array_is_list($concepts)) {
            throw new InvalidArgumentException('Concepts must be a list.');
        }
        return new self($data['id'], $data['system'], $data['version'], $concepts,
            $data['canonical'] ?? null, $data['source'] ?? 'local', $data['code_system_version'] ?? null);
    }
}
