<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Traceability\Graph;
use OpenEHR\Assistant\Validation\JsonDocument;

/** Persistent explicit requirements/decision graph shared by transport adapters. */
final readonly class ProjectTraceability
{
    public const string PATH = 'requirements/traceability.json';
    public function __construct(private ModelRepository $repository, private AccessPolicy $access, private TraceabilityEvidence $evidence)
    {
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed> */
    public function save(string $project, array $input, ?string $expectedRevision = null): array
    {
        $this->access->assertModelWrite();
        $graph = new Graph($input);
        $resolved = $this->evidence->resolve($project, $graph);
        foreach ($resolved['nodes'] as $node) {
            if (in_array($node['status'], ['INVALID', 'UNAVAILABLE'], true)) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_REFERENCES');
            }
        }
        foreach ($resolved['findings'] as $finding) {
            if (in_array($finding['code'], ['TRACEABILITY_EVIDENCE_SOURCE_MISMATCH', 'TRACEABILITY_REVIEW_VALIDATION_MISMATCH'], true)) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_EVIDENCE_LINK');
            }
        }
        $content = json_encode($graph->data(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
        $artifact = $this->repository->saveArtifact($project, self::PATH, $content, ['kind' => 'requirements_traceability', 'schema' => 1], $expectedRevision);
        return $this->report($artifact, $graph, $resolved);
    }

    /**
     * @return array<string, mixed> */
    public function get(string $project, ?string $revision = null): array
    {
        $artifact = $this->repository->getArtifact($project, self::PATH, $revision);
        if (!(JsonDocument::parse($artifact['content']) instanceof \stdClass)) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_DOCUMENT');
        }
        $input = json_decode($artifact['content'], true, 64, JSON_THROW_ON_ERROR);
        $graph = new Graph($input);
        return $this->report($artifact, $graph, $this->evidence->resolve($project, $graph));
    }

    /** Answer why a recorded element exists using explicit requirement/decision ancestors.
     *
     * @return array<string, mixed> */
    public function explain(string $project, string $node, ?string $revision = null): array
    {
        $report = $this->get($project, $revision);
        $graph = new Graph($report['graph']);
        $ids = array_values(array_unique([...$graph->walk($node, true), ...$graph->walk($node, false, ['bound_by', 'validated_by', 'reviewed_by'])]));
        sort($ids, SORT_STRING);
        return $this->select($report, $ids) + ['query' => ['kind' => 'why_element', 'node' => $node],
            'answer_basis' => 'Explicit versioned requirements, recorded rationales and resolved references; no inferred clinical justification.'];
    }

    /** Answer which recorded elements claim to satisfy a requirement, with explicit evidence limits.
     *
     * @return array<string, mixed> */
    public function requirement(string $project, string $requirement, ?string $revision = null): array
    {
        $report = $this->get($project, $revision);
        $graph = new Graph($report['graph']);
        if (($graph->nodes[$requirement]['type'] ?? '') !== 'requirement') {
            throw new \InvalidArgumentException('TRACEABILITY_REQUIREMENT_NOT_FOUND');
        }
        $ids = $graph->walk($requirement, false, ['motivates', 'justifies', 'satisfied_by', 'used_by', 'constrains', 'bound_by', 'validated_by', 'reviewed_by']);
        $coverage = array_values(array_filter($report['coverage'], static fn (array $row): bool => $row['requirement'] === $requirement))[0];
        return $this->select($report, $ids) + ['query' => ['kind' => 'requirement_coverage', 'requirement' => $requirement], 'requirement_coverage' => $coverage,
            'answer_basis' => 'Only explicit satisfied_by edges claim coverage. Design proposals and dependency traversal do not imply satisfaction.'];
    }

    /**
     * @param array<string, mixed> $artifact
     * @param array<string, mixed> $resolved
     * @return array<string, mixed> */
    private function report(array $artifact, Graph $graph, array $resolved): array
    {
        $coverage = [];
        $findings = $resolved['findings'];
        foreach ($graph->nodes as $id => $node) {
            if ($node['type'] === 'requirement') {
                $links = array_values(array_filter($graph->edges, static fn (array $e): bool => $e['from'] === $id && $e['relation'] === 'satisfied_by'));
                $status = $node['status'] === 'EXCLUDED' ? 'EXCLUDED' : ($links === [] ? 'UNRESOLVED'
                    : (in_array('partial', array_column($links, 'coverage'), true) ? 'DECLARED_PARTIAL' : 'DECLARED_FULL'));
                $targets = array_column($links, 'to');
                $current = $targets !== [];
                foreach ($targets as $target) {
                    if ($resolved['nodes'][$target]['status'] !== 'CURRENT') {
                        $current = false;
                    }
                }
                $coverage[] = ['requirement' => $id, 'declared_coverage' => $status, 'elements' => $targets, 'links' => $links,
                    'element_references_current_and_resolved' => $current, 'semantic_satisfaction' => 'NOT_ASSESSED',
                    'exclusion_reason' => $node['exclusion_reason'] ?? null];
                if ($status === 'UNRESOLVED') {
                    $findings[] = TraceabilityEvidence::finding(
                        'UNRESOLVED_REQUIREMENT',
                        $id,
                        'No model element declares coverage of this requirement.',
                        [],
                        'Record a modelling decision and explicit element links, or document an intentional exclusion.'
                    );
                }
            } elseif (in_array($node['type'], Graph::MODEL_TYPES, true)) {
                $requirements = array_filter($graph->walk($id, true), static fn (string $ancestor): bool => $graph->nodes[$ancestor]['type'] === 'requirement');
                if ($requirements === []) {
                    $findings[] = TraceabilityEvidence::finding(
                        'MISSING_REQUIREMENT_TRACEABILITY',
                        $id,
                        'No explicit requirement trail reaches this model element.',
                        [],
                        'Link the originating requirement and decision, preserving its rationale.'
                    );
                }
            }
        }
        usort($findings, static fn (array $a, array $b): int => [$a['location'], $a['code']] <=> [$b['location'], $b['code']]);
        return ['artifact' => array_intersect_key($artifact, array_flip(['path', 'revision', 'sha256', 'status'])), 'graph' => $graph->data(),
            'evidence' => $resolved['nodes'], 'coverage' => $coverage, 'findings' => $findings,
            'clinical_approval' => false, 'model_changed' => false, 'semantic_satisfaction' => 'NOT_ASSESSED',
            'verification_scope' => 'Reference identity, exact document anchors and authentic audit events as observed. Modeller assertions are not clinical/test proof.'];
    }

    /**
     * @param array<string, mixed> $report
     * @param list<string> $ids
     * @return array<string, mixed> */
    private function select(array $report, array $ids): array
    {
        $report['graph']['nodes'] = array_values(array_filter($report['graph']['nodes'], static fn (array $n): bool => in_array($n['id'], $ids, true)));
        $report['graph']['edges'] = array_values(array_filter($report['graph']['edges'], static fn (array $e): bool => in_array($e['from'], $ids, true) && in_array($e['to'], $ids, true)));
        $report['evidence'] = array_intersect_key($report['evidence'], array_fill_keys($ids, true));
        $report['coverage'] = array_values(array_filter($report['coverage'], static fn (array $r): bool => in_array($r['requirement'], $ids, true)));
        $report['findings'] = array_values(array_filter($report['findings'], static fn (array $f): bool => in_array(explode('->', $f['location'])[0], $ids, true)));
        return $report;
    }
}
