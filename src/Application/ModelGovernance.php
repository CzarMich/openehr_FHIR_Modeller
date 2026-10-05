<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Governance\ValidationProvider;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;

/** Exact-revision governance. The ledger, not model metadata, is authoritative. */
final readonly class ModelGovernance
{
    public function __construct(private ModelRepository $repository, private AuditStore $audit, private ReviewPolicy $policy,
        private ValidationProvider $validator, private AccessPolicy $access, private Actor $actor) {}

    /** @return array<string, mixed> */
    public function prepare(string $project, string $path, string $modelRevision, string $comment): array
    {
        $this->write(); $this->modeller(); $this->comment($comment);
        if (($this->repository->getProject($project)['status'] ?? '') !== 'ACTIVE') { throw new \RuntimeException('GOVERNANCE_PROJECT_ARCHIVED'); }
        $source = $this->repository->getArtifact($project, $path);
        if ($source['revision'] !== $modelRevision) { throw new \RuntimeException('MODEL_REVISION_CONFLICT'); }
        $identity = ['project' => $project, 'path' => $path, 'revision' => $source['revision'], 'sha256' => $source['sha256']];
        $id = hash('sha256', json_encode($identity, JSON_THROW_ON_ERROR));
        if ($this->audit->events($this->actor->tenant, $id) === []) {
            $this->audit->append($this->actor->tenant, $id, 0, ['type' => 'REGISTER', 'project' => $project, 'source' => $identity,
                'author' => $this->actor->id, 'actor' => $this->actor->evidence(), 'previous_state' => null, 'new_state' => 'DRAFT', 'comment' => $comment]);
        }
        return $this->get($id);
    }

    /** Validation reports are produced by the installed executor and recorded in the protected ledger.
     * @return array<string, mixed> */
    public function validate(string $subject, int $expectedSequence): array
    {
        $this->write(); $this->modeller(); $view = $this->get($subject); $this->sequence($view, $expectedSequence);
        if (in_array($view['state'], ['APPROVED', 'PUBLISHED', 'DEPRECATED'], true)) { throw new \DomainException('GOVERNANCE_VALIDATION_STATE_FORBIDDEN'); }
        $source = $this->currentSource($view);
        if (!is_string($source['content'] ?? null)) { throw new \RuntimeException('MODEL_TEXT_FORMAT_REQUIRED'); }
        $report = $this->validator->evaluate($source['content'], strtolower(pathinfo($source['path'], PATHINFO_EXTENSION)));
        if (($report['content_sha256'] ?? null) !== $source['sha256']) { throw new \RuntimeException('GOVERNANCE_VALIDATOR_IDENTITY_MISMATCH'); }
        $digest = hash('sha256', json_encode($report, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $qualified = $this->policy->qualified($report, $source['sha256']);
        $this->audit->append($this->actor->tenant, $subject, $expectedSequence, ['type' => 'VALIDATION', 'project' => $view['source']['project'],
            'actor' => $this->actor->evidence(), 'previous_state' => $view['state'], 'new_state' => $qualified ? 'VALIDATED' : 'DRAFT',
            'comment' => 'Deterministic validation executed; previous review decisions do not apply to new validation evidence.',
            'validation' => $report, 'validation_digest' => $digest]);
        return $this->get($subject);
    }

    /** Human-only transitions are rejected for every MCP actor, independent of delegated bearer roles.
     * @return array<string, mixed> */
    public function transition(string $subject, int $expectedSequence, string $to, string $comment, ?string $validationDigest = null): array
    {
        $this->write(); $this->comment($comment); $view = $this->get($subject); $this->sequence($view, $expectedSequence);
        $this->policy->assertTransition($view['state'], $to, $view['author'], $this->actor, $view['validation'], $view['source']['sha256']);
        if ($to !== 'DEPRECATED') { $this->currentSource($view); }
        if (in_array($to, ['APPROVED', 'PUBLISHED'], true)
            && ($validationDigest === null || !hash_equals($view['validation_digest'] ?? '', $validationDigest))) {
            throw new \DomainException('GOVERNANCE_VALIDATION_CONFIRMATION_REQUIRED');
        }
        $this->audit->append($this->actor->tenant, $subject, $expectedSequence, ['type' => 'TRANSITION', 'project' => $view['source']['project'],
            'actor' => $this->actor->evidence(), 'previous_state' => $view['state'], 'new_state' => $to, 'comment' => $comment,
            'validation_digest' => $view['validation_digest']]);
        return $this->get($subject);
    }

    /** @return array<string, mixed> */
    public function get(string $subject, bool $includeContent = false): array
    {
        $events = $this->audit->events($this->actor->tenant, $subject);
        if ($events === [] || ($events[0]['type'] ?? null) !== 'REGISTER') { throw new \RuntimeException('GOVERNANCE_SUBJECT_NOT_FOUND'); }
        $first = $events[0]; $last = $events[count($events) - 1]; $validation = null; $digest = null;
        foreach ($events as $event) {
            if ($event['type'] === 'VALIDATION') { $validation = $event['validation']; $digest = $event['validation_digest']; }
        }
        $view = ['subject' => $subject, 'sequence' => $last['sequence'], 'state' => $last['new_state'], 'author' => $first['author'],
            'source' => $first['source'], 'validation' => $validation, 'validation_digest' => $digest, 'events' => $events,
            'clinical_approval' => in_array($last['new_state'], ['APPROVED', 'PUBLISHED'], true), 'current_source' => null,
            'approval_scope' => 'The exact recorded source revision, never a newer model revision.'];
        try {
            $this->currentSource($view); $view['current_source'] = true;
        } catch (\RuntimeException|\InvalidArgumentException) { $view['current_source'] = false; }
        if ($includeContent) {
            $source = $this->repository->getArtifact($first['source']['project'], $first['source']['path'], $first['source']['revision']);
            if ($source['sha256'] !== $first['source']['sha256']) { throw new \RuntimeException('GOVERNANCE_SOURCE_INTEGRITY_FAILED'); }
            $view['content'] = $source['content'];
        }
        $view['available_transitions'] = [];
        try { $this->write(); $writable = true; } catch (\RuntimeException) { $writable = false; }
        foreach (ReviewPolicy::TRANSITIONS[$view['state']] ?? [] as $to) {
            if (!$writable || (!$view['current_source'] && $to !== 'DEPRECATED')) { continue; }
            try {
                $this->policy->assertTransition($view['state'], $to, $view['author'], $this->actor, $validation, $view['source']['sha256']);
                $view['available_transitions'][] = $to;
            } catch (\DomainException) { /* The server still enforces policy on every submitted transition. */ }
        }
        return $view;
    }

    /** @return array<string, mixed> */
    public function list(string $project, int $count = 25, int $offset = 0): array
    {
        $this->repository->getProject($project); $items = [];
        foreach ($this->audit->subjects($this->actor->tenant, $project, $count, $offset, 'REGISTER') as $record) {
            $items[] = ['subject' => $record['subject'], 'sequence' => $record['sequence'], 'state' => $record['latest']['new_state'],
                'source' => $record['first']['source'], 'author' => $record['first']['author'], 'updated_at' => $record['latest']['timestamp']];
        }
        return ['items' => $items, 'offset' => $offset, 'count' => $count, 'has_more_possible' => count($items) === $count];
    }

    /** @param array<string, mixed> $view
     * @return array<string, mixed> */
    private function currentSource(array $view): array
    {
        if (($this->repository->getProject($view['source']['project'])['status'] ?? '') !== 'ACTIVE') { throw new \RuntimeException('GOVERNANCE_PROJECT_ARCHIVED'); }
        $source = $this->repository->getArtifact($view['source']['project'], $view['source']['path']);
        if ($source['revision'] !== $view['source']['revision'] || $source['sha256'] !== $view['source']['sha256']) {
            throw new \RuntimeException('GOVERNANCE_SOURCE_CHANGED');
        }
        return $source;
    }
    /** @param array<string, mixed> $view */
    private function sequence(array $view, int $expected): void
    {
        if ($view['sequence'] !== $expected) { throw new \RuntimeException('GOVERNANCE_REVISION_CONFLICT'); }
    }
    private function write(): void
    {
        if ($this->actor->human) { $this->access->assertHumanGovernanceWrite(); }
        else { $this->access->assertModelWrite(); }
    }
    private function modeller(): void
    {
        if (!in_array('modeller', $this->actor->roles, true)) { throw new \DomainException('GOVERNANCE_MODELLER_REQUIRED'); }
    }
    private function comment(string $comment): void
    {
        if (trim($comment) === '' || strlen($comment) > 4000 || preg_match('//u', $comment) !== 1
            || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $comment)) { throw new \InvalidArgumentException('INVALID_GOVERNANCE_COMMENT'); }
    }
}
