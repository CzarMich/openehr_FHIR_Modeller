<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\FhirModelling;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Standards\StandardsProvider;
use OpenEHR\Assistant\Integrations\Fhir\FhirConnections;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Tests\Application\FhirModellingTest;
use OpenEHR\Assistant\Tools\FhirTools;

trait FhirOutputCases
{
    private function fhirCase(string $method): void
    {
        $directory = sys_get_temp_dir() . '/fhir-output-' . bin2hex(random_bytes(8));
        try {
            $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
            $provider = $this->createStub(StandardsProvider::class);
            $provider->method('execute')->willReturn(['items' => [['resourceType' => 'StructureDefinition']], 'valid' => true]);
            $connection = $this->createStub(FhirConnections::class);
            $connection->method('get')->willReturn(['type' => 'ig', 'baseUrl' => 'https://ig.example']);
            $connection->method('test')->willReturn(['connected' => true]);
            $connection->method('summaries')->willReturn([['id' => 'dev-ig', 'type' => 'ig']]);
            $service = new FhirModelling(new FileSystemRepository($directory), new AccessPolicy($settings), $provider,
                new SqliteAuditStore(':memory:'), new Actor('test', 'shared', ['modeller']), $connection);
            $service->project('create', 'synthetic', json_encode(FhirModellingTest::config()));
            $args = match ($method) {
                'project' => ['get', 'synthetic'], 'compile', 'example' => ['synthetic', '{}'],
                'package' => ['search', 'synthetic'], 'artifact' => ['inspect', 'synthetic', '{"content":{}}'],
                'profile' => ['discover', 'synthetic'], 'fhirpath' => ['validate', 'synthetic'],
                'mapping' => ['list', 'synthetic'], 'connection' => ['list', 'synthetic'], 'ig' => ['test', 'synthetic'],
            };
            $tool = new FhirTools($service);
            self::assertTrue($tool->$method(...$args)['success']);
            $this->assertConforms($tool, $method, $args);
        } finally {
            if (is_dir($directory)) {
                $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
                foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
                rmdir($directory);
            }
        }
    }
    public function test_fhir_project_result_matches_output_schema(): void { $this->fhirCase('project'); }
    public function test_fhir_package_result_matches_output_schema(): void { $this->fhirCase('package'); }
    public function test_fhir_artifact_result_matches_output_schema(): void { $this->fhirCase('artifact'); }
    public function test_fhir_profile_result_matches_output_schema(): void { $this->fhirCase('profile'); }
    public function test_fhir_fhirpath_result_matches_output_schema(): void { $this->fhirCase('fhirpath'); }
    public function test_fhir_mapping_result_matches_output_schema(): void { $this->fhirCase('mapping'); }
    public function test_fhir_connection_result_matches_output_schema(): void { $this->fhirCase('connection'); }
    public function test_fhir_ig_result_matches_output_schema(): void { $this->fhirCase('ig'); }
    public function test_fhir_fsh_compile_result_matches_output_schema(): void { $this->fhirCase('compile'); }
    public function test_fhir_example_generate_result_matches_output_schema(): void { $this->fhirCase('example'); }
}
