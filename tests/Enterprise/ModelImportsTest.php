<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\ModelImports;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Repository\OriginalContent;
use OpenEHR\Assistant\Integrations\Governance\ConfiguredAuditStore;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Validation\ArtifactTypeInspector;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ModelImportsTest extends TestCase
{
    private string $root;
    private Settings $settings;
    private ModelRepository $repository;
    private SqliteAuditStore $audit;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/imports-' . bin2hex(random_bytes(8));
        mkdir($this->root, 0700);
        $this->settings = new Settings(['MODEL_REPOSITORY_PATH' => $this->root . '/models', 'MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $this->repository = RepositoryFactory::create($this->settings);
        $this->repository->createProject('default', 'Synthetic import', '');
        $this->audit = new SqliteAuditStore($this->root . '/audit.sqlite');
    }

    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) {
            $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($this->root);
    }

    private function service(?AuditStore $audit = null, ?Settings $settings = null, ?Actor $actor = null): ModelImports
    {
        return new ModelImports(
            $this->repository,
            $audit ?? $this->audit,
            $actor ?? new Actor('verified-test-service', 'shared', ['modeller']),
            new AccessPolicy($settings ?? $this->settings),
            new ArtifactTypeInspector()
        );
    }

    public static function originals(): array
    {
        return [["\xef\xbb\xbf{\"nativeUnknownField\": [1, 2]}\r\n", 'model.t.json', 'DESIGNER_AUTHORING_JSON'],
            ["\xff\xfe<\0x\0/\0>\0", 'utf16.xml', 'UNKNOWN'], ["PK\0\xff\x10", 'bundle.zip', 'MODEL_PACKAGE'],
            ['<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///etc/passwd">]><x>&ex;</x>', 'bad.xml', 'UNKNOWN']];
    }

    #[DataProvider('originals')]
    public function test_originals_have_protected_platform_provenance_without_external_or_clinical_certification(string $bytes, string $filename, string $type): void
    {
        $service = $this->service();
        $inspection = $service->inspect($filename, base64_encode($bytes), $type);
        self::assertCount(0, $this->repository->listArtifacts('default'));
        $claims = ['source_system' => 'Archetype Designer', 'external_revision' => 'unverified-12', 'external_status' => 'RELEASED'];
        $first = $service->import('default', $filename, base64_encode($bytes), $type, $claims);
        self::assertSame('STORED_UNREVIEWED', $first['status']);
        self::assertSame('VERIFIED', $first['original_integrity']);
        self::assertFalse($first['source_system_verified']);
        self::assertFalse($first['clinical_approval']);
        self::assertSame('NOT_EXECUTED', $first['validation']);
        self::assertSame('CALLER_DECLARED', $first['claim_assurance']);
        self::assertSame('RELEASED', $first['source_claims']['external_status']);
        self::assertSame('STORED_UNREVIEWED', $first['status']);
        self::assertSame($inspection, $first['inspection']);
        self::assertSame('verified-test-service', $first['importing_actor']['id']);
        self::assertFalse($first['importing_actor']['human']);
        self::assertCount(2, $first['events']);
        self::assertSame($first['events'][0]['hash'], $first['events'][1]['previous_hash']);
        $record = $this->repository->getArtifact('default', $first['original']['path']);
        self::assertSame($bytes, OriginalContent::bytes($record));
        self::assertSame($first, $service->import('default', $filename, base64_encode($bytes), $type, array_reverse($claims, true)));
        self::assertCount(1, $this->repository->history('default', $record['path']));
        self::assertSame([], $this->audit->subjects('shared', 'default', firstType: 'REGISTER'));
        self::assertCount(1, $this->audit->subjects('shared', 'default', firstType: 'MODEL_IMPORT_REQUESTED'));
    }

    public function test_unknown_source_is_explicit_and_caller_cannot_supply_actor_or_approval(): void
    {
        foreach (['actor', 'imported_at', 'approved_by', 'origin_verified', 'url'] as $forged) {
            try {
                $this->service()->import('default', 'file.txt', base64_encode('text'), sourceClaims: [$forged => 'forged']);
                self::fail('Forged claim accepted');
            } catch (\InvalidArgumentException $error) {
                self::assertSame('IMPORT_SOURCE_CLAIMS_INVALID', $error->getMessage());
            }
        }
        self::assertCount(0, $this->repository->listArtifacts('default'));
        $import = $this->service()->import('default', 'file.t.json', base64_encode('{"anything":true}'));
        self::assertSame('UNKNOWN', $import['source_claims']['source_system']);
        self::assertSame('UNKNOWN', $import['inspection']['effective_type']);
        $this->repository->createProject('other', 'Other project', '');
        foreach ([fn () => $this->service()->provenance('other', $import['import_id']),
            fn () => $this->service(actor: new Actor('other', hash('sha256', 'tenant'), ['modeller']))->provenance('default', $import['import_id'])] as $crossBoundary) {
            try {
                $crossBoundary();
                self::fail('Cross namespace access');
            } catch (\RuntimeException $error) {
                self::assertSame('IMPORT_NOT_FOUND', $error->getMessage());
            }
        }
    }

    public function test_missing_audit_or_write_permission_does_not_leave_an_original(): void
    {
        foreach ([fn () => $this->service(new ConfiguredAuditStore(new Settings())),
            fn () => $this->service(settings: new Settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'false']))] as $create) {
            try {
                $create()->import('default', 'file.xml', base64_encode('<x/>'));
                self::fail('Unavailable capability accepted');
            } catch (\RuntimeException $error) {
                self::assertContains($error->getMessage(), ['GOVERNANCE_NOT_CONFIGURED', 'WRITES_DISABLED']);
            }
            self::assertSame([], $this->repository->listArtifacts('default'));
        }
    }

    public function test_failed_receipt_is_safely_resumed_without_duplicate_originals(): void
    {
        $fail = true;
        $store = $this->createStub(AuditStore::class);
        $store->method('events')->willReturnCallback($this->audit->events(...));
        $store->method('append')->willReturnCallback(function ($tenant, $subject, $expected, $event) use (&$fail) {
            if ($expected === 1 && $fail) {
                $fail = false;
                throw new \RuntimeException('TEST_STORAGE_INTERRUPTED');
            }
            return $this->audit->append($tenant, $subject, $expected, $event);
        });
        $service = $this->service($store);
        try {
            $service->import('default', 'file.xml', base64_encode('<x/>'));
            self::fail('Expected simulated interruption');
        } catch (\RuntimeException $error) {
            self::assertSame('TEST_STORAGE_INTERRUPTED', $error->getMessage());
        }
        $before = $this->repository->listArtifacts('default');
        self::assertCount(1, $before);
        $subject = $this->audit->subjects('shared', 'default')[0]['subject'];
        self::assertSame('STORAGE_PENDING', $service->provenance('default', $subject)['status']);
        $result = $service->import('default', 'file.xml', base64_encode('<x/>'));
        self::assertSame('STORED_UNREVIEWED', $result['status']);
        self::assertSame($before, $this->repository->listArtifacts('default'));
        self::assertCount(2, $this->audit->events('shared', $subject));
    }

    public function test_native_git_tampering_cannot_forge_protected_import_provenance(): void
    {
        $this->settings = $this->settings->with(['MODEL_REPOSITORY_PROVIDER' => 'git']);
        $this->repository = RepositoryFactory::create($this->settings);
        $this->repository->createProject('default', 'Synthetic native Git', '');
        $service = $this->service();
        $request = ['default', 'original.adl', base64_encode('original bytes')];
        $result = $service->import(...$request);
        self::assertSame($result, $service->provenance('default', $result['import_id']));
        $git = new \OpenEHR\Assistant\Integrations\Repository\GitProcess($this->root, environment: [
            'GIT_AUTHOR_NAME' => 'Fixture', 'GIT_AUTHOR_EMAIL' => 'fixture@example.invalid',
            'GIT_COMMITTER_NAME' => 'Fixture', 'GIT_COMMITTER_EMAIL' => 'fixture@example.invalid']);
        self::assertSame(0, $git->run(['clone', $this->root . '/models/git/objects.git', $this->root . '/external'])['code']);
        file_put_contents($this->root . '/external/' . $result['original']['path'], 'external edit');
        foreach ([['add', '--', $result['original']['path']], ['commit', '-m', 'External edit'], ['push', 'origin', 'HEAD']] as $args) {
            self::assertSame(0, $git->run(['-C', $this->root . '/external', ...$args])['code']);
        }
        $this->repository = RepositoryFactory::create($this->settings);
        $this->expectExceptionMessage('IMPORT_ORIGINAL_INTEGRITY_FAILED');
        $this->service()->import(...$request);
    }

    public function test_strict_base64_size_dates_and_filenames(): void
    {
        foreach (['', 'YQ', 'YQ==\n', 'YR==', base64_encode(str_repeat('x', 2097153))] as $invalid) {
            try {
                $this->service()->inspect('safe.txt', $invalid);
                self::fail('Invalid byte envelope accepted');
            } catch (\InvalidArgumentException $error) {
                self::assertContains($error->getMessage(), ['IMPORT_BASE64_INVALID', 'ARTIFACT_TOO_LARGE']);
            }
        }
        foreach (['2026-02-31T12:00:00Z', 'tomorrow', '2026-01-01'] as $invalid) {
            try {
                $this->service()->import('default', 'safe.txt', base64_encode('text'), sourceClaims: ['exported_at' => $invalid]);
                self::fail('Invalid date');
            } catch (\InvalidArgumentException $error) {
                self::assertSame('IMPORT_SOURCE_CLAIMS_INVALID', $error->getMessage());
            }
        }
        $this->expectExceptionMessage('IMPORT_FILENAME_OR_ID_INVALID');
        $this->service()->import('default', '../file.xml', base64_encode('<x/>'));
    }
}
