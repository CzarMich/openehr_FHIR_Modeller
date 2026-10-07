<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology\Catalogue;

/** Pure deterministic operations over explicit local content. Never calls an external service. */
final class LocalOperations
{
    /** @return array<string, mixed> */
    public function lookup(Resource $resource, string $code, ?string $language = null): array
    {
        $this->local($resource, 'code_system'); Resource::text($code, 500);
        $data = $resource->data; $key = Resource::codeKey($code, $data['case_sensitive']);
        foreach ($data['concepts'] as $concept) {
            if (Resource::codeKey($concept['code'], $data['case_sensitive']) === $key) {
                return $this->report($resource, ['valid' => !($concept['inactive'] ?? false) && !($concept['abstract'] ?? false),
                    'concept' => $this->display($concept, $data['language'] ?? null, $language), 'scope' => 'code_system_snapshot']);
            }
        }
        return $data['content'] === 'complete' ? $this->report($resource, ['valid' => false, 'concept' => null, 'errors' => ['CODE_NOT_FOUND']])
            : $this->unexecuted($resource, 'CODE_NOT_KNOWN_IN_FRAGMENT');
    }

    /** @return array<string, mixed> */
    public function validate(Resource $resource, string $system, string $code, ?string $codeSystemVersion = null,
        ?string $display = null, ?string $language = null): array
    {
        Resource::canonical($system); Resource::text($code, 500);
        if ($codeSystemVersion !== null) { Resource::text($codeSystemVersion, 200); }
        $data = $resource->data;
        if ($data['kind'] === 'code_system') {
            $this->local($resource, 'code_system');
            if ($data['canonical'] !== $system || ($codeSystemVersion !== null && $codeSystemVersion !== $data['version'])) {
                return $this->unexecuted($resource, 'CODE_SYSTEM_REFERENCE_MISMATCH');
            }
            $result = $this->lookup($resource, $code, $language);
        } else {
            $this->local($resource, 'value_set'); $matches = []; $unconfirmed = false;
            foreach ($data['concepts'] as $concept) {
                if ($concept['system'] !== $system || $concept['code'] !== $code) { continue; }
                if ($codeSystemVersion !== null && !isset($concept['version'])) { $unconfirmed = true; continue; }
                if ($codeSystemVersion === null || $concept['version'] === $codeSystemVersion) { $matches[] = $concept; }
            }
            if (count($matches) > 1) { return $this->unexecuted($resource, 'AMBIGUOUS_CODE_SYSTEM_VERSION'); }
            if ($matches === [] && $unconfirmed) { return $this->unexecuted($resource, 'CODE_SYSTEM_VERSION_UNKNOWN'); }
            $concept = $matches[0] ?? null;
            $result = $this->report($resource, ['valid' => $concept !== null && !($concept['inactive'] ?? false) && !($concept['abstract'] ?? false),
                'concept' => $concept !== null ? $this->display($concept, $data['language'] ?? null, $language) : null,
                'scope' => 'explicit_value_set_membership', 'code_system_validation' => 'NOT_EXECUTED']);
        }
        if ($result['valid'] === true && $display !== null) {
            Resource::text($display, 2000); $concept = $result['concept'];
            if ($language !== null && !$concept['language_confirmed']) {
                return $this->unexecuted($resource, 'DISPLAY_LANGUAGE_UNAVAILABLE');
            }
            $accepted = [$concept['display']];
            foreach ($concept['designation'] ?? [] as $designation) {
                if ($language === null || $designation['language'] === $language) { $accepted[] = $designation['value']; }
            }
            if (!in_array($display, $accepted, true)) { $result['valid'] = false; $result['errors'][] = 'DISPLAY_MISMATCH'; }
        }
        return $result;
    }

