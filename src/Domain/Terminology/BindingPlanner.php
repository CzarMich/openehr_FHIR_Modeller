<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Terminology;

use OpenEHR\Assistant\Domain\Terminology\Catalogue\LocalOperations;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;

/** Deterministic proposals from explicit codings; never chooses clinical meaning or mutates a model. */
final readonly class BindingPlanner
{
    public function __construct(private LocalOperations $local) {}

    /** @param array<mixed> $aliases
     * @return list<array<string, mixed>> */
    public function aliases(array $aliases): array
    {
        if (!array_is_list($aliases) || count($aliases) > 100) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_ALIASES'); }
        $seen = [];
        foreach ($aliases as $alias) {
            if (!is_array($alias)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_ALIAS'); }
            Resource::keys($alias, ['terminology_id', 'system', 'version', 'archetype']);
            Resource::text($alias['terminology_id'] ?? null, 2048); Resource::canonical($alias['system'] ?? null);
            foreach (['version' => 200, 'archetype' => 500] as $key => $max) { if (isset($alias[$key])) { Resource::text($alias[$key], $max); } }
            if ($alias['terminology_id'] === 'local' && !isset($alias['archetype'])) { throw new \InvalidArgumentException('LOCAL_TERMINOLOGY_ALIAS_REQUIRES_ARCHETYPE'); }
            $canonical = $this->canonical($alias['terminology_id']);
            if ($canonical !== null && $canonical !== $alias['system']) { throw new \InvalidArgumentException('CANONICAL_ALIAS_CANNOT_REMAP_SYSTEM'); }
            $key = json_encode([$alias['terminology_id'], $alias['archetype'] ?? null], JSON_THROW_ON_ERROR);
            if (isset($seen[$key])) { throw new \InvalidArgumentException('DUPLICATE_TERMINOLOGY_ALIAS'); }
            $seen[$key] = true;
        }
        usort($aliases, static fn (array $a, array $b): int => [$a['terminology_id'], $a['archetype'] ?? ''] <=> [$b['terminology_id'], $b['archetype'] ?? '']);
        return $aliases;
    }

    /** @param array<string, mixed> $inspection
     * @param list<array{resource: Resource, evidence: array<string, mixed>}> $catalogue
     * @param list<array<string, mixed>> $aliases
     * @return array<string, mixed> */
    public function plan(array $inspection, array $catalogue, array $aliases = []): array
    {
        $aliases = $this->aliases($aliases); $sets = []; $systems = []; $findings = $inspection['findings']; $concepts = 0;
        if (count($catalogue) > 100 || count($inspection['slots']) > 100) { throw new \InvalidArgumentException('BINDING_PLAN_LIMIT_EXCEEDED'); }
        foreach ($catalogue as $entry) {
            $data = $entry['resource']->data; $concepts += count($data['concepts'] ?? []);
            if ($concepts > 50000) { throw new \InvalidArgumentException('BINDING_PLAN_CONCEPT_LIMIT_EXCEEDED'); }
            if ($data['kind'] === 'value_set') {
                $index = [];
                foreach ($data['concepts'] as $coding) {
                    if (($coding['inactive'] ?? false) || ($coding['abstract'] ?? false)) { continue; }
                    $index[$this->key($coding['system'], $coding['code'])][] = $coding['version'] ?? null;
                }
                $sets[] = $entry + ['index' => $index];
            }
            if ($data['kind'] === 'code_system') { $systems[$data['canonical']][] = $entry; }
        }
        $decisions = [];
        foreach ($inspection['slots'] as $slot) {
            $codings = []; $unresolved = count($slot['unresolved_literals']);
            foreach ($slot['codings'] as $coding) {
                $resolved = $this->resolve($coding, $slot['archetype'], $aliases);
                if ($resolved === null) { $unresolved++; continue; }
                $codings[$this->key($resolved['system'], $resolved['code']) . '\n' . ($resolved['version'] ?? '')] = $resolved;
            }
            $codings = array_values($codings); $candidates = []; $references = [];
            foreach ($slot['existing_references'] as $reference) {
                $matches = [];
                if ($reference['canonical'] !== null) {
                    foreach ($sets as $set) {
                        if ($set['resource']->data['canonical'] === $reference['canonical']) { $matches[] = $set['evidence']; }
                    }
                }
                $references[] = $reference + ['action' => 'PRESERVE', 'catalogue_matches' => $matches, 'version_confirmed' => false];
                $findings[] = $this->finding('EXISTING_BINDING_REQUIRES_VERIFICATION', $slot['location'],
                    'The existing reference is preserved. Its edition and native binding semantics have not been verified.',
                    'Resolve the named query or canonical against an explicitly selected edition and validate it through the engine.');
            }
            if ($references === [] && $codings !== [] && $unresolved === 0) {
                foreach ($sets as $set) {
                    if ($set['resource']->data['source'] !== 'local') { continue; }
                    $covered = true; $versionsConfirmed = true;
                    foreach ($codings as $coding) {
                        $versions = $set['index'][$this->key($coding['system'], $coding['code'])] ?? [];
                        if ($versions === [] || ($coding['version'] !== null && !in_array($coding['version'], $versions, true))) { $covered = false; break; }
                        if ($coding['version'] === null) { $versionsConfirmed = false; }
                    }
                    if ($covered) {
                        $candidates[] = ['value_set' => $set['evidence'], 'basis' => 'EXPLICIT_CODE_MEMBERSHIP',
                            'code_system_versions_confirmed' => $versionsConfirmed, 'requires_human_review' => true,
                            'preserve_original_constraints' => true, 'applied' => false];
                    }
                }
            }
            if ($unresolved > 0) {
                $findings[] = $this->finding('UNRESOLVED_TERMINOLOGY_LITERAL', $slot['location'],
                    'Some source literals or terminology identifiers cannot be resolved without an explicit modelling decision.',
                    'Review free text and archetype-local choices; declare a canonical alias only when its meaning is established.');
            }
            if ($references === [] && count($candidates) !== 1) {
                $findings[] = $this->finding(count($candidates) > 1 ? 'AMBIGUOUS_VALUE_SET_CANDIDATES' : 'NO_DETERMINISTIC_VALUE_SET_CANDIDATE', $slot['location'],
                    'The catalogue does not identify one explicit membership candidate. External binding remains optional.',
                    'Review the original coded choices and project requirements; retain local choices or record an explicit binding decision.');
            }
            $validation = [];
            foreach ($codings as $coding) {
                $editions = array_values(array_filter($systems[$coding['system']] ?? [], static fn (array $entry): bool => $coding['version'] !== null
                    && $entry['resource']->data['version'] === $coding['version'] && $entry['resource']->data['source'] === 'local'));
                if (count($editions) === 1) {
                    $result = $this->local->validate($editions[0]['resource'], $coding['system'], $coding['code'], $coding['version']);
                    $validation[] = ['coding' => $coding, 'status' => $result['status'], 'valid' => $result['valid'], 'resource' => $editions[0]['evidence']];
                    if ($result['valid'] === false) { $findings[] = $this->finding('CODE_INVALID_IN_SELECTED_EDITION', $slot['location'],
                        'An explicit source code is invalid in the selected local CodeSystem edition.', 'Review the source constraint and selected edition; do not substitute a different code.', 'error'); }
                } else { $validation[] = ['coding' => $coding, 'status' => 'NOT_EXECUTED', 'valid' => null, 'reason' => 'A pinned local CodeSystem edition is required.']; }
            }
            if (in_array('NOT_EXECUTED', array_column($validation, 'status'), true)) {
                $findings[] = $this->finding('CODE_VALIDATION_NOT_EXECUTED', $slot['location'], 'Some code validation lacks a pinned local CodeSystem edition.',
                    'Select a verified edition or validate the recorded coding with the configured terminology provider.');
            }
            $decisions[] = ['location' => $slot['location'], 'declared_path' => $slot['declared_path'], 'archetype' => $slot['archetype'],
                'action' => $references !== [] ? 'PRESERVE_EXISTING' : ($candidates === [] ? 'UNRESOLVED' : 'PROPOSE_FOR_REVIEW'),
                'resolved_codings' => $codings, 'unresolved_count' => $unresolved, 'existing_references' => $references,
                'candidates' => $candidates, 'code_validation' => $validation, 'native_semantics_verified' => false];
        }
        return ['status' => $inspection['status'] === 'NOT_EXECUTED' ? 'NOT_EXECUTED' : 'PARTIAL', 'inspection' => $inspection,
            'aliases' => $aliases, 'decisions' => $decisions, 'findings' => $findings,
            'scope' => 'explicit_xml_constraints_and_project_catalogue', 'external_discovery' => 'NOT_EXECUTED',
            'binding_strength' => null, 'clinical_approval' => false, 'model_changed' => false, 'release_ready' => false,
            'limitations' => ['Matching explicit codes does not establish clinical suitability.',
                'Candidates must not widen, replace or remove the source constraints, exclusions or existing bindings.',
                'Inherited semantics, native binding application and compilation require the qualified openEHR engine.',
                'Aliases are declared modelling decisions; automatic code discovery and substitution are prohibited.']];
    }

    /** @param array<string, mixed> $coding
     * @param list<array<string, mixed>> $aliases
     * @return array<string, mixed>|null */
    private function resolve(array $coding, ?string $archetype, array $aliases): ?array
    {
        $id = $coding['terminology_id'];
        if (!is_string($id) || !is_string($coding['code']) || $coding['code'] === '') { return null; }
        $selected = null;
        foreach ($aliases as $alias) {
            if ($alias['terminology_id'] !== $id || (isset($alias['archetype']) && $alias['archetype'] !== $archetype)) { continue; }
            if ($selected === null || isset($alias['archetype'])) { $selected = $alias; }
        }
        $system = $selected['system'] ?? $this->canonical($id);
        if ($system === null) { return null; }
        return ['system' => $system, 'code' => $coding['code'], 'version' => $selected['version'] ?? $coding['version'],
            'resolution' => $selected === null ? 'source_canonical' : 'declared_alias'];
    }

    private function canonical(string $value): ?string
    {
        try { Resource::canonical($value); return $value; } catch (\InvalidArgumentException) { return null; }
    }
    private function key(string $system, string $code): string { return json_encode([$system, $code], JSON_THROW_ON_ERROR); }

    /** @return array<string, mixed> */
    private function finding(string $code, string $location, string $message, string $remediation, string $severity = 'warning'): array
    {
        return ['severity' => $severity, 'code' => $code, 'location' => $location, 'message' => $message,
            'evidence' => ['scope' => 'explicit_xml_constraints_and_project_catalogue'], 'remediation' => $remediation];
    }
}
