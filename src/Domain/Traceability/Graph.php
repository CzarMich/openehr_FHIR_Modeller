<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Traceability;

/** Bounded explicit modelling assertions. Graph structure never proves clinical satisfaction. */
final readonly class Graph
{
    public const array MODEL_TYPES = ['archetype', 'template', 'template_constraint', 'terminology_binding'];
    public const array TYPES = ['requirement', 'decision', ...self::MODEL_TYPES, 'validation_evidence', 'review'];
    public const int MAX_NODES = 500;
    public const int MAX_EDGES = 2000;
    /** @var array<string, array<string, mixed>> */
    public array $nodes;
    /** @var list<array<string, mixed>> */
    public array $edges;

    /**
     * @param array<string, mixed> $input */
    public function __construct(array $input)
    {
        self::fields($input, ['schema', 'nodes', 'edges'], ['schema', 'nodes', 'edges']);
        if (($input['schema'] ?? null) !== 1) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_SCHEMA');
        }
        self::list($input['nodes'], self::MAX_NODES);
        self::list($input['edges'], self::MAX_EDGES);
        if (strlen(json_encode($input, JSON_THROW_ON_ERROR)) > 1048576) {
            throw new \InvalidArgumentException('TRACEABILITY_GRAPH_TOO_LARGE');
        }
        $nodes = [];
        foreach ($input['nodes'] as $node) {
            if (!is_array($node)) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_NODE');
            }
            self::fields(
                $node,
                ['id', 'type', 'title', 'description', 'provenance', 'priority', 'status', 'exclusion_reason', 'rationale', 'artifact', 'event'],
                ['id', 'type', 'title', 'description', 'provenance']
            );
            self::id($node['id']);
            self::choice($node['type'], self::TYPES);
            self::text($node['title'], 300);
            self::text($node['description'], 8000);
            self::list($node['provenance'], 20);
            if ($node['provenance'] === []) {
                throw new \InvalidArgumentException('TRACEABILITY_PROVENANCE_REQUIRED');
            }
            foreach ($node['provenance'] as $source) {
                self::text($source, 2000);
            }
            if (isset($nodes[$node['id']])) {
                throw new \InvalidArgumentException('DUPLICATE_TRACEABILITY_NODE');
            }
            $allowed = ['id', 'type', 'title', 'description', 'provenance'];
            if ($node['type'] === 'requirement') {
                $allowed = [...$allowed, 'priority', 'status', 'exclusion_reason'];
                self::choice($node['priority'] ?? null, ['must', 'should', 'could']);
                self::choice($node['status'] ?? null, ['ACTIVE', 'EXCLUDED']);
                if ($node['status'] === 'EXCLUDED') {
                    self::text($node['exclusion_reason'] ?? null, 4000);
                } elseif (array_key_exists('exclusion_reason', $node)) {
                    throw new \InvalidArgumentException('INVALID_TRACEABILITY_EXCLUSION');
                }
            } elseif ($node['type'] === 'decision') {
                $allowed = [...$allowed, 'rationale', 'status'];
                self::text($node['rationale'] ?? null, 8000);
                self::choice($node['status'] ?? null, ['OPEN', 'PROPOSED', 'RECORDED', 'SUPERSEDED']);
            } elseif (in_array($node['type'], self::MODEL_TYPES, true)) {
                $allowed[] = 'artifact';
                self::artifact($node['artifact'] ?? null, $node['type']);
            } else {
                $allowed[] = 'event';
                self::event($node['event'] ?? null);
            }
            self::fields($node, $allowed, []);
            $nodes[$node['id']] = $node;
        }
        ksort($nodes, SORT_STRING);
        $edges = [];
        $unique = [];
        foreach ($input['edges'] as $edge) {
            if (!is_array($edge)) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_EDGE');
            }
            self::fields($edge, ['from', 'to', 'relation', 'rationale', 'coverage'], ['from', 'to', 'relation', 'rationale']);
            self::id($edge['from']);
            self::id($edge['to']);
            self::text($edge['rationale'], 4000);
            self::choice($edge['relation'], ['motivates', 'justifies', 'satisfied_by', 'used_by', 'constrains', 'bound_by', 'validated_by', 'reviewed_by', 'supersedes']);
            if (!isset($nodes[$edge['from']], $nodes[$edge['to']]) || $edge['from'] === $edge['to']) {
                throw new \InvalidArgumentException('BROKEN_TRACEABILITY_EDGE');
            }
            $from = $nodes[$edge['from']]['type'];
            $to = $nodes[$edge['to']]['type'];
            $valid = match ($edge['relation']) {
                'motivates' => $from === 'requirement' && $to === 'decision',
                'justifies' => $from === 'decision' && in_array($to, self::MODEL_TYPES, true),
                'satisfied_by' => $from === 'requirement' && in_array($to, self::MODEL_TYPES, true),
                'used_by' => $from === 'archetype' && $to === 'template',
                'constrains' => $from === 'template' && $to === 'template_constraint',
                'bound_by' => in_array($from, ['archetype', 'template', 'template_constraint'], true) && $to === 'terminology_binding',
                'validated_by' => in_array($from, self::MODEL_TYPES, true) && $to === 'validation_evidence',
                'reviewed_by' => in_array($from, [...self::MODEL_TYPES, 'validation_evidence'], true) && $to === 'review',
                'supersedes' => $from === 'decision' && $to === 'decision',
                default => false,
            };
            if (!$valid) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_RELATION');
            }
            if ($edge['relation'] === 'satisfied_by') {
                self::choice($edge['coverage'] ?? null, ['full', 'partial']);
                if ($nodes[$edge['from']]['status'] === 'EXCLUDED') {
                    throw new \InvalidArgumentException('EXCLUDED_REQUIREMENT_HAS_COVERAGE');
                }
            } elseif (array_key_exists('coverage', $edge)) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_COVERAGE');
            }
            $key = $edge['from'] . "\n" . $edge['relation'] . "\n" . $edge['to'];
            if (isset($unique[$key])) {
                throw new \InvalidArgumentException('DUPLICATE_TRACEABILITY_EDGE');
            }
            $unique[$key] = $edge;
        }
        ksort($unique, SORT_STRING);
        $edges = array_values($unique);
        self::acyclic($nodes, $edges);
        $this->nodes = $nodes;
        $this->edges = $edges;
    }

    /**
     * @return array<string, mixed> */
    public function data(): array
    {
        return ['schema' => 1, 'nodes' => array_values($this->nodes), 'edges' => $this->edges];
    }

    /** Deterministic graph traversal; provenance text is never treated as a query or instruction.
     *
     * @param list<string>|null $relations
     *
     * @return list<string> */
    public function walk(string $start, bool $incoming, ?array $relations = null): array
    {
        if (!isset($this->nodes[$start])) {
            throw new \InvalidArgumentException('TRACEABILITY_NODE_NOT_FOUND');
        }
        $adjacent = [];
        foreach ($this->edges as $edge) {
            if ($relations !== null && !in_array($edge['relation'], $relations, true)) {
                continue;
            }
            $from = $incoming ? $edge['to'] : $edge['from'];
            $to = $incoming ? $edge['from'] : $edge['to'];
            $adjacent[$from][] = $to;
        }
        $seen = [$start => true];
        $queue = [$start];
        for ($i = 0; $i < count($queue); ++$i) {
            foreach ($adjacent[$queue[$i]] ?? [] as $to) {
                if (!isset($seen[$to])) {
                    $seen[$to] = true;
                    $queue[] = $to;
                }
            }
        }
        sort($queue, SORT_STRING);
        return $queue;
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     * @param list<string> $required */
    private static function fields(array $value, array $allowed, array $required): void
    {
        if (array_diff(array_keys($value), $allowed) !== [] || array_diff($required, array_keys($value)) !== []) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_FIELDS');
        }
    }
    private static function text(mixed $value, int $limit): void
    {
        if (!is_string($value) || trim($value) === '' || strlen($value) > $limit || preg_match('//u', $value) !== 1
            || preg_match('/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/', $value)) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_TEXT');
        }
    }
    private static function id(mixed $id): void
    {
        if (!is_string($id) || !preg_match('/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/D', $id)) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_ID');
        }
    }
    /**
     * @param list<string> $options */
    private static function choice(mixed $value, array $options): void
    {
        if (!in_array($value, $options, true)) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_CHOICE');
        }
    }
    private static function list(mixed $value, int $limit): void
    {
        if (!is_array($value) || !array_is_list($value) || count($value) > $limit) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_LIST');
        }
    }
    private static function artifact(mixed $artifact, string $type): void
    {
        if (!is_array($artifact)) {
            throw new \InvalidArgumentException('TRACEABILITY_ARTIFACT_REQUIRED');
        }
        self::fields($artifact, ['path', 'revision', 'sha256', 'anchor'], ['path', 'revision', 'sha256']);
        self::text($artifact['path'], 240);
        self::text($artifact['revision'], 200);
        if (!is_string($artifact['sha256']) || !preg_match('/^[a-f0-9]{64}$/D', $artifact['sha256'])) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_HASH');
        }
        $prefix = match ($type) {
            'archetype' => 'archetypes/', 'template', 'template_constraint' => 'templates/', 'terminology_binding' => 'terminology/', default => throw new \InvalidArgumentException('INVALID_TRACEABILITY_MODEL_TYPE')
        };
        if (!str_starts_with($artifact['path'], $prefix) || str_contains($artifact['path'], '..') || str_contains($artifact['path'], '\\')) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_ARTIFACT_PATH');
        }
        if (isset($artifact['anchor'])) {
            if (!is_array($artifact['anchor'])) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_ANCHOR');
            }
            self::fields($artifact['anchor'], ['kind', 'value'], ['kind', 'value']);
            self::choice($artifact['anchor']['kind'], ['xml_location', 'openehr_path', 'json_pointer']);
            self::text($artifact['anchor']['value'], 2000);
            if (!str_starts_with($artifact['anchor']['value'], '/')) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_ANCHOR');
            }
        }
        if ($type === 'template_constraint' && !isset($artifact['anchor'])) {
            throw new \InvalidArgumentException('TRACEABILITY_CONSTRAINT_ANCHOR_REQUIRED');
        }
    }
    private static function event(mixed $event): void
    {
        if (!is_array($event)) {
            throw new \InvalidArgumentException('TRACEABILITY_EVENT_REQUIRED');
        }
        self::fields($event, ['subject', 'sequence', 'hash'], ['subject', 'sequence', 'hash']);
        foreach (['subject', 'hash'] as $key) {
            if (!is_string($event[$key]) || !preg_match('/^[a-f0-9]{64}$/D', $event[$key])) {
                throw new \InvalidArgumentException('INVALID_TRACEABILITY_EVENT_HASH');
            }
        }
        if (!is_int($event['sequence']) || $event['sequence'] < 1 || $event['sequence'] > 256) {
            throw new \InvalidArgumentException('INVALID_TRACEABILITY_EVENT_SEQUENCE');
        }
    }
    /**
     * @param array<string, array<string, mixed>> $nodes
     * @param list<array<string, mixed>> $edges */
    private static function acyclic(array $nodes, array $edges): void
    {
        $degree = array_fill_keys(array_keys($nodes), 0);
        $next = [];
        foreach ($edges as $edge) {
            ++$degree[$edge['to']];
            $next[$edge['from']][] = $edge['to'];
        }
        $queue = array_keys(array_filter($degree, static fn (int $n): bool => $n === 0));
        $count = 0;
        for ($i = 0; $i < count($queue); ++$i) {
            ++$count;
            foreach ($next[$queue[$i]] ?? [] as $id) {
                if (--$degree[$id] === 0) {
                    $queue[] = $id;
                }
            }
        }
        if ($count !== count($nodes)) {
            throw new \InvalidArgumentException('TRACEABILITY_CYCLE');
        }
    }
}
