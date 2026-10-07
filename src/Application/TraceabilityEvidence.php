<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Traceability\AnchorInspector;
use OpenEHR\Assistant\Domain\Traceability\Graph;

/** Resolves pinned references from trusted storage without executing graph-provided URLs. */
final readonly class TraceabilityEvidence
{
    public function __construct(
        private ModelRepository $repository,
        private AuditStore $audit,
        private Actor $actor,
        private AnchorInspector $anchors
    ) {
    }

    /**
     * @return array<string, mixed> */
    public function resolve(string $project, Graph $graph): array
    {
        $evidence = [];
        $findings = [];
        $sources = [];
        $current = [];
        $events = [];
        $failedSources = [];
        $failedCurrent = [];
        $failedEvents = [];
        $bytes = 0;
        foreach ($graph->nodes as $id => $node) {
            $result = ['status' => 'DECLARED', 'scope' => 'Versioned modeller assertion; clinical meaning is not independently certified.'];
            if (isset($node['artifact'])) {
                $ref = $node['artifact'];
                $key = $ref['path'] . "\n" . $ref['revision'];
                try {
                    if (isset($failedSources[$key])) {
                        throw new \RuntimeException('TRACEABILITY_SOURCE_UNAVAILABLE');
                    }
                    if (!isset($sources[$key])) {
                        if (count($sources) + count($events) + count($failedSources) + count($failedEvents) >= 100) {
                            throw new \LengthException('TRACEABILITY_REFERENCE_LIMIT');
                        }
                        $sources[$key] = $this->repository->getArtifact($project, $ref['path'], $ref['revision']);
                        $bytes += ($sources[$key]['size_bytes'] ?? strlen($sources[$key]['content'] ?? ''));
                        self::budget($bytes);
                    }
                    $source = $sources[$key];
                    if ($source['sha256'] !== $ref['sha256'] || $source['revision'] !== $ref['revision'] || $source['status'] === 'DELETED') {
                        $result = ['status' => 'INVALID', 'reason' => 'The recorded artifact revision/hash does not match a retained source revision.'];
                    } else {
                        $result = ['status' => 'CURRENT', 'source_verified' => true, 'source' => array_intersect_key($source, array_flip(['path', 'revision', 'sha256']))];
                        try {
                            if (isset($failedCurrent[$ref['path']])) {
                                throw new \RuntimeException('TRACEABILITY_CURRENT_SOURCE_UNAVAILABLE');
                            }
                            if (!isset($current[$ref['path']])) {
                                $current[$ref['path']] = $this->repository->getArtifact($project, $ref['path']);
                                $bytes += ($current[$ref['path']]['size_bytes'] ?? strlen($current[$ref['path']]['content'] ?? ''));
                                self::budget($bytes);
                            }
                            if ($current[$ref['path']]['revision'] !== $ref['revision'] || $current[$ref['path']]['sha256'] !== $ref['sha256']) {
                                $result['status'] = 'STALE';
                                $result['reason'] = 'The project source has a newer revision; the historical reference is retained.';
                            }
                        } catch (\RuntimeException|\InvalidArgumentException) {
                            $failedCurrent[$ref['path']] = true;
                            $result['status'] = 'UNAVAILABLE';
                            $result['reason'] = 'The historical revision resolves, but its current project source cannot be verified.';
                        }
                        if (isset($ref['anchor'])) {
                            $result['anchor'] = is_string($source['content'] ?? null) ? $this->anchors->inspect($source['content'], $ref['anchor'])
                                : ['status' => 'NOT_EXECUTED', 'reason' => 'Binary original has no supported text anchor representation.'];
                            if ($result['anchor']['status'] !== 'RESOLVED') {
                                $result['status'] = $result['anchor']['status'];
                                $result['reason'] = $result['anchor']['reason'];
                            }
                        }
                    }
                } catch (\RuntimeException|\InvalidArgumentException) {
                    $failedSources[$key] = true;
                    $result = ['status' => 'UNAVAILABLE', 'reason' => 'The referenced repository source cannot be resolved.'];
                }
            } elseif (isset($node['event'])) {
                $ref = $node['event'];
                try {
                    if (isset($failedEvents[$ref['subject']])) {
                        throw new \RuntimeException('TRACEABILITY_EVENT_UNAVAILABLE');
                    }
                    if (!isset($events[$ref['subject']])) {
                        if (count($sources) + count($events) + count($failedSources) + count($failedEvents) >= 100) {
                            throw new \LengthException('TRACEABILITY_REFERENCE_LIMIT');
                        }
                        $events[$ref['subject']] = $this->audit->events($this->actor->tenant, $ref['subject']);
                        $bytes += strlen(json_encode($events[$ref['subject']], JSON_THROW_ON_ERROR));
                        self::budget($bytes);
                    }
                    $history = $events[$ref['subject']];
                    $event = $history[$ref['sequence'] - 1] ?? null;
                    if (($history[0]['type'] ?? null) !== 'REGISTER' || !is_array($event) || ($event['project'] ?? '') !== $project || $event['hash'] !== $ref['hash']) {
                        $result = ['status' => 'INVALID', 'reason' => 'The event is absent from this tenant/project or its exact hash does not match.'];
                    } elseif (($node['type'] === 'validation_evidence' && $event['type'] !== 'VALIDATION')
                        || ($node['type'] === 'review' && ($event['type'] !== 'TRANSITION' || ($event['actor']['human'] ?? false) !== true
                            || !in_array($event['new_state'], ['REVIEWED', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHED', 'DEPRECATED'], true)))) {
                        $result = ['status' => 'INVALID', 'reason' => 'The referenced event does not supply the claimed evidence type.'];
                    } else {
                        $last = $history[count($history) - 1];
                        $result = ['status' => 'VERIFIED', 'source' => $history[0]['source'], 'event_type' => $event['type'],
                            'event_sequence' => $event['sequence'], 'event_hash' => $event['hash'], 'state_at_event' => $event['new_state'],
                            'latest_state' => $last['new_state'], 'latest_sequence' => $last['sequence'],
                            'validation_digest' => $event['validation_digest'] ?? null,
                            'validation_status' => $event['validation']['status'] ?? null,
                            'release_eligible_at_event' => $event['validation']['release_eligible'] ?? false,
                            'actor' => $event['actor'], 'scope' => 'Authentic historical audit evidence, not an approval of graph assertions.'];
                    }
                } catch (\RuntimeException|\InvalidArgumentException|\JsonException) {
                    $failedEvents[$ref['subject']] = true;
                    $result = ['status' => 'UNAVAILABLE', 'reason' => 'Authoritative governance evidence is disabled, unavailable or fails integrity checks.'];
                }
            }
            $evidence[$id] = $result;
            if (in_array($result['status'], ['INVALID', 'STALE', 'UNAVAILABLE', 'NOT_EXECUTED'], true)) {
                $findings[] = self::finding(
                    'TRACEABILITY_' . $result['status'],
                    $id,
                    $result['reason'] ?? 'The declared evidence could not be verified.',
                    $node['artifact'] ?? $node['event'] ?? [],
                    'Resolve the source/evidence reference or update the graph in a new reviewed revision.'
                );
            }
        }
        foreach ($graph->edges as $edge) {
            if (!in_array($edge['relation'], ['validated_by', 'reviewed_by'], true)) {
                continue;
            }
            $from = $evidence[$edge['from']];
            $to = $evidence[$edge['to']];
            if (isset($from['source'], $to['source'])) {
                foreach (['path', 'revision', 'sha256'] as $key) {
                    if (($from['source'][$key] ?? null) !== ($to['source'][$key] ?? null)) {
                        $findings[] = self::finding(
                            'TRACEABILITY_EVIDENCE_SOURCE_MISMATCH',
                            $edge['from'] . '->' . $edge['to'],
                            'The evidence belongs to a different model source revision.',
                            ['from' => $from['source'], 'to' => $to['source']],
                            'Link validation or review evidence for the exact model revision.'
                        );
                        break;
                    }
                }
                if ($edge['relation'] === 'reviewed_by' && $graph->nodes[$edge['from']]['type'] === 'validation_evidence'
                    && ($from['validation_digest'] ?? null) !== ($to['validation_digest'] ?? null)) {
                    $findings[] = self::finding(
                        'TRACEABILITY_REVIEW_VALIDATION_MISMATCH',
                        $edge['from'] . '->' . $edge['to'],
                        'The review event refers to different validation evidence.',
                        [],
                        'Link the validation digest actually reviewed.'
                    );
                }
            }
        }
        return ['nodes' => $evidence, 'findings' => $findings];
    }
    private static function budget(int $bytes): void
    {
        if ($bytes > 16777216) {
            throw new \LengthException('TRACEABILITY_EVIDENCE_BYTE_LIMIT');
        }
    }
    /**
     * @param array<string, mixed> $evidence
     * @return array<string, mixed> */
    public static function finding(string $code, string $location, string $message, array $evidence, string $remediation): array
    {
        return ['severity' => 'error', 'code' => $code, 'location' => $location, 'message' => $message, 'evidence' => $evidence, 'remediation' => $remediation];
    }
}
