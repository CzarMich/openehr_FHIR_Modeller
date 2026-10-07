<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\Traceability;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;
use OpenEHR\Assistant\Integrations\Repository\GitProcess;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Tools\ProjectService;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class GitRepositoryTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/git-repository-test-' . bin2hex(random_bytes(8));
        mkdir($this->root, 0700);
    }

    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) {
            $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($this->root);
    }

    private function settings(string $name = 'cache', string $remote = ''): Settings
    {
        return new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $this->root . '/' . $name,
            'MODEL_GIT_REMOTE_URL' => $remote, 'MODEL_GIT_SYNC_SECONDS' => '0']);
    }

    private function git(array $arguments, string $input = ''): string
    {
        $result = (new GitProcess($this->root, 10, ['GIT_AUTHOR_NAME' => 'Test', 'GIT_AUTHOR_EMAIL' => 'test@localhost',
            'GIT_COMMITTER_NAME' => 'Test', 'GIT_COMMITTER_EMAIL' => 'test@localhost']))->run($arguments, $input);
        self::assertSame(0, $result['code'], 'Test fixture Git command failed: ' . implode(' ', $arguments));
        return trim($result['output']);
    }

    private function remote(): string
    {
        $path = $this->root . '/remote.git';
        $this->git(['init', '--bare', '--initial-branch=main', $path]);
        return $path;
    }

    public function test_offline_repository_stores_plain_files_and_preserves_revision_history(): void
    {
        $repository = RepositoryFactory::create($this->settings());
        self::assertInstanceOf(GitModelRepository::class, $repository);
        self::assertTrue($repository->capabilities()['offline']);
        $repository->createProject('default', 'Model library', 'No terminology service');
        $first = $repository->saveArtifact('default', 'templates/admission.oet', '<first/>', ['requirement' => 'R1'], null);
        $second = $repository->saveArtifact('default', 'templates/admission.oet', '<second/>', [], $first['revision']);
        self::assertMatchesRegularExpression('/^[a-f0-9]{40}$/', $first['revision']);
        self::assertSame('<second/>', $this->git(['--git-dir=' . $this->root . '/cache/git/objects.git', 'show', 'main:templates/admission.oet']));
        $reopened = new GitModelRepository($this->settings());
        self::assertSame('<first/>', $reopened->getArtifact('default', 'templates/admission.oet', $first['revision'])['content']);
        self::assertSame($second['revision'], $reopened->getArtifact('default', 'templates/admission.oet')['revision']);
        $unchanged = $reopened->saveArtifact('default', 'templates/admission.oet', '<second/>', [], $second['revision']);
        self::assertSame($second['revision'], $unchanged['revision']);
        self::assertCount(2, $reopened->history('default', 'templates/admission.oet'));
        $reopened->deleteArtifact('default', 'templates/admission.oet', $second['revision']);
        $history = $reopened->history('default', 'templates/admission.oet');
        self::assertCount(3, $history);
        self::assertSame('DELETED', $history[2]['status']);
        self::assertSame('<second/>', $history[2]['content']);
        self::assertSame([], $reopened->listArtifacts('default'));
    }

    public function test_multiple_projects_archive_and_write_gate_without_terminology(): void
    {
        $repository = new GitModelRepository($this->settings());
        $repository->createProject('default', 'Root', '');
        $project = $repository->createProject('neonatal', 'Neonatal', '');
        $artifact = $repository->saveArtifact('neonatal', 'aql/query.aql', 'SELECT e FROM EHR e', [], null);
        self::assertSame('SELECT e FROM EHR e', $this->git(['--git-dir=' . $this->root . '/cache/git/objects.git', 'show', 'main:projects/neonatal/aql/query.aql']));
        self::assertCount(2, $repository->listProjects());
        self::assertSame('DRAFT', $artifact['status']);
        $service = new ProjectService($repository, $this->settings(), new Traceability());
        self::assertTrue($service->projects()['success']);
        self::assertSame('WRITES_DISABLED', $service->save('default', 'aql/no.aql', 'SELECT')['error']['code']);
        $repository->archiveProject('neonatal', $project['revision']);
        self::assertSame('ARCHIVED', $repository->getProject('neonatal')['status']);
        $this->expectExceptionMessage('PROJECT_ARCHIVED');
        $repository->saveArtifact('neonatal', 'aql/query.aql', 'changed', [], $artifact['revision']);
    }

    public function test_remote_writers_reject_stale_updates_and_preserve_unrelated_changes(): void
    {
        $remote = $this->remote();
        $a = new GitModelRepository($this->settings('a', $remote));
        $b = new GitModelRepository($this->settings('b', $remote));
        $a->createProject('default', 'Shared', '');
        $first = $a->saveArtifact('default', 'templates/a.oet', '<first/>', [], null);
        self::assertSame($first['revision'], $b->getArtifact('default', 'templates/a.oet')['revision']);
        $a->saveArtifact('default', 'templates/other.oet', '<unrelated/>', [], null);
        $second = $b->saveArtifact('default', 'templates/a.oet', '<second/>', [], $first['revision']);
        self::assertSame('<unrelated/>', $b->getArtifact('default', 'templates/other.oet')['content']);
        try {
            $a->saveArtifact('default', 'templates/a.oet', '<stale/>', [], $first['revision']);
            self::fail('Lost update accepted.');
        } catch (\RuntimeException $e) { self::assertSame('REVISION_CONFLICT', $e->getMessage()); }
        self::assertSame($second['revision'], $a->getArtifact('default', 'templates/a.oet')['revision']);
        self::assertSame('<second/>', $this->git(['--git-dir=' . $remote, 'show', 'main:templates/a.oet']));
        self::assertTrue($a->capabilities()['remoteSync']);
        self::assertFalse($a->capabilities()['offline']);
    }

    public function test_unchanged_remote_skips_fetch_but_new_remote_revisions_are_loaded(): void
    {
        $remote = $this->remote();
        $writer = new GitModelRepository($this->settings('writer', $remote));
        $writer->createProject('default', 'Shared', '');
        $first = $writer->saveArtifact('default', 'templates/check.oet', '<first/>', [], null);
        $reader = new GitModelRepository($this->settings('reader', $remote));
        self::assertSame('<first/>', $reader->getArtifact('default', 'templates/check.oet')['content']);
        $fetchHead = $this->root . '/reader/git/objects.git/FETCH_HEAD';
        file_put_contents($fetchHead, 'unchanged-fetch-marker');
        self::assertSame('<first/>', $reader->getArtifact('default', 'templates/check.oet')['content']);
        self::assertSame('unchanged-fetch-marker', file_get_contents($fetchHead));
        $writer->saveArtifact('default', 'templates/check.oet', '<second/>', [], $first['revision']);
        self::assertSame('<second/>', $reader->getArtifact('default', 'templates/check.oet')['content']);
        self::assertNotSame('unchanged-fetch-marker', file_get_contents($fetchHead));
    }

    public function test_external_native_files_are_discovered_and_round_trip_without_wrapping(): void
    {
        $remote = $this->remote();
        $work = $this->root . '/editor';
        $this->git(['clone', $remote, $work]);
        mkdir($work . '/templates');
        $native = '{"native":"authoring document", "unrecognised":{"preserve":true}}';
        file_put_contents($work . '/templates/example.t.json', $native);
        $this->git(['-C', $work, 'add', '.']);
        $this->git(['-C', $work, 'commit', '-m', 'External model authoring']);
        $this->git(['-C', $work, 'push', 'origin', 'main']);
        $repository = new GitModelRepository($this->settings('cache', $remote));
        self::assertSame('default', $repository->listProjects()[0]['id']);
        $artifact = $repository->getArtifact('default', 'templates/example.t.json');
        self::assertSame($native, $artifact['content']);
        $repository->saveArtifact('default', 'templates/example.t.json', $native . "\n", [], $artifact['revision']);
        $this->git(['-C', $work, 'pull', '--ff-only']);
        self::assertSame($native . "\n", file_get_contents($work . '/templates/example.t.json'));
    }

    public function test_rejected_remote_push_does_not_advance_local_head(): void
    {
        $remote = $this->root . '/checked-out-remote';
        $this->git(['init', '--initial-branch=main', $remote]);
        mkdir($remote . '/templates');
        file_put_contents($remote . '/templates/test.oet', '<original/>');
        $this->git(['-C', $remote, 'add', '.']);
        $this->git(['-C', $remote, 'commit', '-m', 'Initial']);
        $repository = new GitModelRepository($this->settings('cache', $remote));
        $artifact = $repository->getArtifact('default', 'templates/test.oet');
        try {
            $repository->saveArtifact('default', 'templates/test.oet', '<rejected/>', [], $artifact['revision']);
            self::fail('Push to checked-out branch unexpectedly passed.');
        } catch (\RuntimeException $e) { self::assertSame('GIT_PUSH_FAILED', $e->getMessage()); }
        self::assertSame($artifact['revision'], $repository->getArtifact('default', 'templates/test.oet')['revision']);
        self::assertSame('<original/>', $repository->getArtifact('default', 'templates/test.oet')['content']);
    }

    public function test_branch_creation_and_diff_are_real_git_operations(): void
    {
        $remote = $this->remote();
        $repository = new GitModelRepository($this->settings('cache', $remote));
        $project = $repository->createProject('default', 'Test', '');
        $artifact = $repository->saveArtifact('default', 'aql/test.aql', 'SELECT e FROM EHR e', [], null);
        self::assertStringContainsString('+SELECT e FROM EHR e', $repository->diff($project['revision'], $artifact['revision'])['patch']);
        $repository->createBranch('review/test', $artifact['revision']);
        self::assertSame($artifact['revision'], $this->git(['--git-dir=' . $remote, 'rev-parse', 'refs/heads/review/test']));
        $this->expectExceptionMessage('GIT_BRANCH_EXISTS');
        $repository->createBranch('review/test', $project['revision']);
    }

    public function test_remote_rewrite_fails_without_replacing_accepted_local_history(): void
    {
        $remote = $this->remote();
        $repository = new GitModelRepository($this->settings('cache', $remote));
        $first = $repository->createProject('default', 'Test', '');
        $second = $repository->saveArtifact('default', 'templates/test.oet', '<test/>', [], null);
        $this->git(['--git-dir=' . $remote, 'update-ref', 'refs/heads/main', $first['revision']]);
        try { $repository->listProjects(); self::fail('Remote rewrite accepted.'); }
        catch (\RuntimeException $e) { self::assertSame('GIT_REMOTE_DIVERGED', $e->getMessage()); }
        self::assertSame($second['revision'], $this->git(['--git-dir=' . $this->root . '/cache/git/objects.git', 'rev-parse', 'main']));
    }

    public function test_remote_symlink_is_rejected_before_project_discovery(): void
    {
        $remote = $this->root . '/unsafe';
        $this->git(['init', '--initial-branch=main', $remote]);
        mkdir($remote . '/templates');
        symlink('/etc/passwd', $remote . '/templates/escape');
        $this->git(['-C', $remote, 'add', '.']);
        $this->git(['-C', $remote, 'commit', '-m', 'Unsafe tree']);
        $this->expectExceptionMessage('GIT_UNSAFE_TREE');
        (new GitModelRepository($this->settings('cache', $remote)))->listProjects();
    }

    #[DataProvider('unsafePaths')]
    public function test_unsafe_paths_cannot_be_written(string $path): void
    {
        $repository = new GitModelRepository($this->settings());
        $this->expectException(\InvalidArgumentException::class);
        $repository->saveArtifact('default', $path, 'test', [], null);
    }

    public static function unsafePaths(): array
    {
        return [['../../outside'], ['/etc/passwd'], ['templates/../../outside'], ['templates/%2e%2e/file'], ['templates//file'], ["templates/file\0"], ['.git/config'], ['.modelling/project.json']];
    }

    public function test_designer_local_layout_and_unicode_file_names_are_preserved(): void
    {
        $remote = $this->remote();
        $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $this->root . '/cache',
            'MODEL_GIT_REMOTE_URL' => $remote, 'MODEL_GIT_CONTENT_PATH' => 'local', 'MODEL_GIT_SYNC_SECONDS' => '0']);
        $repository = new GitModelRepository($settings);
        $repository->createProject('default', 'Designer models', '');
        $path = 'templates/Überblick (draft).t.json';
        $native = '{"preserved":true}';
        $first = $repository->saveArtifact('default', $path, $native, [], null);
        self::assertSame($native, $this->git(['--git-dir=' . $remote, 'show', 'main:local/' . $path]));
        self::assertSame('default', $repository->listProjects()[0]['id']);
        self::assertSame($path, $repository->listArtifacts('default')[0]['path']);
        self::assertSame($first['revision'], (new GitModelRepository($settings))->getArtifact('default', $path)['revision']);
        $repository->createProject('second', 'Second project', '');
        self::assertCount(2, $repository->listProjects());
    }

    public function test_designer_flat_layout_maps_native_files_to_logical_categories(): void
    {
        $remote = $this->remote();
        $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $this->root . '/cache',
            'MODEL_GIT_REMOTE_URL' => $remote, 'MODEL_GIT_CONTENT_PATH' => 'local', 'MODEL_GIT_LAYOUT' => 'flat', 'MODEL_GIT_SYNC_SECONDS' => '0']);
        $repository = new GitModelRepository($settings);
        $repository->createProject('default', 'Designer', '');
        $first = $repository->saveArtifact('default', 'templates/Native template.t.json', '{"native":true}', [], null);
        self::assertSame('{"native":true}', $this->git(['--git-dir=' . $remote, 'show', 'main:local/Native template.t.json']));
        self::assertSame('templates/Native template.t.json', $repository->listArtifacts('default')[0]['path']);
        $repository->saveArtifact('default', 'archetypes/openEHR-EHR-CLUSTER.test.v0.adl', 'archetype test', [], null);
        self::assertCount(2, $repository->listArtifacts('default'));
        $repository->deleteArtifact('default', 'templates/Native template.t.json', $first['revision']);
        self::assertCount(2, $repository->history('default', 'templates/Native template.t.json'));
        $repository->createProject('nested', 'Other project', '');
        $repository->saveArtifact('nested', 'templates/Other.t.json', '{}', [], null);
        self::assertCount(1, $repository->listArtifacts('default'));
        self::assertCount(1, $repository->listArtifacts('nested'));
    }

    public function test_credentials_in_remote_url_are_rejected_without_echoing_secret(): void
    {
        try {
            new GitModelRepository($this->settings('cache', 'https://user:super-secret@example.test/models.git'));
            self::fail('Credential URL accepted.');
        } catch (\InvalidArgumentException $e) { self::assertSame('INVALID_GIT_REMOTE', $e->getMessage()); }
    }

    public function test_reserved_approval_metadata_is_rejected(): void
    {
        $repository = new GitModelRepository($this->settings());
        $this->expectExceptionMessage('RESERVED_METADATA_FIELD: approved_by');
        $repository->saveArtifact('default', 'templates/test.oet', '<test/>', ['approved_by' => 'agent'], null);
    }
    public function test_deep_metadata_cannot_commit_an_unreadable_revision(): void
    {
        $repository = new GitModelRepository($this->settings());
        $repository->createProject('default', 'Test', '');
        $original = $repository->saveArtifact('default', 'templates/test.oet', '<first/>', [], null);
        $metadata = ['leaf' => 'value'];
        for ($i = 0; $i < 65; $i++) { $metadata = ['nested' => $metadata]; }
        try { $repository->saveArtifact('default', 'templates/test.oet', '<unreadable/>', $metadata, $original['revision']); self::fail('Deep metadata committed.'); }
        catch (\InvalidArgumentException $error) { self::assertSame('INVALID_ARTIFACT_METADATA', $error->getMessage()); }
        self::assertSame($original, $repository->getArtifact('default', 'templates/test.oet'));
    }

}
