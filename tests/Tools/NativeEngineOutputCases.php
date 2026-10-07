<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Tools\NativeEngineTools;

trait NativeEngineOutputCases
{
    private function nativeTools(): NativeEngineTools
    {
        $port = $this->createStub(OpenEhrEngine::class);
        $port->method('validate')->willReturn(['valid' => true, 'status' => 'PASS']);
        $port->method('compile')->willReturn(['valid' => true, 'status' => 'PASS']);
        $port->method('inspect')->willReturn(['valid' => true, 'status' => 'PASS']);
        return new NativeEngineTools(new NativeModels($port));
    }
    public function test_archetype_validate_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'archetype', ['synthetic']);
    }
    public function test_template_validate_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'template', ['synthetic']);
    }
    public function test_template_compile_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'compile', ['synthetic']);
    }
    public function test_opt_validate_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'opt', ['synthetic']);
    }
    public function test_model_inspect_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'inspect', ['synthetic', 'adl2']);
    }
    public function test_template_compile_project_result_matches_output_schema(): void
    {
        $port = $this->createStub(OpenEhrEngine::class);
        $repository = $this->createStub(\OpenEHR\Assistant\Domain\Repository\ModelRepository::class);
        $service = new \OpenEHR\Assistant\Application\TemplateBuilds(
            new NativeModels($port),
            $repository,
            new \OpenEHR\Assistant\Auth\AccessPolicy(new \OpenEHR\Assistant\Configuration\Settings()),
            new \OpenEHR\Assistant\Domain\Governance\Actor('fixture', 'shared', [])
        );
        $this->assertConforms(new \OpenEHR\Assistant\Tools\TemplateBuildTools($service), 'compile', ['default', 'templates/model.adlt', 'revision']);
    }
    public function test_aql_validate_result_matches_output_schema(): void
    {
        $this->assertConforms($this->nativeTools(), 'aql', ['synthetic']);
    }
}
