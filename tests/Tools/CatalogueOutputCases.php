<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\TerminologyCatalogue;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\LocalOperations;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use OpenEHR\Assistant\Tests\Enterprise\TerminologyCatalogueTest;
use OpenEHR\Assistant\Tools\TerminologyCatalogueTools;

trait CatalogueOutputCases
{
    private function catalogueTools(): TerminologyCatalogueTools
    {
        $repository = new FileSystemRepository(sys_get_temp_dir() . '/catalogue-schema-' . bin2hex(random_bytes(8)));
        $repository->createProject('test', 'Synthetic', ''); $external = new FhirTerminologyProvider(new Settings());
        $service = new TerminologyCatalogue($repository, new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true'])), $external, $external, new LocalOperations());
        foreach ([TerminologyCatalogueTest::codeSystem(), TerminologyCatalogueTest::valueSet(), TerminologyCatalogueTest::conceptMap()] as $record) { $service->save('test', $record); }
        return new TerminologyCatalogueTools($service);
    }

    public function test_terminology_catalogue_save_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'save', ['test', TerminologyCatalogueTest::codeSystem(['version' => 'cs-8'])]); }
    public function test_terminology_catalogue_get_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'get', ['test', 'code_system', TerminologyCatalogueTest::SYSTEM]); }
    public function test_terminology_catalogue_search_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'search', ['test']); }
    public function test_terminology_catalogue_lookup_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'lookup', ['test', TerminologyCatalogueTest::SYSTEM, 'mixed']); }
    public function test_terminology_catalogue_validate_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'validate', ['test', TerminologyCatalogueTest::SYSTEM, 'mixed']); }
    public function test_terminology_catalogue_expand_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'expand', ['test', TerminologyCatalogueTest::SET]); }
    public function test_terminology_catalogue_translate_result_matches_output_schema(): void { $this->assertConforms($this->catalogueTools(), 'translate', ['test', TerminologyCatalogueTest::MAP, TerminologyCatalogueTest::SYSTEM, 'mixed']); }
}
