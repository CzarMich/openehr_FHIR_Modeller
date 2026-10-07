<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Governance;

/** The persisted lifecycle separates technical checks, review and clinical approval. */
final class ReviewPolicy
{
    public const array TRANSITIONS = [
        'DRAFT' => ['REVIEW_REQUESTED'], 'VALIDATED' => ['REVIEW_REQUESTED'],
        'REVIEW_REQUESTED' => ['REVIEWED', 'CHANGES_REQUESTED'],
        'REVIEWED' => ['APPROVED', 'CHANGES_REQUESTED'],
        'CHANGES_REQUESTED' => ['DRAFT'], 'APPROVED' => ['PUBLISHED', 'CHANGES_REQUESTED'],
        'PUBLISHED' => ['DEPRECATED'], 'DEPRECATED' => [],
    ];

    /** @param array<string, mixed>|null $validation */
    public function assertTransition(string $from, string $to, string $author, Actor $actor, ?array $validation, string $contentHash): void
    {
        if (!in_array($to, self::TRANSITIONS[$from] ?? [], true)) { throw new \DomainException('GOVERNANCE_INVALID_TRANSITION'); }
        if (in_array($to, ['REVIEWED', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'DEPRECATED'], true)) {
            $role = match ($to) { 'APPROVED' => 'approver', 'PUBLISHED', 'DEPRECATED' => 'publisher', default => 'reviewer' };
            if (!$actor->human || $actor->id === $author || !in_array($role, $actor->roles, true)) {
                throw new \DomainException('GOVERNANCE_INDEPENDENT_HUMAN_REQUIRED');
            }
        } elseif (!in_array('modeller', $actor->roles, true)) { throw new \DomainException('GOVERNANCE_MODELLER_REQUIRED'); }
        if (in_array($to, ['APPROVED', 'PUBLISHED'], true) && !$this->qualified($validation, $contentHash)) {
            throw new \DomainException('GOVERNANCE_VALIDATION_REQUIRED');
        }
    }

    /** @param array<string, mixed>|null $report */
    public function qualified(?array $report, string $contentHash): bool
    {
        if ($report === null || ($report['status'] ?? null) !== 'PASS' || ($report['release_eligible'] ?? null) !== true
            || ($report['content_sha256'] ?? null) !== $contentHash || !is_array($report['steps'] ?? null) || $report['steps'] === []) { return false; }
        $stages = [];
        foreach ($report['steps'] as $step) {
            if (!is_array($step) || !in_array($step['status'] ?? null, ['PASS', 'NOT_APPLICABLE'], true)) { return false; }
            if (!is_string($step['name'] ?? null) || isset($stages[$step['name']])) { return false; }
            $stages[$step['name']] = $step['status'];
            if ($step['status'] === 'NOT_APPLICABLE' && (!is_string($step['reason'] ?? null) || trim($step['reason']) === '')) { return false; }
        }
        foreach (['parse', 'structure', 'semantics', 'openehr_conformance', 'repository_policy', 'requirements_traceability'] as $required) {
            if (($stages[$required] ?? null) !== 'PASS') { return false; }
        }
        foreach (['dependencies', 'terminology'] as $conditional) {
            if (!isset($stages[$conditional])) { return false; }
        }
        return true;
    }
}
