<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\ModelImports;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Tools\ModelImportTools;
use OpenEHR\Assistant\Validation\ArtifactTypeInspector;

trait ImportOutputCases
{
    private function importTools(): ModelImportTools
    {
        return new ModelImportTools(new ModelImports(
            $this->createStub(ModelRepository::class),
            new SqliteAuditStore(':memory:'),
            new Actor('fixture', 'shared', []),
            new AccessPolicy(new Settings()),
            new ArtifactTypeInspector()
        ));
    }
    public function test_model_import_inspect_result_matches_output_schema(): void
    {
        $this->assertConforms($this->importTools(), 'inspect', ['fixture.t.json', base64_encode('{"unknown": true}')]);
    }
    public function test_model_artifact_import_result_matches_output_schema(): void
    {
        $this->assertConforms($this->importTools(), 'import', ['default', 'fixture.t.json', base64_encode('{"unknown": true}')]);
    }
    public function test_model_artifact_provenance_result_matches_output_schema(): void
    {
        $this->assertConforms($this->importTools(), 'provenance', ['default', str_repeat('0', 64)]);
    }
}
