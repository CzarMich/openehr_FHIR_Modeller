<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Tests\Enterprise\TerminologyBindingPlanTest;
use OpenEHR\Assistant\Tools\TerminologyBindingTools;

trait BindingPlanOutputCases
{
    private function bindingPlanTools(): array
    {
        $repository = new FileSystemRepository(sys_get_temp_dir() . '/binding-schema-' . bin2hex(random_bytes(8)));
        $repository->createProject('test', 'Synthetic', '');
        $source = $repository->saveArtifact('test', 'templates/test.oet', TerminologyBindingPlanTest::MODEL, [], null);
        return [new TerminologyBindingTools(TerminologyBindingPlanTest::service($repository)), $source['revision']];
    }
    public function test_model_terminology_inspect_result_matches_output_schema(): void { [$tool] = $this->bindingPlanTools(); $this->assertConforms($tool, 'inspect', ['test', 'templates/test.oet']); }
    public function test_terminology_binding_plan_result_matches_output_schema(): void { [$tool] = $this->bindingPlanTools(); $this->assertConforms($tool, 'plan', ['test', 'templates/test.oet']); }
    public function test_terminology_binding_plan_save_result_matches_output_schema(): void { [$tool, $revision] = $this->bindingPlanTools(); $this->assertConforms($tool, 'save', ['test', 'templates/test.oet', $revision]); }
    public function test_terminology_binding_plan_get_result_matches_output_schema(): void
    {
        [$tool, $revision] = $this->bindingPlanTools(); $tool->save('test', 'templates/test.oet', $revision);
        $this->assertConforms($tool, 'get', ['test', 'templates/test.oet']);
    }
}
