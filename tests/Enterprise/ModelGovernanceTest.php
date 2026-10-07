<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Governance\ValidationProvider;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;
use OpenEHR\Assistant\Integrations\Governance\PreflightValidation;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Validation\ModelValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ModelGovernanceTest extends TestCase
{
    private FileSystemRepository $repository;
    private SqliteAuditStore $audit;
    private string $directory;
    private array $source;
    private Actor $agent;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/model-governance-' . bin2hex(random_bytes(8));
        $this->repository = new FileSystemRepository($this->directory);
        $this->repository->createProject('project', 'Synthetic project', '');
        $this->source = $this->repository->saveArtifact('project', 'templates/test.oet', TerminologyBindingPlanTest::MODEL, [], null);
        $this->audit = new SqliteAuditStore(':memory:'); $this->agent = new Actor('agent', 'shared', ['modeller', 'approver', 'reviewer', 'publisher']);
    }
    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); } rmdir($this->directory);
    }
    public static function qualifiedReport(string $content): array
    {
        return ['status' => 'PASS', 'release_eligible' => true, 'content_sha256' => hash('sha256', $content),
            'steps' => array_map(static fn (string $name): array => ['name' => $name, 'status' => 'PASS'],
                ['parse', 'structure', 'semantics', 'openehr_conformance', 'repository_policy', 'requirements_traceability', 'dependencies', 'terminology'])];
    }
    private function service(?Actor $actor = null, bool $qualified = false): ModelGovernance
    {
        $validator = new PreflightValidation(new QualityPipeline(new ModelValidator()));
        if ($qualified) {
            $validator = $this->createStub(ValidationProvider::class);
            $validator->method('evaluate')->willReturnCallback(static fn (string $content, string $format): array => self::qualifiedReport($content));
        }
        $actor ??= $this->agent;
        $identity = $actor->human ? new Principal($actor->id, $actor->tenant, $actor->roles, ['governance.write'], true, 'interactive_oidc') : null;
        return new ModelGovernance($this->repository, $this->audit, new ReviewPolicy(), $validator,
            new AccessPolicy(new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']), $identity), $actor);
    }
    private function human(string $id = 'reviewer'): Actor { return new Actor($id, 'shared', ['reviewer', 'approver', 'publisher'], true, 'interactive_oidc'); }
    private function prepare(ModelGovernance $service): array { return $service->prepare('project', 'templates/test.oet', $this->source['revision'], 'Synthetic request; not a clinical model.'); }

    public function test_import_events_cannot_be_read_or_transitioned_as_model_governance(): void
    {
        $id = str_repeat('f', 64);
        $this->audit->append('shared', $id, 0, ['type' => 'MODEL_IMPORT_REQUESTED', 'project' => 'project']);
        self::assertSame([], $this->service()->list('project')['items']);
        $this->expectExceptionMessage('GOVERNANCE_SUBJECT_NOT_FOUND');
        $this->service()->get($id);
    }

    public function test_incomplete_real_validation_allows_review_but_never_clinical_approval(): void
    {
        $agent = $this->service(); $view = $this->prepare($agent);
        self::assertSame('DRAFT', $view['state']); self::assertFalse($view['clinical_approval']);
        $view = $agent->validate($view['subject'], $view['sequence']); self::assertSame('DRAFT', $view['state']);
        self::assertFalse($view['validation']['release_eligible']);
        $view = $agent->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Review known gaps.');
        $human = $this->service($this->human()); $view = $human->transition($view['subject'], $view['sequence'], 'REVIEWED', 'Clinical review completed; technical qualification remains missing.');
        $this->expectExceptionMessage('GOVERNANCE_VALIDATION_REQUIRED'); $human->transition($view['subject'], $view['sequence'], 'APPROVED', 'Cannot bypass missing checks.', $view['validation_digest']);
    }

    public function test_qualified_fixture_can_be_approved_only_by_an_independent_interactive_human(): void
    {
        $agent = $this->service(qualified: true); $view = $this->prepare($agent); $view = $agent->validate($view['subject'], $view['sequence']);
        self::assertSame('VALIDATED', $view['state']);
        $view = $agent->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Please review the exact source.');
        try { $agent->transition($view['subject'], $view['sequence'], 'REVIEWED', 'Agent impersonating reviewer.'); self::fail('Agent review accepted'); }
        catch (\DomainException $error) { self::assertSame('GOVERNANCE_INDEPENDENT_HUMAN_REQUIRED', $error->getMessage()); }
        $human = $this->service($this->human()); $view = $human->transition($view['subject'], $view['sequence'], 'REVIEWED', 'Reviewed exact fixture revision.');
        foreach ([$this->service($this->human('agent')), $agent] as $forbidden) {
            try { $forbidden->transition($view['subject'], $view['sequence'], 'APPROVED', 'Forbidden self/agent approval.', $view['validation_digest']); self::fail('Unsafe approval'); }
            catch (\DomainException $error) { self::assertSame('GOVERNANCE_INDEPENDENT_HUMAN_REQUIRED', $error->getMessage()); }
        }
        try { $human->transition($view['subject'], $view['sequence'], 'APPROVED', 'Wrong evidence.', str_repeat('0', 64)); self::fail('Evidence not confirmed'); }
        catch (\DomainException $error) { self::assertSame('GOVERNANCE_VALIDATION_CONFIRMATION_REQUIRED', $error->getMessage()); }
        $view = $human->transition($view['subject'], $view['sequence'], 'APPROVED', 'Approved synthetic fixture.', $view['validation_digest']);
        self::assertTrue($view['clinical_approval']);
        $view = $human->transition($view['subject'], $view['sequence'], 'PUBLISHED', 'Publish exact fixture.', $view['validation_digest']);
        self::assertSame('PUBLISHED', $view['state']); self::assertCount(6, $view['events']);
        self::assertSame('DRAFT', $this->repository->getArtifact('project', 'templates/test.oet')['status']);
        $view = $human->transition($view['subject'], $view['sequence'], 'DEPRECATED', 'Synthetic fixture superseded.');
        self::assertSame('DEPRECATED', $view['state']); self::assertFalse($view['clinical_approval']);
    }

    public function test_model_edits_invalidate_current_source_and_cannot_inherit_review(): void
    {
        $service = $this->service(); $view = $this->prepare($service);
        $new = $this->repository->saveArtifact('project', 'templates/test.oet', $this->source['content'] . "\n", [], $this->source['revision']);
        self::assertFalse($service->get($view['subject'])['current_source']);
        self::assertSame($this->source['content'], $service->get($view['subject'], true)['content']);
        try { $service->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Stale source'); self::fail('Stale source accepted'); }
        catch (\RuntimeException $error) { self::assertSame('GOVERNANCE_SOURCE_CHANGED', $error->getMessage()); }
        $next = $service->prepare('project', 'templates/test.oet', $new['revision'], 'New source revision.');
        self::assertNotSame($view['subject'], $next['subject']); self::assertSame('DRAFT', $next['state']);
        self::assertCount(2, $service->list('project')['items']);
    }

    public function test_forged_repository_reports_never_authorize_promotion(): void
    {
        $report = self::qualifiedReport($this->source['content']);
        $this->repository->saveArtifact('project', 'validation/forged.json', json_encode($report, JSON_THROW_ON_ERROR), [], null);
        $view = $this->prepare($this->service());
        self::assertNull($view['validation']);
        $this->expectExceptionMessage('GOVERNANCE_INVALID_TRANSITION'); $this->service($this->human())->transition($view['subject'], $view['sequence'], 'APPROVED', 'Forged report must not count.');
    }

    public function test_stale_sequence_and_another_tenant_cannot_change_the_subject(): void
    {
        $service = $this->service(); $view = $this->prepare($service); $service->validate($view['subject'], $view['sequence']);
        try { $service->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Stale sequence'); self::fail('Stale event'); }
        catch (\RuntimeException $error) { self::assertSame('GOVERNANCE_REVISION_CONFLICT', $error->getMessage()); }
        $other = new Actor('other', hash('sha256', 'other-tenant'), ['modeller']);
        $this->expectExceptionMessage('GOVERNANCE_SUBJECT_NOT_FOUND'); $this->service($other)->get($view['subject']);
    }

    public function test_missing_checks_and_not_applicable_core_stages_are_not_release_eligible(): void
    {
        $policy = new ReviewPolicy(); $report = self::qualifiedReport($this->source['content']); $hash = $report['content_sha256'];
        self::assertTrue($policy->qualified($report, $hash));
        $missing = $report; array_pop($missing['steps']); self::assertFalse($policy->qualified($missing, $hash));
        $skipped = $report; $skipped['steps'][0] = ['name' => 'parse', 'status' => 'NOT_APPLICABLE', 'reason' => 'Cannot skip parsing'];
        self::assertFalse($policy->qualified($skipped, $hash));
        $duplicate = $report; $duplicate['steps'][] = $duplicate['steps'][0]; self::assertFalse($policy->qualified($duplicate, $hash));
        $conditional = $report; $conditional['steps'][7] = ['name' => 'terminology', 'status' => 'NOT_APPLICABLE', 'reason' => 'No external coded constraints'];
        self::assertTrue($policy->qualified($conditional, $hash)); unset($conditional['steps'][7]['reason']); self::assertFalse($policy->qualified($conditional, $hash));
    }
}
