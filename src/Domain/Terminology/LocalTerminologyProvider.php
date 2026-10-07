<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

/** A bounded local value-set snapshot, not evidence of complete code-system coverage. */
final readonly class LocalTerminologyProvider implements TerminologyProvider
{
    public function __construct(private ValueSet $valueSet)
    {
        if ($valueSet->source !== 'local') {
            throw new \InvalidArgumentException('External terminology must be verified with its provider.');
        }
    }

    public function lookup(string $system, string $code, ?string $version = null, ?string $language = null): array
    {
        if ($version !== null && $this->valueSet->codeSystemVersion === null) {
            return ['status' => 'NOT_EXECUTED', 'valid' => null, 'errors' => ['CODE_SYSTEM_VERSION_UNKNOWN'], 'provider' => 'local'];
        }
        $matches = array_values(array_filter($this->valueSet->concepts, static fn (array $concept): bool => $concept['code'] === $code));
        $matchesVersion = $version === null || $version === $this->valueSet->codeSystemVersion;
        $concept = $system === $this->valueSet->system && $matchesVersion ? ($matches[0] ?? null) : null;
        if ($concept !== null && $language !== null) {
            foreach ($concept['designation'] ?? [] as $designation) {
                if (($designation['language'] ?? null) === $language && is_string($designation['value'] ?? null)) {
                    $concept['display'] = $designation['value'];
                    break;
                }
            }
        }
        return ['status' => 'VALIDATED', 'valid' => $concept !== null && !($concept['inactive'] ?? false) && !($concept['abstract'] ?? false),
            'concept' => $concept, 'system' => $system, 'code' => $code, 'version' => $this->valueSet->codeSystemVersion,
            'value_set_version' => $this->valueSet->version, 'scope' => 'local_value_set',
            'provider' => 'local', 'validated_at' => gmdate(DATE_ATOM)];
    }

    public function validateCode(string $system, string $code, ?string $valueSet = null, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array
    {
        if ($valueSet !== null && (($valueSet !== $this->valueSet->id && $valueSet !== $this->valueSet->canonical)
            || ($version !== null && $version !== $this->valueSet->version))) {
            return ['status' => 'VALIDATED', 'valid' => false, 'errors' => ['VALUE_SET_OR_VERSION_NOT_FOUND'], 'provider' => 'local'];
        }
        if ($valueSet === null && $version !== null && $codeSystemVersion !== null && $version !== $codeSystemVersion) {
            throw new \InvalidArgumentException('Conflicting code-system versions.');
        }
        $result = $this->lookup($system, $code, $valueSet === null ? ($version ?? $codeSystemVersion) : $codeSystemVersion, $language);
        if ($result['valid'] === true && $display !== null && $result['concept']['display'] !== $display) {
            $result['valid'] = false;
            $result['errors'] = ['DISPLAY_MISMATCH'];
        }
        return $result;
    }

    public function expand(string $valueSet, ?string $version = null, int $count = 50, int $offset = 0,
        ?string $language = null, ?string $filter = null): array
    {
        if ($count < 0 || $count > 500 || $offset < 0 || $offset > 1000000) {
            throw new \InvalidArgumentException('Invalid terminology expansion page.');
        }
        if (($valueSet !== $this->valueSet->id && $valueSet !== $this->valueSet->canonical)
            || ($version !== null && $version !== $this->valueSet->version)) {
            return ['status' => 'NOT_EXECUTED', 'valid' => null, 'errors' => ['VALUE_SET_OR_VERSION_NOT_FOUND']];
        }
        $concepts = [];
        foreach ($this->valueSet->concepts as $concept) {
            if ($language !== null) {
                foreach ($concept['designation'] ?? [] as $designation) {
                    if (($designation['language'] ?? null) === $language && is_string($designation['value'] ?? null)) {
                        $concept['display'] = $designation['value'];
                        break;
                    }
                }
            }
            if ($filter === null || str_contains($concept['display'], $filter) || str_contains($concept['code'], $filter)) {
                $concepts[] = $concept;
            }
        }
        $items = array_slice($concepts, $offset, $count);
        return ['status' => 'VALIDATED', 'items' => $items, 'total' => count($concepts), 'offset' => $offset,
            'version' => $this->valueSet->version, 'code_system_version' => $this->valueSet->codeSystemVersion,
            'complete' => $offset === 0 && count($items) === count($concepts), 'filtered' => $filter !== null,
            'provider' => 'local'];
    }
}