    /** @return array<string, mixed> */
    public function expand(Resource $resource, int $count = 50, int $offset = 0, ?string $language = null, ?string $filter = null): array
    {
        $this->local($resource, 'value_set');
        if ($count < 0 || $count > 500 || $offset < 0 || $offset > 1000000) { throw new \InvalidArgumentException('INVALID_EXPANSION_PAGE'); }
        if ($filter !== null) { Resource::text($filter, 500); }
        $concepts = [];
        foreach ($resource->data['concepts'] as $concept) {
            $concept = $this->display($concept, $resource->data['language'] ?? null, $language);
            if ($filter === null || str_contains($concept['code'], $filter) || str_contains($concept['display'], $filter)) { $concepts[] = $concept; }
        }
        $items = array_slice($concepts, $offset, $count);
        return $this->report($resource, ['valid' => null, 'items' => $items, 'total' => count($concepts), 'offset' => $offset,
            'complete' => $offset === 0 && count($items) === count($concepts), 'filtered' => $filter !== null,
            'scope' => $filter !== null ? 'filtered_expansion' : 'explicit_value_set_membership']);
    }

    /** @return array<string, mixed> */
    public function translate(Resource $resource, string $system, string $code, ?string $codeSystemVersion = null,
        ?string $targetSystem = null): array
    {
        $this->local($resource, 'concept_map'); Resource::canonical($system); Resource::text($code, 500);
        if ($codeSystemVersion !== null) { Resource::text($codeSystemVersion, 200); }
        if ($targetSystem !== null) { Resource::canonical($targetSystem); }
        $matches = []; $candidates = [];
        foreach ($resource->data['mappings'] as $mapping) {
            $source = $mapping['source'];
            if ($source['system'] !== $system || $source['code'] !== $code
                || ($codeSystemVersion !== null && isset($source['version']) && $source['version'] !== $codeSystemVersion)) { continue; }
            if ($targetSystem !== null && ($mapping['target']['system'] ?? null) !== $targetSystem) { continue; }
            $mapping['requires_review'] = true;
            $mapping['source_version_confirmed'] = $codeSystemVersion !== null && ($source['version'] ?? null) === $codeSystemVersion;
            $mapping['conditions_verified'] = ($mapping['conditions'] ?? []) === [];
            $matches[] = $mapping;
            if (!in_array($mapping['relationship'], ['unmatched', 'disjoint'], true)) { $candidates[] = $mapping; }
        }
        return $this->report($resource, ['valid' => null, 'mapping_found' => $candidates !== [], 'matches' => $matches,
            'candidates' => $candidates, 'requires_review' => true, 'applied' => false]);
    }

    /** @param array<string, mixed> $concept
     * @return array<string, mixed> */
    private function display(array $concept, ?string $defaultLanguage, ?string $language): array
    {
        $concept['language_confirmed'] = $language !== null && $defaultLanguage === $language;
        if ($language === null) { return $concept; }
        Resource::text($language, 100);
        $values = [];
        foreach ($concept['designation'] ?? [] as $designation) {
            if ($designation['language'] === $language) { $values[] = $designation['value']; }
        }
        if ($values !== []) { $concept['display'] = $values[0]; $concept['language_confirmed'] = true; }
        return $concept;
    }

    private function local(Resource $resource, string $kind): void
    {
        if ($resource->data['kind'] !== $kind) { throw new \InvalidArgumentException('TERMINOLOGY_KIND_MISMATCH'); }
        if ($resource->data['source'] !== 'local') { throw new \RuntimeException('EXTERNAL_TERMINOLOGY_REFERENCE'); }
    }

    /** @param array<string, mixed> $result
     * @return array<string, mixed> */
    private function report(Resource $resource, array $result): array
    {
        return $result + ['status' => 'VALIDATED', 'errors' => [], 'warnings' => [], 'provider' => 'local_catalogue',
            'canonical' => $resource->data['canonical'], 'version' => $resource->data['version'],
            'clinical_approval' => false, 'provenance' => $resource->data['provenance']];
    }

    /** @return array<string, mixed> */
    private function unexecuted(Resource $resource, string $code): array
    {
        return $this->report($resource, ['status' => 'NOT_EXECUTED', 'valid' => null, 'errors' => [$code]]);
    }
}
