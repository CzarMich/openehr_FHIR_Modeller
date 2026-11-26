<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Application;

use OpenEHR\Assistant\Application\MappingModelConfirmations;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(MappingModelConfirmations::class)]
final class MappingModelConfirmationsTest extends TestCase
{
    private string $directory;
    private FileSystemRepository $models;
    private FileSystemRepository $fhir;
    private SqliteAuditStore $audit;
    private array $bindings;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/mapping-confirmation-' . bin2hex(random_bytes(8));
        $this->models = new FileSystemRepository($this->directory . '/models');
        $this->fhir = new FileSystemRepository($this->directory . '/fhir');
        $this->audit = new SqliteAuditStore(':memory:');
        $this->models->createProject('lab-models', 'Synthetic models', 'Synthetic fixture');
        $this->fhir->createProject('lab-fhir', 'Synthetic profiles', 'Synthetic fixture');
        $template = $this->models->saveArtifact('lab-models', 'templates/lab.oet', '<template>synthetic-only</template>', [], null);
        $profile = $this->fhir->saveArtifact('lab-fhir', 'fhir/profile.json', '{"resourceType":"StructureDefinition","version":"1.0.0"}', [], null);
        $this->bindings = [];
        foreach ([['openEHR', 'lab-models', $template, 'agent-modelled'], ['FHIR', 'lab-fhir', $profile, 'externally-provided']] as [$standard, $project, $artifact, $origin]) {
            $this->bindings[] = ['standard' => $standard, 'projectId' => $project, 'path' => $artifact['path'],
                'revision' => $artifact['revision'], 'sha256' => $artifact['sha256'], 'version' => '1.0.0', 'origin' => $origin];
        }
    }

    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
        rmdir($this->directory);
    }

    private function service(bool $human = false, string $tenant = 'shared', bool $write = true): MappingModelConfirmations
    {
        $actor = new Actor($human ? 'reviewer' : 'agent', $tenant, ['modeller'], $human, $human ? 'interactive_local' : 'service');
        $identity = new Principal($actor->id, $tenant, $actor->roles, ['governance.write'], $human, 'interactive_oidc');
        return new MappingModelConfirmations($this->models, $this->fhir, $this->audit,
            new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => $write ? 'true' : 'false']), $identity), $actor);
    }

    public function testHumanSelectionCoversBothSuppliedModelsWithoutGrantingClinicalApproval(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        self::assertFalse($view['mappingConfirmed']);
        self::assertCount(2, $view['items']);
        self::assertStringContainsString('StructureDefinition', json_encode($view['items']));
        $confirmed = $this->service(true)->decide($view['subject'], 1, 'CONFIRMED', 'Both exact supplied models are appropriate for this mapping.');
        self::assertTrue($confirmed['mappingConfirmed']);
        self::assertFalse($confirmed['clinicalApproval']);
        self::assertTrue($confirmed['events'][1]['actor']['human']);
        self::assertSame('CONFIRMED', $this->service()->prepare('lab-fhir', array_reverse($this->bindings))['state']);
        self::assertFalse($this->service(true)->decide($view['subject'], 2, 'REVOKED', 'Withdraw this selection.')['mappingConfirmed']);
    }

    public function testAgentCannotConfirmEvenWhenItCanPrepareModels(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->expectExceptionMessage('GOVERNANCE_HUMAN_CONFIRMATION_REQUIRED');
        $this->service()->decide($view['subject'], 1, 'CONFIRMED', 'Claimed approval');
    }

    public function testReplayOfOldDecisionIsRejected(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->service(true)->decide($view['subject'], 1, 'CONFIRMED', 'Reviewed.');
        $this->expectExceptionMessage('GOVERNANCE_REVISION_CONFLICT');
        $this->service(true)->decide($view['subject'], 1, 'CONFIRMED', 'Replay.');
    }

    public function testChangedProfileInvalidatesPreviousConfirmation(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->service(true)->decide($view['subject'], 1, 'CONFIRMED', 'Reviewed.');
        $this->fhir->saveArtifact('lab-fhir', 'fhir/profile.json', '{"resourceType":"StructureDefinition","version":"2.0.0"}', [], $this->bindings[1]['revision']);
        self::assertFalse($this->service()->get($view['subject'])['mappingConfirmed']);
        $this->expectExceptionMessage('GOVERNANCE_SOURCE_CHANGED');
        $this->service(true)->decide($view['subject'], 2, 'CONFIRMED', 'Cannot confirm stale input.');
    }

    public function testChangedTemplateInvalidatesPreviousConfirmation(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->models->saveArtifact('lab-models', 'templates/lab.oet', '<template>changed</template>', [], $this->bindings[0]['revision']);
        self::assertFalse($this->service()->get($view['subject'])['current']);
        $this->expectExceptionMessage('GOVERNANCE_SOURCE_CHANGED');
        $this->service(true)->decide($view['subject'], 1, 'CONFIRMED', 'Stale.');
    }

    public function testAnotherTenantCannotReadOrConfirmRequest(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->expectExceptionMessage('GOVERNANCE_SUBJECT_NOT_FOUND');
        $this->service(true, str_repeat('a', 64))->get($view['subject']);
    }

    public function testCallerApprovalFlagsCannotBecomeEvidence(): void
    {
        $this->bindings[1]['approved'] = true;
        $this->expectExceptionMessage('MAPPING_MODEL_INVALID');
        $this->service()->prepare('lab-fhir', $this->bindings);
    }

    public function testForeignFhirProjectCannotBeBound(): void
    {
        $this->expectExceptionMessage('MAPPING_MODEL_PROJECT_MISMATCH');
        $this->service()->prepare('another-project', $this->bindings);
    }

    public function testBothStandardsAndDistinctModelsAreRequired(): void
    {
        $this->expectExceptionMessage('MAPPING_MODEL_DUPLICATE');
        $this->service()->prepare('lab-fhir', [$this->bindings[0], $this->bindings[0]]);
    }

    public function testWritesDisabledRejectsHumanDecision(): void
    {
        $view = $this->service()->prepare('lab-fhir', $this->bindings);
        $this->expectExceptionMessage('WRITES_DISABLED');
        $this->service(true, 'shared', false)->decide($view['subject'], 1, 'CONFIRMED', 'Reviewed.');
    }
}
