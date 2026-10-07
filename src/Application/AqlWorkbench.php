<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

/** Deterministic assistance from the native parser and exact model input, without an AI provider. */
final readonly class AqlWorkbench
{
    public function __construct(private NativeModels $models) {}

    /**
     * @param list<array{identifier: string, content: string}> $templates
     * @return array<string, mixed> */
    public function explain(string $query, array $templates = []): array
    {
        $report = $this->models->validate($query, 'aql', $templates);
        if (($report['checks']['aql_syntax'] ?? '') !== 'PASS') { return ['validation' => $report, 'explanation' => 'Correct the syntax findings before interpreting this query.']; }
        $ast = $report['ast'];
        $references = ['aliases' => [], 'paths' => [], 'parameters' => []];
        $this->references($ast, $references);
        return ['validation' => $report, 'normalized_query' => $report['normalized_query'], 'references' => $references,
            'explanation' => 'SELECT chooses the returned values. FROM and CONTAINS select matching EHR/model structures.'
                . (isset($ast['where']) ? ' WHERE filters those matches.' : ' No WHERE filter is present.')
                . (!empty($ast['orderBy']) ? ' ORDER BY sorts the results.' : ' Result order is not specified.')
                . (isset($ast['limit']) ? ' LIMIT bounds the requested rows.' : ' The workspace supplies a bounded page size when running the query.'),
            'assumptions' => ['Path checks apply only to the exact supplied model versions.', 'A CDR may support a narrower AQL feature set.', 'Values, functions, terminology and clinical meaning require separate review.']];
    }

    /**
     * @param array<mixed> $node
     * @param array<string, list<mixed>> $references */
    private function references(array $node, array &$references): void
    {
        if (($node['_type'] ?? '') === 'IdentifiedPath') { $references['paths'][] = ($node['root'] ?? '') . '/' . ($node['path'] ?? ''); }
        if (($node['_type'] ?? '') === 'Containment') { $references['aliases'][] = array_intersect_key($node, array_flip(['type', 'identifier', 'predicates'])); }
        if (($node['_type'] ?? '') === 'QueryParameter') { $references['parameters'][] = $node['name'] ?? ''; }
        foreach ($node as $value) { if (is_array($value)) { $this->references($value, $references); } }
    }

    /**
     * @param array<mixed> $paths
     * @param list<array{identifier: string, content: string}> $dependencies
     * @return array<string, mixed> */
    public function generate(string $content, string $format, array $paths = [], array $dependencies = []): array
    {
        if (!in_array($format, ['opt14', 'opt2', 'adl2'], true) || !array_is_list($paths) || count($paths) > 30) { throw new \InvalidArgumentException('ENGINE_INVALID_QUERY_MODEL'); }
        $model = $this->models->inspect($content, $format, $dependencies);
        if (($model['valid'] ?? false) !== true) { return ['validation' => $model, 'query' => null]; }
        $candidates = $model['inspection']['paths'];
        $root = null;
        $allowed = [];
        foreach ($candidates as $candidate) {
            if ($candidate['path'] === '/') { $root = $candidate; }
            $allowed[$candidate['path']] = true;
        }
        if (!is_array($root) || !preg_match('/^[A-Z][A-Z0-9_]+$/D', $root['rm_type'])) { throw new \RuntimeException('ENGINE_MODEL_ROOT_UNSUPPORTED'); }
        $select = [];
        foreach ($paths as $path) {
            if (!is_string($path) || !isset($allowed[$path])) { throw new \InvalidArgumentException('ENGINE_QUERY_PATH_NOT_IN_MODEL'); }
            $select[] = 'm' . ($path === '/' ? '' : $path);
        }
        if ($select === []) { $select[] = 'm/name/value'; }
        $query = 'SELECT ' . implode(', ', $select) . ' FROM ' . $root['rm_type'] . ' m';
        $parameters = [];
        if ($root['rm_type'] === 'COMPOSITION' && $format !== 'adl2') {
            $query .= ' WHERE m/archetype_details/template_id/value = $template_id';
            $parameters['template_id'] = $model['identifier'];
        } elseif (is_string($root['archetype'] ?? null) && preg_match('/^openEHR-[A-Za-z0-9_.-]+$/D', $root['archetype'])) {
            $query .= '[' . $root['archetype'] . ']';
        }
        $query .= ' LIMIT 100';
        $validation = $this->models->validate($query, 'aql', $format === 'adl2' ? [] : [['identifier' => 'selected_model', 'content' => $content]]);
        return ['query' => $query, 'parameters' => (object) $parameters, 'source_sha256' => hash('sha256', $content),
            'inspection' => $model, 'validation' => $validation, 'assumptions' => ['Review the template identifier and selected fields before running.', 'This query has not been executed and does not establish clinical correctness.']];
    }
}
