<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Application\ProjectTraceability;
use OpenEHR\Assistant\Application\TraceabilityEvidence;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Traceability\Graph;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Governance\PreflightValidation;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use OpenEHR\Assistant\Integrations\Traceability\ModelAnchorInspector;
use OpenEHR\Assistant\Validation\ModelValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ProjectTraceabilityTest extends TestCase
{
    private array $directories = [];
    private SqliteAuditStore $audit;
    protected function setUp(): void
    {
        $this->audit = new SqliteAuditStore(':memory:');
    }
    protected function tearDown(): void
    {
        foreach ($this->directories as $directory) {
            if (!is_dir($directory)) {
                continue;
            }
            $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($files as $file) {
                $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
            } rmdir($directory);
        }
    }
    public static function providers(): array
    {
        return [['filesystem'], ['git'], ['sharepoint']];
    }
    private function repository(string $provider = 'filesystem'): ModelRepository
    {
        $path = sys_get_temp_dir() . '/traceability-' . bin2hex(random_bytes(8));
        $this->directories[] = $path;
        if ($provider === 'git') {
            $r = new GitModelRepository(new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git','MODEL_REPOSITORY_PATH' => $path]));
        } elseif ($provider === 'sharepoint') {
            $s = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'sharepoint','SHAREPOINT_SITE_ID' => 'site','SHAREPOINT_LIST_ID' => 'list','SHAREPOINT_DRIVE_ID' => 'drive','SHAREPOINT_FOLDER_ID' => 'folder','SHAREPOINT_ACCESS_TOKEN' => 'fixture-token']);
            $r = new SharePointRepository($s, new GraphClient($s, new ConfiguredAccessToken('fixture-token'), (new SharePointGraphFixture())->client()));
        } else {
            $r = new FileSystemRepository($path);
        }
        $r->createProject('project', 'Synthetic traceability', 'No clinical specification.');
        $r->saveArtifact('project', 'templates/synthetic.oet', TerminologyBindingPlanTest::MODEL, [], null);
        return $r;
    }
    public static function service(ModelRepository $r, ?SqliteAuditStore $audit = null, bool $write = true, string $tenant = 'shared'): ProjectTraceability
    {
        return new ProjectTraceability(
            $r,
            new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => $write ? 'true' : 'false'])),
            new TraceabilityEvidence($r, $audit ?? new SqliteAuditStore(':memory:'), new Actor('agent', $tenant, ['modeller']), new ModelAnchorInspector())
        );
    }
    private function graph(ModelRepository $r): array
    {
        return TraceabilityGraphTest::graph(array_intersect_key($r->getArtifact('project', 'templates/synthetic.oet'), array_flip(['path','revision','sha256'])));
    }
    private function governed(ModelRepository $r): array
    {
        $s = new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $actor = new Actor('agent', 'shared', ['modeller']);
        $validator = new PreflightValidation(new QualityPipeline(new ModelValidator()));
        $service = new ModelGovernance($r, $this->audit, new ReviewPolicy(), $validator, new AccessPolicy($s), $actor);
        $source = $r->getArtifact('project', 'templates/synthetic.oet');
        $view = $service->prepare('project', $source['path'], $source['revision'], 'Synthetic source review.');
        $view = $service->validate($view['subject'], $view['sequence']);
        $view = $service->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Review explicit synthetic source.');
        $human = new Actor('synthetic-reviewer', 'shared', ['reviewer'], true, 'interactive_oidc');
        $review = new ModelGovernance($r, $this->audit, new ReviewPolicy(), $validator, new AccessPolicy($s, new Principal($human->id, 'shared', $human->roles, ['governance.write'], true, 'interactive_oidc')), $human);
        return $review->transition($view['subject'], $view['sequence'], 'REVIEWED', 'Synthetic evidence inspection; no clinical approval.');
    }
    private function withAudit(array $graph, array $view): array
    {
        $base = ['description' => 'Synthetic audit evidence only.','provenance' => ['Authoritative governance ledger fixture.']];
        foreach (['validation_evidence' => ['V-1',1], 'review' => ['REV-1',3]] as $type => [$id,$at]) {
            $event = $view['events'][$at];
            $graph['nodes'][] = ['id' => $id,'type' => $type,'title' => $type,'event' => ['subject' => $view['subject'],'sequence' => $event['sequence'],'hash' => $event['hash']]] + $base;
        }
        $graph['edges'][] = ['from' => 'C-1','to' => 'V-1','relation' => 'validated_by','rationale' => 'Checks executed against this exact source.'];
        $graph['edges'][] = ['from' => 'V-1','to' => 'REV-1','relation' => 'reviewed_by','rationale' => 'Reviewer inspected this validation evidence.'];
        return $graph;
    }
    #[DataProvider('providers')]
    public function test_repository_contract_persists_queries_history_conflicts_and_stale_references(string $provider): void
    {
        $r = $this->repository($provider);
        $service = self::service($r);
        $graph = $this->graph($r);
        $saved = $service->save('project', $graph);
        self::assertFalse($saved['clinical_approval']);
        self::assertFalse($saved['model_changed']);
        self::assertSame('DECLARED_FULL', $saved['coverage'][0]['declared_coverage']);
        self::assertSame('NOT_ASSESSED', $saved['semantic_satisfaction']);
        self::assertTrue($saved['coverage'][0]['element_references_current_and_resolved']);
        self::assertSame([], $saved['findings']);
        $why = $service->explain('project', 'C-1');
        self::assertSame(['C-1','D-1','R-023','T-1'], array_column($why['graph']['nodes'], 'id'));
        self::assertSame(['C-1'], $service->requirement('project', 'R-023')['requirement_coverage']['elements']);
        try {
            $service->save('project', $graph);
            self::fail('Unconditional overwrite accepted');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('CONFLICT', $e->getMessage());
        }
        $graph['nodes'][1]['rationale'] = 'Updated recorded rationale; source unchanged.';
        $next = $service->save('project', $graph, $saved['artifact']['revision']);
        self::assertNotSame($saved['artifact']['revision'], $next['artifact']['revision']);
        self::assertSame($saved['graph'], $service->get('project', $saved['artifact']['revision'])['graph']);
        $source = $r->getArtifact('project', 'templates/synthetic.oet');
        $r->saveArtifact('project', $source['path'], $source['content']."\n", [], $source['revision']);
        $stale = $service->get('project');
        self::assertSame('STALE', $stale['evidence']['C-1']['status']);
        self::assertFalse($stale['coverage'][0]['element_references_current_and_resolved']);
        self::assertContains('TRACEABILITY_STALE', array_column($stale['findings'], 'code'));
    }
    public function test_terminology_and_authentic_validation_review_trails_do_not_infer_release_eligibility(): void
    {
        $r = $this->repository();
        $view = $this->governed($r);
        $graph = $this->withAudit($this->graph($r), $view);
        $binding = $r->saveArtifact('project', 'terminology/bindings/fixture.json', '{"binding":{"system":"https://example.org/synthetic","code":"test"}}', [], null);
        $graph['nodes'][] = ['id' => 'B-1','type' => 'terminology_binding','title' => 'Synthetic binding','description' => 'Explicit binding draft.','provenance' => ['Synthetic fixture.'],
            'artifact' => array_intersect_key($binding, array_flip(['path','revision','sha256'])) + ['anchor' => ['kind' => 'json_pointer','value' => '/binding']]];
        $graph['edges'][] = ['from' => 'C-1','to' => 'B-1','relation' => 'bound_by','rationale' => 'Recorded draft binding associated with this rule.'];
        $service = self::service($r, $this->audit);
        $saved = $service->save('project', $graph);
        self::assertSame('VERIFIED', $saved['evidence']['V-1']['status']);
        self::assertSame('FAIL', $saved['evidence']['V-1']['validation_status']); // Deliberately minimal source is not a qualified OET.
        self::assertFalse($saved['evidence']['V-1']['release_eligible_at_event']);
        self::assertTrue($saved['evidence']['REV-1']['actor']['human']);
        self::assertSame('CURRENT', $saved['evidence']['B-1']['status']);
        self::assertSame(['B-1','C-1','D-1','R-023','REV-1','T-1','V-1'], array_column($service->explain('project', 'C-1')['graph']['nodes'], 'id'));
        self::assertFalse($saved['clinical_approval']);
        $other = self::service($r, $this->audit, tenant:str_repeat('b', 64))->get('project');
        self::assertSame('INVALID', $other['evidence']['REV-1']['status']);
        self::assertArrayNotHasKey('actor', $other['evidence']['REV-1']);
    }
    public function test_evidence_for_a_different_source_cannot_validate_a_model_element(): void
    {
        $r = $this->repository();
        $view = $this->governed($r);
        $graph = $this->withAudit($this->graph($r), $view);
        $other = $r->saveArtifact('project', 'templates/other.oet', TerminologyBindingPlanTest::MODEL.' ', [], null);
        $graph['nodes'][3]['artifact'] = array_intersect_key($other, array_flip(['path','revision','sha256'])) + ['anchor' => ['kind' => 'xml_location','value' => '/1/1/1']];
        $this->expectExceptionMessage('INVALID_TRACEABILITY_EVIDENCE_LINK');
        self::service($r, $this->audit)->save('project', $graph);
    }
    public function test_forged_event_hash_missing_source_and_invalid_anchor_cannot_be_saved(): void
    {
        $r = $this->repository();
        $view = $this->governed($r);
        $original = $this->withAudit($this->graph($r), $view);
        $bad = $original;
        $bad['nodes'][4]['event']['hash'] = str_repeat('0', 64);
        $cases = [$bad];
        $bad = $original;
        $bad['nodes'][2]['artifact']['path'] = 'templates/missing.oet';
        $cases[] = $bad;
        $bad = $original;
        $bad['nodes'][3]['artifact']['anchor']['value'] = '/1/999';
        $cases[] = $bad;
        foreach ($cases as $graph) {
            try {
                self::service($r, $this->audit)->save('project', $graph);
                self::fail('Unresolvable graph accepted');
            } catch (\InvalidArgumentException $e) {
                self::assertSame('INVALID_TRACEABILITY_REFERENCES', $e->getMessage());
            }
        }
    }
    public function test_unexecuted_native_paths_and_unresolved_excluded_requirements_remain_explicit(): void
    {
        $r = $this->repository();
        $graph = $this->graph($r);
        $graph['nodes'][3]['artifact']['anchor'] = ['kind' => 'openehr_path','value' => '/data[at0001]'];
        $graph['nodes'][] = array_replace($graph['nodes'][0], ['id' => 'R-missing']);
        $graph['nodes'][] = array_replace($graph['nodes'][0], ['id' => 'R-excluded','status' => 'EXCLUDED','exclusion_reason' => 'Explicitly outside this fixture.']);
        $saved = self::service($r)->save('project', $graph);
        $coverage = array_column($saved['coverage'], 'declared_coverage', 'requirement');
        self::assertSame('UNRESOLVED', $coverage['R-missing']);
        self::assertSame('EXCLUDED', $coverage['R-excluded']);
        self::assertSame('NOT_EXECUTED', $saved['evidence']['C-1']['status']);
        self::assertFalse($saved['coverage'][0]['element_references_current_and_resolved']);
        self::assertContains('UNRESOLVED_REQUIREMENT', array_column($saved['findings'], 'code'));
    }
    public function test_external_graph_edits_are_revalidated_and_cannot_forge_evidence(): void
    {
        $r = $this->repository();
        $service = self::service($r);
        $saved = $service->save('project', $this->graph($r));
        $graph = $saved['graph'];
        $graph['nodes'][0]['artifact']['sha256'] = str_repeat('0', 64);
        $r->saveArtifact('project', ProjectTraceability::PATH, json_encode($graph, JSON_THROW_ON_ERROR), [], $saved['artifact']['revision']);
        self::assertSame('INVALID', $service->get('project')['evidence']['C-1']['status']);
    }
    public function test_write_policy_and_unknown_requirement_fail_closed(): void
    {
        $r = $this->repository();
        $graph = $this->graph($r);
        try {
            self::service($r, write:false)->save('project', $graph);
            self::fail('Writes disabled');
        } catch (\RuntimeException $e) {
            self::assertSame('WRITES_DISABLED', $e->getMessage());
        }
        $service = self::service($r);
        $service->save('project', $graph);
        $this->expectExceptionMessage('TRACEABILITY_REQUIREMENT_NOT_FOUND');
        $service->requirement('project', 'T-1');
    }

    public static function budgets(): array
    {
        // Five historical and five current 2 MiB reads exceed the shared byte budget.
        return [[101, 32, 'TRACEABILITY_REFERENCE_LIMIT'], [5, 2097152, 'TRACEABILITY_EVIDENCE_BYTE_LIMIT']];
    }
    #[DataProvider('budgets')]
    public function test_reference_and_byte_budgets_stop_before_unbounded_repository_work(int $count, int $size, string $error): void
    {
        $content = str_repeat('x', $size);
        $nodes = [];
        for ($i = 0; $i < $count; $i++) {
            $nodes[] = ['id' => 'T-'.$i,'type' => 'template','title' => 'Synthetic bounded source','description' => 'Limits fixture.',
                'provenance' => ['Synthetic storage stub.'],'artifact' => ['path' => 'templates/t'.$i.'.oet','revision' => 'source-revision','sha256' => hash('sha256', $content)]];
        }
        $repository = $this->createStub(ModelRepository::class);
        $repository->method('getArtifact')->willReturnCallback(static fn (string $project, string $path, ?string $revision = null): array =>
            ['path' => $path,'revision' => 'source-revision','sha256' => hash('sha256',$content),'status' => 'DRAFT','content' => $content]);
        $resolver = new TraceabilityEvidence($repository,$this->audit,new Actor('agent','shared',['modeller']),new ModelAnchorInspector());
        $this->expectExceptionMessage($error);
        $resolver->resolve('project',new Graph(['schema' => 1,'nodes' => $nodes,'edges' => []]));
    }
}
