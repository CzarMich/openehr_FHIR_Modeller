<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Domain\Traceability\Graph;
use OpenEHR\Assistant\Integrations\Traceability\ModelAnchorInspector;
use OpenEHR\Assistant\Validation\JsonDocument;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TraceabilityGraphTest extends TestCase
{
    public static function graph(?array $artifact = null): array
    {
        $artifact ??= ['path' => 'templates/synthetic.oet', 'revision' => 'revision-one', 'sha256' => str_repeat('a', 64)];
        $base = ['description' => 'Synthetic software fixture only.', 'provenance' => ['Synthetic requirements fixture; no clinical specification.']];
        return ['schema' => 1, 'nodes' => [
            ['id' => 'R-023', 'type' => 'requirement', 'title' => 'Record a synthetic coded element', 'priority' => 'must', 'status' => 'ACTIVE'] + $base,
            ['id' => 'D-1', 'type' => 'decision', 'title' => 'Use the retrieved source', 'status' => 'RECORDED', 'rationale' => 'Synthetic requirement maps to the explicit source rule.'] + $base,
            ['id' => 'T-1', 'type' => 'template', 'title' => 'Synthetic template', 'artifact' => $artifact] + $base,
            ['id' => 'C-1', 'type' => 'template_constraint', 'title' => 'Explicit rule', 'artifact' => $artifact + ['anchor' => ['kind' => 'xml_location', 'value' => '/1/1/1']]] + $base,
        ], 'edges' => [
            ['from' => 'R-023', 'to' => 'D-1', 'relation' => 'motivates', 'rationale' => 'Recorded requirement motivates this modelling choice.'],
            ['from' => 'D-1', 'to' => 'T-1', 'relation' => 'justifies', 'rationale' => 'The decision records why this model was selected.'],
            ['from' => 'T-1', 'to' => 'C-1', 'relation' => 'constrains', 'rationale' => 'The explicit rule belongs to this source.'],
            ['from' => 'R-023', 'to' => 'C-1', 'relation' => 'satisfied_by', 'coverage' => 'full', 'rationale' => 'Declared by the fixture; clinical meaning still requires independent review.'],
        ]];
    }

    public function test_typed_graph_provides_stable_directional_trails_independent_of_input_order(): void
    {
        $input = self::graph();
        $graph = new Graph($input);
        self::assertSame(['C-1', 'D-1', 'R-023', 'T-1'], $graph->walk('C-1', true));
        self::assertSame(['C-1', 'R-023'], $graph->walk('R-023', false, ['satisfied_by']));
        $input['nodes'] = array_reverse($input['nodes']);
        $input['edges'] = array_reverse($input['edges']);
        self::assertSame($graph->data(), (new Graph($input))->data());
    }

    public static function malformed(): array
    {
        $cases = [];
        $g = self::graph();
        $x = $g;
        $x['approved'] = true;
        $cases['forged authority'] = [$x];
        $x = $g;
        $x['nodes'][] = $x['nodes'][0];
        $cases['duplicate identifier'] = [$x];
        $x = $g;
        $x['nodes'][0]['provenance'] = [];
        $cases['missing provenance'] = [$x];
        $x = $g;
        $x['nodes'][1]['rationale'] = '';
        $cases['missing rationale'] = [$x];
        $x = $g;
        $x['nodes'][0]['artifact'] = $x['nodes'][2]['artifact'];
        $cases['wrong node fields'] = [$x];
        $x = $g;
        unset($x['nodes'][3]['artifact']['anchor']);
        $cases['constraint has no location'] = [$x];
        $x = $g;
        $x['nodes'][2]['artifact']['path'] = 'templates/../../secret';
        $cases['path traversal'] = [$x];
        $x = $g;
        $x['nodes'][2]['artifact']['sha256'] = 'invented';
        $cases['invalid hash'] = [$x];
        $x = $g;
        $x['nodes'][2]['artifact']['revision'] = "bad\0";
        $cases['control character'] = [$x];
        $x = $g;
        $x['edges'][0]['to'] = 'missing';
        $cases['dangling edge'] = [$x];
        $x = $g;
        $x['edges'][0]['relation'] = 'validated_by';
        $cases['invalid type relationship'] = [$x];
        $x = $g;
        $x['edges'][] = $x['edges'][0];
        $cases['duplicate edge'] = [$x];
        $x = $g;
        $x['edges'][3]['coverage'] = 'approved';
        $cases['invalid coverage'] = [$x];
        $x = $g;
        $x['nodes'][0]['status'] = 'EXCLUDED';
        $cases['missing exclusion reason'] = [$x];
        $x['nodes'][0]['exclusion_reason'] = 'Explicitly out of scope.';
        $cases['excluded yet covered'] = [$x];
        $x = $g;
        $x['nodes'][] = array_replace($x['nodes'][1], ['id' => 'D-2']);
        foreach ([['D-1','D-2'],['D-2','D-1']] as [$from,$to]) {
            $x['edges'][] = ['from' => $from,'to' => $to,'relation' => 'supersedes','rationale' => 'Invalid circular decisions.'];
        }
        $cases['cycle'] = [$x];
        $x = $g;
        $x['nodes'] = array_fill(0, 501, $g['nodes'][0]);
        $cases['node limit'] = [$x];
        $x = $g;
        $x['edges'] = array_fill(0, 2001, $g['edges'][0]);
        $cases['edge limit'] = [$x];
        $x = $g;
        $x['nodes'][0]['description'] = str_repeat('x', 8001);
        $cases['text limit'] = [$x];
        return $cases;
    }
    #[DataProvider('malformed')]
    public function test_invalid_or_ambiguous_graphs_fail_closed(array $graph): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Graph($graph);
    }

    public static function pointers(): array
    {
        return [
            ['{"a/b":{"~key":[null,7]}}', '/a~1b/~0key/0', 'RESOLVED'],
            ['{"~1":true}', '/~01', 'RESOLVED'],
            ['{"":null}', '/', 'RESOLVED'],
            ['{"01":"object member"}', '/01', 'RESOLVED'],
            ['["first"]', '/01', 'INVALID'], ['["first"]', '/-', 'INVALID'],
            ['["first"]', '/999999999999999999999999999', 'INVALID'],
            ['{"a":1}', '/missing', 'INVALID'], ['{"a":1}', '/~2', 'INVALID'],
            ['{"a":1,"a":2}', '/a', 'INVALID'], ['{"a":1,"\\u0061":2}', '/a', 'INVALID'],
            ['{"x":{"a":1},"y":{"a":2}}', '/y/a', 'RESOLVED'],
            ['{"payload":"{\\"a\\":1,\\"a\\":2}"}', '/payload', 'RESOLVED'],
            ['{broken', '/a', 'INVALID'], ['{"a":[]}', '#/a', 'INVALID'],
        ];
    }
    #[DataProvider('pointers')]
    public function test_json_pointer_checks_objects_arrays_escaping_duplicates_and_missing_values(string $content, string $pointer, string $status): void
    {
        $result = (new ModelAnchorInspector())->inspect($content, ['kind' => 'json_pointer', 'value' => $pointer]);
        self::assertSame($status, $result['status']);
    }
    public function test_xml_locations_do_not_execute_xpath_or_claim_native_path_resolution(): void
    {
        $inspector = new ModelAnchorInspector();
        self::assertSame('RESOLVED', $inspector->inspect(TerminologyBindingPlanTest::MODEL, ['kind' => 'xml_location','value' => '/1/1/1'])['status']);
        self::assertSame('INVALID', $inspector->inspect(TerminologyBindingPlanTest::MODEL, ['kind' => 'xml_location','value' => '//Rule'])['status']);
        self::assertSame('INVALID', $inspector->inspect('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', ['kind' => 'xml_location','value' => '/1'])['status']);
        self::assertSame('NOT_EXECUTED', $inspector->inspect('archetype', ['kind' => 'openehr_path','value' => '/data[at0001]'])['status']);
        $this->expectExceptionMessage('JSON_DOCUMENT_TOO_LARGE');
        JsonDocument::parse(str_repeat(' ', 2097153));
    }
}
