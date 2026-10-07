<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Tests\Enterprise\ProjectTraceabilityTest;
use OpenEHR\Assistant\Tests\Enterprise\TerminologyBindingPlanTest;
use OpenEHR\Assistant\Tests\Enterprise\TraceabilityGraphTest;
use OpenEHR\Assistant\Tools\TraceabilityTools;

trait TraceabilityOutputCases
{
    private function traceabilityTools(bool $save = true): array
    {
        $repository = new FileSystemRepository(sys_get_temp_dir().'/traceability-schema-'.bin2hex(random_bytes(8)));
        $repository->createProject('project', 'Synthetic traceability', '');
        $source = $repository->saveArtifact('project', 'templates/synthetic.oet', TerminologyBindingPlanTest::MODEL, [], null);
        $graph = TraceabilityGraphTest::graph(array_intersect_key($source, array_flip(['path','revision','sha256'])));
        $service = ProjectTraceabilityTest::service($repository);
        if ($save) {
            $service->save('project', $graph);
        }
        return [new TraceabilityTools($service),$graph];
    }
    public function test_model_traceability_save_result_matches_output_schema(): void
    {
        [$tool,$graph] = $this->traceabilityTools(false);
        $this->assertConforms($tool, 'save', ['project',$graph]);
    }
    public function test_model_traceability_get_result_matches_output_schema(): void
    {
        [$tool] = $this->traceabilityTools();
        $this->assertConforms($tool, 'get', ['project']);
    }
    public function test_model_traceability_explain_result_matches_output_schema(): void
    {
        [$tool] = $this->traceabilityTools();
        $this->assertConforms($tool, 'explain', ['project','C-1']);
    }
    public function test_model_traceability_requirement_result_matches_output_schema(): void
    {
        [$tool] = $this->traceabilityTools();
        $this->assertConforms($tool, 'requirement', ['project','R-023']);
    }
}
