<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\ArchetypeSource;
use OpenEHR\Assistant\Domain\Modelling\TemplateAuthoringService;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Domain\Modelling\Traceability;
use OpenEHR\Assistant\Domain\Terminology\BindingService;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use OpenEHR\Assistant\Tools\ModelService;
use OpenEHR\Assistant\Tools\ProjectService;
use OpenEHR\Assistant\Tools\TerminologyBindingService;
use OpenEHR\Assistant\Validation\ModelValidator;

trait EnterpriseOutputCases
{
    private function modelService(): ModelService
    {
        $source = $this->createStub(ArchetypeSource::class);
        $source->method('fetch')->willReturnCallback(static function (string $id): array {
            $rmClass = match (true) {
                str_contains($id, 'COMPOSITION') => 'COMPOSITION', str_contains($id, 'SECTION') => 'SECTION',
                str_contains($id, 'EVALUATION') => 'EVALUATION', str_contains($id, 'CLUSTER') => 'CLUSTER',
                default => 'OBSERVATION',
            };
            return ['id' => $id, 'rm_class' => $rmClass,
                'content' => 'fixture', 'provenance' => ['kind' => 'test_fixture']];
        });
        $validator = new ModelValidator();
        return new ModelService($validator, new TemplateAuthoringService($source, $validator), new QualityPipeline($validator));
    }

    private function projectService(): ProjectService
    {
        $repository = new FileSystemRepository(sys_get_temp_dir() . '/models-' . bin2hex(random_bytes(6)));
        $repository->createProject('test', 'Fixture', '');
        $repository->saveArtifact('test', 'requirements/test.json', '{"id":"REQ-1"}', [], null);
        return new ProjectService($repository, new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']), new Traceability());
    }

    public function test_model_project_qa_result_matches_output_schema(): void
    {
        $repository = new FileSystemRepository(sys_get_temp_dir() . '/qa-tools-' . bin2hex(random_bytes(6)));
        $repository->createProject('qa', 'Synthetic fixture', '');
        $repository->saveArtifact('qa', 'templates/fixture.oet', \OpenEHR\Assistant\Tests\Enterprise\ModelValidationTest::OET, [], null);
        $service = \OpenEHR\Assistant\Tests\Enterprise\ProjectQualityTest::service($repository);
        $this->assertConforms(new \OpenEHR\Assistant\Tools\QualityTools($service), 'evaluate', ['qa', 'templates/fixture.oet']);
    }

    private function bindingsService(): TerminologyBindingService
    {
        $provider = new FhirTerminologyProvider(new Settings());
        return new TerminologyBindingService($provider, new BindingService($provider));
    }

    private function localSet(): array
    {
        return ['id' => 'feeding', 'system' => 'https://example.org/local', 'version' => '1',
            'concepts' => [['code' => 'mixed', 'display' => 'Mixed']]];
    }

    public function test_model_validate_result_matches_output_schema(): void { $this->assertConforms($this->modelService(), 'validate', ['<a/>', 'xml']); }
    public function test_model_diff_result_matches_output_schema(): void { $this->assertConforms($this->modelService(), 'diff', ['<a/>', '<a min="1"/>']); }
    public function test_model_qa_result_matches_output_schema(): void { $this->assertConforms($this->modelService(), 'qa', ['<a/>', 'xml']); }
    public function test_template_build_oet_result_matches_output_schema(): void { $this->assertConforms($this->modelService(), 'buildOet', ['Fixture', 'openEHR-EHR-COMPOSITION.fixture.v1', ['openEHR-EHR-OBSERVATION.fixture.v1']]); }
    public function test_nested_template_build_oet_result_matches_output_schema(): void
    {
        $placements = [['id' => 'section', 'parent' => 'root', 'identifier' => 'openEHR-EHR-SECTION.fixture.v1', 'path' => '/content[at0001]'],
            ['id' => 'evaluation', 'parent' => 'section', 'identifier' => 'openEHR-EHR-EVALUATION.fixture.v1', 'path' => '/items[at0001]'],
            ['id' => 'cluster', 'parent' => 'evaluation', 'identifier' => 'openEHR-EHR-CLUSTER.fixture.v1', 'path' => '/data[at0001]/items[at0002]']];
        $this->assertConforms($this->modelService(), 'buildOet', ['Nested fixture', 'openEHR-EHR-COMPOSITION.fixture.v1', [], null, $placements]);
    }
    public function test_model_projects_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'projects', []); }
    public function test_model_project_get_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'get', ['test']); }
    public function test_model_project_create_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'create', ['other', 'Other']); }
    public function test_model_artifact_get_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'artifact', ['test', 'requirements/test.json']); }
    public function test_model_artifact_save_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'save', ['test', 'aql/test.aql', 'SELECT e/ehr_id/value FROM EHR e']); }
    public function test_model_artifact_history_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'history', ['test', 'requirements/test.json']); }
    public function test_model_requirements_coverage_result_matches_output_schema(): void { $this->assertConforms($this->projectService(), 'coverage', ['test', [['id' => 'REQ-1']], []]); }
    public function test_terminology_capabilities_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'capabilities', []); }
    public function test_terminology_lookup_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'lookup', ['https://example.org/local', 'mixed']); }
    public function test_terminology_validate_code_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'validateCode', ['https://example.org/local', 'mixed']); }
    public function test_terminology_expand_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'expand', ['https://example.org/valueset']); }
    public function test_terminology_translate_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'translate', ['https://example.org/map', 'https://example.org/system', 'x']); }
    public function test_terminology_resource_search_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'search', ['ValueSet']); }
    public function test_terminology_resource_get_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'resource', ['ValueSet', 'https://example.org/set']); }
    public function test_terminology_binding_validate_result_matches_output_schema(): void
    {
        $binding = ['id' => 'b', 'artifact' => 't', 'node' => '/data[at0001]', 'strength' => 'REQUIRED', 'value_set' => 'feeding', 'value_set_version' => '1', 'codes' => ['mixed']];
        $this->assertConforms($this->bindingsService(), 'validateBinding', [$binding, $this->localSet(), '<template><Rule path="/data[at0001]"/></template>']);
    }
    public function test_terminology_diff_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'diff', [$this->localSet(), $this->localSet()]); }
    public function test_terminology_manifest_result_matches_output_schema(): void { $this->assertConforms($this->bindingsService(), 'manifest', ['t', []]); }
}
