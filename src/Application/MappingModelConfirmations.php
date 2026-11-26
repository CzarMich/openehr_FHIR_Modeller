<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;

/** Human selection of exact mapping inputs; never a clinical/publication approval. */
final readonly class MappingModelConfirmations
{
    public function __construct(private ModelRepository $models, private ModelRepository $fhir,
        private AuditStore $audit, private AccessPolicy $access, private Actor $actor) {}

    /** @param mixed $bindings
     * @return array<string, mixed> */
    public function prepare(string $project, mixed $bindings): array
    {
        $this->access->assertProjectWrite($project);
        $inputs = $this->resolve($project, $bindings);
        $pins = array_map(static fn (array $item): array => $item['pin'], $inputs);
        $subject = hash('sha256', json_encode(['purpose' => 'mapping-model-selection-v1', 'project' => $project, 'pins' => $pins], JSON_THROW_ON_ERROR));
        if ($this->audit->events($this->actor->tenant, $subject) === []) {
            $this->audit->append($this->actor->tenant, $subject, 0, ['type' => 'MAPPING_MODEL_SELECTION', 'project' => $project,
                'pins' => $pins, 'actor' => $this->actor->evidence(), 'new_state' => 'PENDING']);
        }
        return $this->get($subject);
    }

    /** @return array<string, mixed> */
    public function get(string $subject): array
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $subject)) { throw new \InvalidArgumentException('MAPPING_CONFIRMATION_INVALID'); }
        $events = $this->audit->events($this->actor->tenant, $subject);
        $first = $events[0] ?? [];
        if (($first['type'] ?? '') !== 'MAPPING_MODEL_SELECTION') { throw new \RuntimeException('GOVERNANCE_SUBJECT_NOT_FOUND'); }
        // Repository access is rechecked on every read and decision, including stale requests.
        $inputs = $this->resolve($first['project'], $first['pins'], false);
        $last = $events[count($events) - 1];
        $current = !in_array(false, array_column($inputs, 'current'), true);
        return ['subject' => $subject, 'project' => $first['project'], 'sequence' => count($events), 'state' => $last['new_state'],
            'current' => $current, 'mappingConfirmed' => $current && $last['new_state'] === 'CONFIRMED',
            'clinicalApproval' => false, 'items' => $inputs, 'events' => $events,
            'scope' => 'Human confirmation of exact supplied mapping models; clinical approval and publication remain separate.'];
    }

    /** @return array<string, mixed> */
    public function decide(string $subject, int $expectedSequence, string $decision, string $comment): array
    {
        if (!$this->actor->human || !in_array($this->actor->method, ['interactive_local', 'interactive_oidc'], true)
            || array_intersect($this->actor->roles, ['modeller', 'reviewer', 'approver']) === []) {
            throw new \DomainException('GOVERNANCE_HUMAN_CONFIRMATION_REQUIRED');
        }
        $this->access->assertHumanGovernanceWrite();
        $view = $this->get($subject);
        $this->access->assertProjectWrite($view['project']);
        if ($view['sequence'] !== $expectedSequence) { throw new \RuntimeException('GOVERNANCE_REVISION_CONFLICT'); }
        if (!in_array($decision, ['CONFIRMED', 'REVOKED'], true) || trim($comment) === '' || strlen($comment) > 4000
            || preg_match('//u', $comment) !== 1 || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $comment)) {
            throw new \InvalidArgumentException('MAPPING_CONFIRMATION_DECISION_INVALID');
        }
        if ($decision === 'CONFIRMED' && !$view['current']) { throw new \RuntimeException('GOVERNANCE_SOURCE_CHANGED'); }
        $this->audit->append($this->actor->tenant, $subject, $expectedSequence, ['type' => 'MAPPING_MODEL_DECISION',
            'project' => $view['project'], 'actor' => $this->actor->evidence(), 'previous_state' => $view['state'],
            'new_state' => $decision, 'comment' => $comment]);
        return $this->get($subject);
    }

    /** @param mixed $bindings
     * @return list<array<string, mixed>> */
    private function resolve(string $project, mixed $bindings, bool $requireCurrent = true): array
    {
        if (!is_array($bindings) || !array_is_list($bindings) || count($bindings) < 2 || count($bindings) > 20) {
            throw new \InvalidArgumentException('MAPPING_MODELS_REQUIRED');
        }
        $items = []; $standards = []; $seen = []; $bytes = 0;
        foreach ($bindings as $binding) {
            if (!is_array($binding) || array_diff(array_keys($binding), ['standard', 'projectId', 'path', 'revision', 'sha256', 'version', 'origin']) !== []) {
                throw new \InvalidArgumentException('MAPPING_MODEL_INVALID');
            }
            foreach (['standard', 'projectId', 'path', 'revision', 'sha256', 'version', 'origin'] as $field) {
                if (!is_string($binding[$field] ?? null) || $binding[$field] === '' || strlen($binding[$field]) > 512) {
                    throw new \InvalidArgumentException('MAPPING_MODEL_PIN_REQUIRED');
                }
            }
            if (!in_array($binding['standard'], ['openEHR', 'FHIR'], true) || !in_array($binding['origin'], ['agent-modelled', 'externally-provided'], true)
                || !preg_match('/^[a-f0-9]{64}$/D', $binding['sha256'])) { throw new \InvalidArgumentException('MAPPING_MODEL_INVALID'); }
            $standard = $binding['standard']; $standards[$standard] = true;
            if ($standard === 'FHIR' && $binding['projectId'] !== $project) { throw new \DomainException('MAPPING_MODEL_PROJECT_MISMATCH'); }
            $key = $standard . ':' . $binding['projectId'] . ':' . $binding['path'];
            if (isset($seen[$key])) { throw new \InvalidArgumentException('MAPPING_MODEL_DUPLICATE'); }
            $seen[$key] = true;
            $repository = $standard === 'FHIR' ? $this->fhir : $this->models;
            $artifact = $repository->getArtifact($binding['projectId'], $binding['path']);
            $bytes += strlen($artifact['content']);
            if ($bytes > 4194304) { throw new \InvalidArgumentException('MAPPING_MODEL_CONTEXT_LIMIT'); }
            $current = $artifact['revision'] === $binding['revision'] && hash_equals($artifact['sha256'], $binding['sha256']);
            if ($requireCurrent && !$current) { throw new \RuntimeException('GOVERNANCE_SOURCE_CHANGED'); }
            if ($standard === 'FHIR') {
                $definition = json_decode($artifact['content'], true);
                if (!is_array($definition) || ($definition['resourceType'] ?? '') !== 'StructureDefinition'
                    || ($current && ($definition['version'] ?? '') !== $binding['version'])) { throw new \InvalidArgumentException('MAPPING_STRUCTURE_DEFINITION_REQUIRED'); }
            } elseif (!preg_match('/\.(opt|opt2|oet|xml)$/iD', $binding['path'])) { throw new \InvalidArgumentException('MAPPING_TEMPLATE_REQUIRED'); }
            $binding = array_intersect_key($binding, array_flip(['standard', 'projectId', 'path', 'revision', 'sha256', 'version', 'origin']));
            ksort($binding);
            $items[] = ['pin' => $binding, 'content' => $artifact['content'], 'current' => $current];
        }
        if (!isset($standards['openEHR'], $standards['FHIR'])) { throw new \InvalidArgumentException('MAPPING_BOTH_STANDARDS_REQUIRED'); }
        usort($items, static fn (array $a, array $b): int => strcmp(json_encode($a['pin'], JSON_THROW_ON_ERROR), json_encode($b['pin'], JSON_THROW_ON_ERROR)));
        return $items;
    }
}
