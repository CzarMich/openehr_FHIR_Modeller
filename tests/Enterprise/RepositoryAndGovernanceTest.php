<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Modelling\Traceability;
use OpenEHR\Assistant\Tools\ProjectService;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class RepositoryAndGovernanceTest extends TestCase
{
    private string $root;
    private FileSystemRepository $repository;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/repository-test-' . bin2hex(random_bytes(8));
        $this->repository = new FileSystemRepository($this->root);
        $this->repository->createProject('neonatal', 'Neonatal information modelling', 'Synthetic test project');
    }

    public function test_artifacts_and_versions_survive_reopening_and_conflicts_do_not_overwrite(): void
    {
        $first = $this->repository->saveArtifact('neonatal', 'templates/admission.oet', '<first/>', ['requirement' => 'REQ-1'], null);
        $second = $this->repository->saveArtifact('neonatal', 'templates/admission.oet', '<second/>', [], $first['revision']);
        $reopened = new FileSystemRepository($this->root);
        self::assertSame('<second/>', $reopened->getArtifact('neonatal', 'templates/admission.oet')['content']);
        self::assertSame('<first/>', $reopened->getArtifact('neonatal', 'templates/admission.oet', $first['revision'])['content']);
        self::assertCount(2, $reopened->history('neonatal', 'templates/admission.oet'));
        $unchanged = $reopened->saveArtifact('neonatal', 'templates/admission.oet', '<second/>', [], $second['revision']);
        self::assertSame($second['revision'], $unchanged['revision']);
        self::assertCount(2, $reopened->history('neonatal', 'templates/admission.oet'));
        try {
            $reopened->saveArtifact('neonatal', 'templates/admission.oet', 'lost update', [], $first['revision']);
            self::fail('Stale revision overwrote content.');
        } catch (\RuntimeException $e) {
            self::assertSame('REVISION_CONFLICT', $e->getMessage());
        }
        self::assertSame($second['revision'], $reopened->getArtifact('neonatal', 'templates/admission.oet')['revision']);
        $reopened->deleteArtifact('neonatal', 'templates/admission.oet', $second['revision']);
        self::assertSame([], $reopened->listArtifacts('neonatal'));
        self::assertCount(3, $reopened->history('neonatal', 'templates/admission.oet'));
    }

    #[DataProvider('unsafeArtifacts')]
    public function test_logical_paths_cannot_escape_repository(string $path): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->repository->saveArtifact('neonatal', $path, 'content', [], null);
    }

    public static function unsafeArtifacts(): array
    {
        return [['../../outside'], ['/etc/passwd'], ['templates/../../outside'], ['templates/%2e%2e/file'], ['templates//file'], ["templates/file\0"]];
    }

    public function test_symlink_escape_and_unconfigured_providers_fail_closed(): void
    {
        symlink('/tmp', $this->root . '/linked');
        try {
            new FileSystemRepository($this->root . '/linked/subdir');
            self::fail('Symlink root was accepted.');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('REPOSITORY_SYMLINK_FORBIDDEN', $e->getMessage());
        }
        $this->expectException(\InvalidArgumentException::class);
        RepositoryFactory::create(new Settings(['MODEL_REPOSITORY_PROVIDER' => 'sharepoint']));
    }

    public function test_disabled_writes_and_agent_claimed_approval_are_rejected(): void
    {
        $service = new ProjectService($this->repository, new Settings(), new Traceability());
        $result = $service->save('neonatal', 'templates/test.oet', '<test/>');
        self::assertFalse($result['success']);
        self::assertSame('WRITES_DISABLED', $result['error']['code']);
        $this->expectException(\InvalidArgumentException::class);
        $this->repository->saveArtifact('neonatal', 'templates/test.oet', '<test/>', ['status' => 'APPROVED'], null);
    }

    public function test_archived_project_is_readable_but_not_writable(): void
    {
        $project = $this->repository->getProject('neonatal');
        $this->repository->archiveProject('neonatal', $project['revision']);
        self::assertSame('ARCHIVED', $this->repository->getProject('neonatal')['status']);
        $this->expectExceptionMessage('PROJECT_ARCHIVED');
        $this->repository->saveArtifact('neonatal', 'aql/test.aql', 'SELECT', [], null);
    }

    public function test_governance_requires_independent_human_and_current_release_validation(): void
    {
        $governance = new ReviewPolicy();
        $report = ModelGovernanceTest::qualifiedReport('fixture'); $hash = $report['content_sha256'];
        $governance->assertTransition('REVIEWED', 'APPROVED', 'author', new Actor('reviewer', 'shared', ['approver'], true, 'interactive_oidc'), $report, $hash);
        foreach ([['author', true, $report], ['agent', false, $report], ['reviewer', true, array_replace($report, ['release_eligible' => false])],
            ['reviewer', true, array_replace($report, ['content_sha256' => 'stale'])]] as [$actor, $human, $validation]) {
            try {
                $governance->assertTransition('REVIEWED', 'APPROVED', 'author', new Actor($actor, 'shared', ['approver'], $human, $human ? 'interactive_oidc' : 'service'), $validation, $hash);
                self::fail('Unsafe approval passed.');
            } catch (\DomainException $e) {
                self::assertStringStartsWith('GOVERNANCE_', $e->getMessage());
            }
        }
    }

    public function test_coverage_requires_explicit_links_and_does_not_count_file_existence(): void
    {
        $report = (new Traceability())->coverage([['id' => 'R1'], ['id' => 'R2'], ['id' => 'R3', 'status' => 'excluded', 'exclusion_reason' => 'out of scope']],
            [['requirement' => 'R1', 'artifact' => 'templates/a.oet', 'node' => '/data', 'rationale' => 'specified field', 'coverage' => 'full'],
                ['requirement' => 'R2', 'artifact' => 'missing', 'node' => '/data', 'rationale' => 'missing model', 'coverage' => 'full']], ['templates/a.oet']);
        self::assertSame(50.0, $report['coverage_percent']);
        self::assertSame(1, $report['counts']['unresolved']);
        self::assertSame(1, $report['counts']['intentionally_excluded']);
    }
}
