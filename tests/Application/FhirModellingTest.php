<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Application;

use OpenEHR\Assistant\Application\FhirModelling;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Standards\StandardsProvider;
use OpenEHR\Assistant\Integrations\Fhir\FhirConnections;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\ProjectScopedRepository;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\TestCase;

#[CoversClass(FhirModelling::class)]
final class FhirModellingTest extends TestCase
{
    private string $directory;
    private FileSystemRepository $repository;
    private SqliteAuditStore $audit;
    private StandardsProvider $provider;
    private FhirConnections $connections;

    public static function config(): array
    {
        return ['name' => 'Synthetic Dev', 'fhirVersion' => 'R4', 'canonical' => 'https://example.org/dev',
            'packageId' => 'org.example.dev', 'version' => '0.1.0', 'publisher' => 'Development test',
            'connections' => ['ig' => 'dev-ig']];
    }

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/fhir-test-' . bin2hex(random_bytes(8));
        $this->repository = new FileSystemRepository($this->directory);
        $this->audit = new SqliteAuditStore(':memory:');
        $this->provider = $this->createStub(StandardsProvider::class);
        $this->provider->method('execute')->willReturn(['valid' => true, 'resourceType' => 'StructureDefinition']);
        $this->connections = $this->createStub(FhirConnections::class);
        $this->connections->method('get')->willReturn(['type' => 'ig', 'baseUrl' => 'https://ig.example',
            'projectId' => '11111111-1111-1111-1111-111111111111', 'linkId' => '22222222-2222-2222-2222-222222222222']);
    }

    protected function tearDown(): void
    {
        if (!is_dir($this->directory)) { return; }
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
        rmdir($this->directory);
    }

    private function service(bool $write = true): FhirModelling
    {
        return new FhirModelling($this->repository, new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => $write ? 'true' : 'false'])),
            $this->provider, $this->audit, new Actor('verified-test-user', 'shared', ['modeller']), $this->connections);
    }

    private function project(): FhirModelling
    {
        $service = $this->service();
        $service->project('create', 'synthetic', json_encode(self::config(), JSON_THROW_ON_ERROR));
        return $service;
    }

    public function testProjectReleaseAndOptimisticRevisionAreEnforced(): void
    {
        $service = $this->project();
        $project = $service->project('get', 'synthetic');
        self::assertSame('4.0.1', $project['project']['fhirVersion']);
        $this->expectExceptionMessage('REVISION_CONFLICT');
        $service->project('update', 'synthetic', json_encode(self::config()), 'stale');
    }

    public function testReadOnlyUserCannotCreateOrSave(): void
    {
        $this->expectExceptionMessage('WRITES_DISABLED');
        $this->service(false)->project('create', 'synthetic', json_encode(self::config()));
    }

    public function testImportedOriginalCannotBeOverwrittenAsAuthored(): void
    {
        $service = $this->project();
        $saved = $service->operation('artifact', 'save', 'synthetic', json_encode(['path' => 'original.json', 'content' => '{"resourceType":"Patient"}', 'representation' => 'imported']));
        $this->expectExceptionMessage('FHIR_ORIGINAL_IMMUTABLE');
        $service->operation('artifact', 'save', 'synthetic', json_encode(['path' => 'original.json', 'content' => '{}', 'representation' => 'authored', 'expectedRevision' => $saved['revision']]));
    }

    public function testTraversalRejectedBeforeStorage(): void
    {
        $service = $this->project();
        $this->expectExceptionMessage('FHIR_ARTIFACT_PATH_INVALID');
        $service->operation('artifact', 'save', 'synthetic', '{"path":"../secret.json","content":"{}"}');
    }

    public function testReleaseCannotChangeAfterAuthoring(): void
    {
        $service = $this->project();
        $service->operation('artifact', 'save', 'synthetic', '{"path":"input/fsh/Patient.fsh","content":"Profile: SyntheticPatient\nParent: Patient"}');
        $current = $service->project('get', 'synthetic');
        $config = self::config(); $config['fhirVersion'] = 'R5';
        $this->expectExceptionMessage('FHIR_RELEASE_CHANGE_REQUIRES_NEW_PROJECT');
        $service->project('update', 'synthetic', json_encode($config), $current['revision']);
    }

    public function testMappingCannotClaimValidatedEquivalenceOrForgeActor(): void
    {
        $service = $this->project();
        $result = $service->operation('mapping', 'save', 'synthetic', json_encode(['id' => 'map-one',
            'source' => ['standard' => 'openEHR', 'artifact' => 'observation', 'version' => '1', 'path' => '/data'],
            'target' => ['standard' => 'FHIR', 'artifact' => 'Observation', 'version' => '4.0.1', 'path' => 'Observation.value[x]'],
            'relationship' => 'equivalent', 'validated' => true, 'author' => 'forged']));
        $mapping = json_decode($result['content'], true);
        self::assertFalse($mapping['validated']); self::assertSame('proposed', $mapping['status']);
        self::assertSame('verified-test-user', $mapping['author']);
        self::assertSame('mappings/map-one.json', $result['path']);
        self::assertCount(2, $this->audit->subjects('shared', 'synthetic'));
    }

    public function testInvalidArtefactNeverReachesIgServer(): void
    {
        $service = $this->project();
        $service->operation('artifact', 'save', 'synthetic', '{"path":"input/resources/profile.json","content":"{}"}');
        $this->provider = $this->createStub(StandardsProvider::class);
        $this->provider->method('execute')->willReturn(['valid' => false]);
        $this->connections = $this->createMock(FhirConnections::class);
        $this->connections->method('get')->willReturn(['type' => 'ig', 'baseUrl' => 'https://ig.example', 'projectId' => '11111111-1111-1111-1111-111111111111']);
        $this->connections->expects(self::never())->method('request');
        $this->expectExceptionMessage('FHIR_SUBMISSION_VALIDATION_REQUIRED');
        $this->service()->operation('ig', 'submit', 'synthetic', '{"paths":["input/resources/profile.json"]}');
    }

    public function testSyncUsesActualPullEndpointAndPinnedCommitWithoutPublication(): void
    {
        $this->project();
        $this->connections = $this->createMock(FhirConnections::class);
        $target = '11111111-1111-1111-1111-111111111111'; $link = '22222222-2222-2222-2222-222222222222';
        $this->connections->method('get')->willReturn(['type' => 'ig', 'baseUrl' => 'https://ig.example', 'projectId' => $target, 'linkId' => $link]);
        $sha = str_repeat('a', 40);
        $this->connections->expects(self::once())->method('request')->with('dev-ig', 'ig', 'POST', "/api/v1/projects/$target/git/$link/pull", ['commitSha' => $sha])->willReturn(['status' => 'completed', 'commitSha' => $sha]);
        $result = $this->service()->operation('ig', 'sync', 'synthetic', json_encode(['commitSha' => $sha]));
        self::assertSame('NOT_REQUESTED', $result['publication']);
    }

    /** @param list<string> $scopes */
    private function scopedService(array $scopes): FhirModelling
    {
        $principal = new Principal('scoped-user', hash('sha256', 'tenant'), [], $scopes);
        $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true', 'PROJECT_RBAC_ENABLED' => 'true',
            'AUTH_MODE' => 'oidc', 'OIDC_ISSUER' => 'https://identity.example/tenant', 'OIDC_AUDIENCE' => 'modelling-api',
            'OIDC_JWKS_URI' => 'https://identity.example/keys']);
        return new FhirModelling(new ProjectScopedRepository($this->repository, $principal), new AccessPolicy($settings, $principal),
            $this->provider, $this->audit, new Actor($principal->id, $principal->tenant, ['modeller']), $this->connections);
    }

    public function testProjectReadGrantCannotExecuteExternalMutations(): void
    {
        $this->project();
        $this->provider = $this->createMock(StandardsProvider::class);
        $this->provider->expects(self::never())->method('execute');
        $this->connections = $this->createMock(FhirConnections::class);
        $this->connections->expects(self::never())->method('get');
        $this->connections->expects(self::never())->method('request');
        $service = $this->scopedService(['modelling.write', 'project:synthetic:read']);
        self::assertSame('synthetic', $service->project('get', 'synthetic')['project']['id']);
        foreach ([['package', 'install'], ['ig', 'submit'], ['ig', 'sync'], ['artifact', 'save'], ['mapping', 'save']] as [$category, $action]) {
            try { $service->operation($category, $action, 'synthetic'); self::fail('Read grant performed a mutation.'); }
            catch (\RuntimeException $error) { self::assertSame('PROJECT_PERMISSION_REQUIRED', $error->getMessage()); }
        }
    }

    public function testCreationRequiresBothCreateAndNamedProjectWriteBeforeAllocation(): void
    {
        $service = $this->scopedService(['modelling.write', 'projects:create']);
        try { $service->project('create', 'fresh', json_encode(self::config())); self::fail('Creation should fail before allocation.'); }
        catch (\RuntimeException $error) { self::assertSame('PROJECT_PERMISSION_REQUIRED', $error->getMessage()); }
        self::assertSame([], $this->repository->listProjects());
        $service = $this->scopedService(['modelling.write', 'projects:create', 'project:fresh:write']);
        self::assertSame('fresh', $service->project('create', 'fresh', json_encode(self::config()))['project']['id']);
    }

    public function testProjectWriteGrantPermitsExactCommitHandoff(): void
    {
        $this->project();
        $sha = str_repeat('a', 40);
        $this->connections->method('request')->willReturn(['commitSha' => $sha, 'status' => 'completed']);
        $service = $this->scopedService(['modelling.write', 'project:synthetic:write']);
        self::assertSame('NOT_REQUESTED', $service->operation('ig', 'sync', 'synthetic', json_encode(['commitSha' => $sha]))['publication']);
    }

    public function testArtifactMetadataUsesActualNestedInspectionContract(): void
    {
        $this->project();
        $resource = ['resourceType' => 'StructureDefinition', 'id' => 'demo', 'url' => 'https://example.org/StructureDefinition/demo',
            'version' => '0.1.0', 'name' => 'Demo', 'kind' => 'resource', 'type' => 'Observation',
            'baseDefinition' => 'http://hl7.org/fhir/StructureDefinition/Observation', 'fhirVersion' => '4.0.1',
            'snapshot' => ['element' => [['path' => 'Observation', 'definition' => str_repeat('a', 70000)]]]];
        $this->provider = $this->createStub(StandardsProvider::class);
        $this->provider->method('execute')->willReturn(['kind' => 'Profile', 'resource' => $resource,
            'identity' => ['resourceType' => 'StructureDefinition', 'id' => 'demo', 'canonical' => $resource['url'], 'version' => '0.1.0']]);
        $saved = $this->service()->operation('artifact', 'save', 'synthetic', json_encode(['path' => 'profile.json', 'content' => json_encode($resource)]));
        self::assertSame($resource['url'], $saved['metadata']['inspection']['url']);
        self::assertSame('Profile', $saved['metadata']['inspection']['artifactKind']);
        self::assertSame('Observation', $saved['metadata']['inspection']['type']);
        self::assertSame('resource', $saved['metadata']['inspection']['kind']);
        self::assertArrayNotHasKey('snapshot', $saved['metadata']['inspection']);
        self::assertLessThan(65536, strlen(json_encode($saved['metadata'])));
        self::assertSame('inspected-not-validated', $saved['metadata']['inspectionStatus']);
    }

    public function testXmlImportPreservesExactUnvalidatedOriginalWithoutPretendingInspection(): void
    {
        $this->project();
        $this->provider = $this->createMock(StandardsProvider::class);
        $this->provider->expects(self::never())->method('execute');
        $source = "<?xml version=\"1.0\"?>\n<Patient xmlns=\"http://hl7.org/fhir\"><id value=\"synthetic\"/></Patient>\n";
        $saved = $this->service()->operation('artifact', 'save', 'synthetic', json_encode(['path' => 'input/resources/original.xml', 'content' => $source, 'format' => 'xml', 'representation' => 'imported']));
        self::assertSame($source, $saved['content']);
        self::assertSame(hash('sha256', $source), $saved['sha256']);
        self::assertSame('unsupported-original-preserved', $saved['metadata']['inspectionStatus']);
        self::assertFalse($saved['metadata']['clinicalApproval']);
        $this->expectExceptionMessage('FHIR_XML_ORIGINAL_IMPORT_ONLY');
        $this->service()->operation('artifact', 'save', 'synthetic', json_encode(['path' => 'other.xml', 'content' => $source, 'format' => 'xml', 'representation' => 'authored']));
    }

    public function testMappingPreventsChangingTheProjectRelease(): void
    {
        $service = $this->project();
        $service->operation('mapping', 'save', 'synthetic', json_encode(['id' => 'source-map',
            'source' => ['standard' => 'openEHR', 'artifact' => 'template', 'version' => '1', 'path' => '/data'],
            'target' => ['standard' => 'FHIR', 'artifact' => 'Observation', 'version' => '4.0.1', 'path' => 'Observation.value[x]'],
            'relationship' => 'conditional']));
        $current = $service->project('get', 'synthetic');
        $configuration = self::config(); $configuration['fhirVersion'] = 'R5';
        $this->expectExceptionMessage('FHIR_RELEASE_CHANGE_REQUIRES_NEW_PROJECT');
        $service->project('update', 'synthetic', json_encode($configuration), $current['revision']);
    }

    public function testOversizedProjectIdentifierFailsBeforeStorage(): void
    {
        $this->expectExceptionMessage('FHIR_IDENTIFIER_INVALID');
        $this->service()->project('create', str_repeat('a', 65), json_encode(self::config()));
    }
}
