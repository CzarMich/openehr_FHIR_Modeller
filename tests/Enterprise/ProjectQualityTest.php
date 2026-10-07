<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Application\ProjectQuality;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Governance\PreflightValidation;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use OpenEHR\Assistant\Integrations\Terminology\XmlTerminologyInspector;
use OpenEHR\Assistant\Validation\ModelValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ProjectQualityTest extends TestCase
{
    private array $directories = [];

    protected function tearDown(): void
    {
        foreach ($this->directories as $path) {
            if (!is_dir($path)) {
                continue;
            }
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($iterator as $file) {
                $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
            }
            rmdir($path);
        }
    }

    public static function providers(): array
    {
        return [['filesystem'], ['git'], ['sharepoint']];
    }

    private function repository(string $provider): ModelRepository
    {
        $path = sys_get_temp_dir() . '/project-qa-' . bin2hex(random_bytes(8));
        $this->directories[] = $path;
        if ($provider === 'git') {
            $r = new GitModelRepository(new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $path]));
        } elseif ($provider === 'sharepoint') {
            $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'sharepoint', 'SHAREPOINT_SITE_ID' => 'site', 'SHAREPOINT_LIST_ID' => 'list', 'SHAREPOINT_DRIVE_ID' => 'drive', 'SHAREPOINT_FOLDER_ID' => 'folder', 'SHAREPOINT_ACCESS_TOKEN' => 'fixture-token']);
            $r = new SharePointRepository($settings, new GraphClient($settings, new ConfiguredAccessToken('fixture-token'), (new SharePointGraphFixture())->client()));
        } else {
            $r = new FileSystemRepository($path);
        }
        $r->createProject('project', 'Synthetic QA', 'No clinical specification.');
        return $r;
    }

    public static function service(ModelRepository $repository, ?SqliteAuditStore $audit = null, string $tenant = 'shared'): ProjectQuality
    {
        return new ProjectQuality(
            $repository,
            new QualityPipeline(new ModelValidator()),
            ProjectTraceabilityTest::service($repository, $audit, false, $tenant),
            new XmlTerminologyInspector()
        );
    }

    private function graph(array $source): array
    {
        $graph = TraceabilityGraphTest::graph(array_reverse(array_intersect_key($source, array_flip(['path', 'revision', 'sha256']))));
        $graph['nodes'][3]['artifact']['anchor']['value'] = '/1/3/1/1';
        return $graph;
    }

    private function canonicalEvidence(array $value): array
    {
        if (!array_is_list($value)) { ksort($value); }
        foreach ($value as &$item) { if (is_array($item)) { $item = $this->canonicalEvidence($item); } }
        return $value;
    }

    #[DataProvider('providers')]
    public function test_repository_contract_inspects_exact_sources_and_evidence_without_writes(string $provider): void
    {
        $repository = $this->repository($provider);
        $source = $repository->saveArtifact('project', 'templates/synthetic.oet', ModelValidationTest::OET, [], null);
        $service = self::service($repository);
        $first = $service->evaluate('project', $source['path']);
        self::assertSame('FAIL', $first['status']);
        self::assertContains('MISSING_PROVENANCE', array_column($first['findings'], 'code'));
        self::assertContains('MISSING_OR_INVALID_TRACEABILITY', array_column($first['findings'], 'code'));
        self::assertFalse($first['release_eligible']);
        self::assertSame($source, $repository->getArtifact('project', $source['path']));

        $source = $repository->saveArtifact('project', $source['path'], $source['content'], ['provenance' => ['origin' => 'Synthetic source; no clinical meaning.']], $source['revision']);
        $audit = new SqliteAuditStore(':memory:');
        $trace = ProjectTraceabilityTest::service($repository, $audit);
        $graph = $this->graph($source);
        $trace->save('project', $graph);
        $service = self::service($repository, $audit);
        $linked = $service->evaluate('project', $source['path']);
        self::assertNotContains('MISSING_REQUIREMENT_TRACEABILITY', array_column($linked['findings'], 'code'));
        self::assertContains('MISSING_VALIDATION_EVIDENCE', array_column($linked['findings'], 'code'));

        $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $governance = new ModelGovernance($repository, $audit, new ReviewPolicy(), new PreflightValidation(new QualityPipeline(new ModelValidator())), new AccessPolicy($settings), new Actor('agent', 'shared', ['modeller']));
        $view = $governance->prepare('project', $source['path'], $source['revision'], 'Synthetic source only.');
        $view = $governance->validate($view['subject'], $view['sequence']);
        $event = $view['events'][1];
        $graph['nodes'][] = ['id' => 'V-1', 'type' => 'validation_evidence', 'title' => 'Actual test pipeline event', 'description' => 'Authentic incomplete validation.', 'provenance' => ['Synthetic audit ledger.'],
            'event' => ['subject' => $view['subject'], 'sequence' => $event['sequence'], 'hash' => $event['hash']]];
        $graph['edges'][] = ['from' => 'C-1', 'to' => 'V-1', 'relation' => 'validated_by', 'rationale' => 'Actual exact-source pipeline run.'];
        $trace->save('project', $graph, $trace->get('project')['artifact']['revision']);
        $result = $service->evaluate('project', $source['path']);
        self::assertSame('INCOMPLETE', $result['status']);
        self::assertContains('VALIDATION_NOT_QUALIFIED', array_column($result['findings'], 'code'));
        self::assertFalse($result['clinical_approval']);
        self::assertSame($source, $repository->getArtifact('project', $source['path']));
        self::assertFalse($result['model_changed']);
        self::assertSame('VERIFIED', $result['traceability']['validation_events']['V-1']['status']);

        $wrongTenant = self::service($repository, $audit, str_repeat('b', 64))->evaluate('project', $source['path']);
        self::assertContains('MISSING_VALIDATION_EVIDENCE', array_column($wrongTenant['findings'], 'code'));
        self::assertSame([], $wrongTenant['traceability']['validation_events']);
        $repository->saveArtifact('project', $source['path'], str_replace('Test', 'New test', $source['content']), $source['metadata'], $source['revision']);
        $historical = $service->evaluate('project', $source['path'], $source['revision']);
        self::assertContains('REPOSITORY_REVISION_CONFLICT', array_column($historical['findings'], 'code'));
        self::assertSame('FAIL', $historical['status']);
    }

    public function test_empty_claims_and_corrupt_or_missing_evidence_do_not_pass(): void
    {
        $repository = $this->repository('filesystem');
        $source = $repository->saveArtifact('project', 'templates/synthetic.oet', ModelValidationTest::OET, ['provenance' => [null, false, ' ']], null);
        $repository->saveArtifact('project', 'requirements/traceability.json', '{"schema":1,"schema":2}', [], null);
        $result = self::service($repository)->evaluate('project', $source['path']);
        self::assertContains('MISSING_PROVENANCE', array_column($result['findings'], 'code'));
        self::assertContains('MISSING_OR_INVALID_TRACEABILITY', array_column($result['findings'], 'code'));
        $project = $repository->getProject('project');
        $repository->archiveProject('project', $project['revision']);
        self::assertContains('PROJECT_ARCHIVED', array_column(self::service($repository)->evaluate('project', $source['path'])['findings'], 'code'));
    }

    public function test_untrusted_paths_and_unknown_formats_are_rejected(): void
    {
        $repository = $this->repository('filesystem');
        $repository->saveArtifact('project', 'templates/source.json', '{}', [], null);
        $service = self::service($repository);
        foreach (['../../private.env', '/etc/passwd', 'https://example.org/source'] as $path) {
            try {
                $service->evaluate('project', $path);
                self::fail('Invalid source path was accepted.');
            } catch (\InvalidArgumentException) {
                self::assertTrue(true);
            }
        }
        $this->expectException(\InvalidArgumentException::class);
        $service->evaluate('project', 'templates/source.json', null, 'execute');
    }

    public function test_a_binding_validation_event_does_not_replace_model_validation(): void
    {
        $repository = $this->repository('filesystem');
        $source = $repository->saveArtifact('project', 'templates/synthetic.oet', ModelValidationTest::OET, ['provenance' => 'Synthetic source.'], null);
        $binding = $repository->saveArtifact('project', 'terminology/binding.xml', '<binding/>', [], null);
        $audit = new SqliteAuditStore(':memory:');
        $settings = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $governance = new ModelGovernance($repository, $audit, new ReviewPolicy(), new PreflightValidation(new QualityPipeline(new ModelValidator())), new AccessPolicy($settings), new Actor('agent', 'shared', ['modeller']));
        $view = $governance->prepare('project', $binding['path'], $binding['revision'], 'Synthetic binding only.');
        $view = $governance->validate($view['subject'], $view['sequence']);
        $event = $view['events'][1];
        $graph = $this->graph($source);
        $base = ['description' => 'Synthetic separate binding evidence.', 'provenance' => ['Fixture.']];
        $graph['nodes'][] = ['id' => 'B-1', 'type' => 'terminology_binding', 'title' => 'Separate binding', 'artifact' => array_intersect_key($binding, array_flip(['path', 'revision', 'sha256']))] + $base;
        $graph['nodes'][] = ['id' => 'V-1', 'type' => 'validation_evidence', 'title' => 'Binding checks', 'event' => ['subject' => $view['subject'], 'sequence' => $event['sequence'], 'hash' => $event['hash']]] + $base;
        $graph['edges'][] = ['from' => 'T-1', 'to' => 'B-1', 'relation' => 'bound_by', 'rationale' => 'Explicit fixture association.'];
        $graph['edges'][] = ['from' => 'B-1', 'to' => 'V-1', 'relation' => 'validated_by', 'rationale' => 'Checks ran for the binding only.'];
        ProjectTraceabilityTest::service($repository, $audit)->save('project', $graph);
        $result = self::service($repository, $audit)->evaluate('project', $source['path']);
        self::assertContains('MISSING_VALIDATION_EVIDENCE', array_column($result['findings'], 'code'));
        self::assertSame([], $result['traceability']['validation_events']);
        self::assertContains('V-1', $result['traceability']['linked_nodes']);
    }

    #[DataProvider('providers')]
    public function test_project_qa_verifies_saved_build_source_output_and_dependency_revisions(string $provider): void
    {
        $repository = $this->repository($provider);
        $source = $repository->saveArtifact('project', 'templates/model.oet', ModelValidationTest::OET,
            ['provenance' => ['origin' => 'synthetic fixture']], null);
        $dependencyContent = 'synthetic exact ADL dependency';
        $dependency = $repository->saveArtifact('project', 'archetypes/root.adl', $dependencyContent, [], null);
        $output = '<template xmlns="http://schemas.openehr.org/v1"/>';
        $engine = ['adapter' => '1.0.0', 'archie' => '3.20.0', 'aql' => '2.35.0'];
        $report = ['operation' => 'compile/template', 'content_sha256' => $source['sha256'], 'valid' => true, 'status' => 'PASS',
            'profile' => 'OET14_COMPILATION_RM_STRUCTURE', 'checks' => ['oet_application' => 'PASS', 'rm_structure_profile' => 'PASS', 'full_aom_semantics' => 'NOT_EXECUTED'],
            'limitations' => ['Bounded synthetic profile only.'], 'engine' => $engine,
            'dependencies' => [['identifier' => 'root.v1', 'sha256' => $dependency['sha256']]]];
        $manifest = [['identifier' => 'root.v1'] + array_intersect_key($dependency, array_flip(['path', 'revision', 'sha256', 'provider']))];
        $identity = ['schema' => 1, 'project' => 'project', 'source' => array_intersect_key($source, array_flip(['path', 'revision', 'sha256', 'provider'])),
            'dependencies' => $manifest, 'engine' => $engine, 'output_sha256' => hash('sha256', $output)];
        $build = $identity + ['id' => hash('sha256', json_encode($this->canonicalEvidence($identity), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)),
            'format' => 'opt14_xml', 'report' => $report];
        $artifact = $repository->saveArtifact('project', 'templates/opt/synthetic.opt', $output,
            ['kind' => 'compiled_opt14', 'build' => $build], null);

        $result = self::service($repository)->evaluate('project', $source['path'], $source['revision']);
        $checks = array_column($result['checks'], null, 'name');
        self::assertSame('PASS', $checks['native_build_evidence']['status']);
        self::assertSame('PASS', $checks['pinned_dependency_integrity']['status']);
        self::assertSame('NOT_EXECUTED', $checks['dependency_versions']['status']);
        self::assertSame($artifact['sha256'], $checks['native_build_evidence']['builds'][0]['artifact']['sha256']);
        self::assertSame('NOT_EXECUTED', $report['checks']['full_aom_semantics']);
        self::assertFalse($result['release_eligible']);
        self::assertFalse($result['clinical_approval']);

        $nextSource = $repository->saveArtifact('project', $source['path'], $source['content'] . "\n", $source['metadata'], $source['revision']);
        $identity['source'] = array_intersect_key($nextSource, array_flip(['path', 'revision', 'sha256', 'provider']));
        $nextBuild = $identity + $build;
        $nextBuild['id'] = hash('sha256', json_encode($this->canonicalEvidence($identity), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        $nextBuild['report']['content_sha256'] = $nextSource['sha256'];
        $next = $repository->saveArtifact('project', $artifact['path'], $output, ['kind' => 'compiled_opt14', 'build' => $nextBuild], $artifact['revision']);
        $historical = self::service($repository)->evaluate('project', $source['path'], $source['revision']);
        $evidence = array_column($historical['checks'], null, 'name')['native_build_evidence'];
        self::assertSame('PASS', $evidence['status']);
        self::assertSame($artifact['revision'], $evidence['builds'][0]['artifact']['revision']);
        self::assertNotSame($next['revision'], $artifact['revision']);
    }

    #[DataProvider('providers')]
    public function test_project_qa_rejects_tampered_native_build_output(string $provider): void
    {
        $repository = $this->repository($provider);
        $source = $repository->saveArtifact('project', 'templates/model.oet', ModelValidationTest::OET,
            ['provenance' => ['origin' => 'synthetic fixture']], null);
        $engine = ['adapter' => '1.0.0', 'archie' => '3.20.0', 'aql' => '2.35.0'];
        $output = '<template/>';
        $identity = ['schema' => 1, 'project' => 'project', 'source' => array_intersect_key($source, array_flip(['path', 'revision', 'sha256', 'provider'])),
            'dependencies' => [], 'engine' => $engine, 'output_sha256' => hash('sha256', $output)];
        $build = $identity + ['id' => hash('sha256', json_encode($this->canonicalEvidence($identity), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)),
            'format' => 'opt14_xml', 'report' => ['operation' => 'compile/template', 'content_sha256' => $source['sha256'], 'valid' => true, 'status' => 'PASS',
                'profile' => 'OET14_COMPILATION_RM_STRUCTURE', 'checks' => [], 'limitations' => [], 'engine' => $engine, 'dependencies' => []]];
        $artifact = $repository->saveArtifact('project', 'templates/compiled/tampered.opt', $output, ['kind' => 'compiled_opt14', 'build' => $build], null);
        $repository->saveArtifact('project', $artifact['path'], 'modified derived output', $artifact['metadata'], $artifact['revision']);
        $result = self::service($repository)->evaluate('project', $source['path'], $source['revision']);
        $checks = array_column($result['checks'], null, 'name');
        self::assertSame('FAIL', $checks['native_build_evidence']['status']);
        self::assertContains('NATIVE_BUILD_EVIDENCE_INVALID', array_column($result['findings'], 'code'));
        self::assertFalse($result['release_eligible']);
    }
}
