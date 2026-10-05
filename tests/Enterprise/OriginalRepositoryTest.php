<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\OriginalContent;
use OpenEHR\Assistant\Domain\Repository\OriginalRepository;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class OriginalRepositoryTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/original-test-' . bin2hex(random_bytes(8));
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

    public static function providers(): array
    {
        return [['filesystem'], ['git'], ['git', 'flat', 'clinical/models'], ['sharepoint']];
    }

    #[DataProvider('providers')]
    public function test_byte_exact_originals_are_create_only_across_storage_contracts(string $provider, string $layout = 'categories', string $folder = ''): void
    {
        $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => $provider, 'MODEL_REPOSITORY_PATH' => $this->root,
            'MODEL_REPOSITORY_WRITE_ENABLED' => 'true', 'MODEL_GIT_LAYOUT' => $layout, 'MODEL_GIT_CONTENT_PATH' => $folder, 'SHAREPOINT_SITE_ID' => 'site', 'SHAREPOINT_LIST_ID' => 'list',
            'SHAREPOINT_DRIVE_ID' => 'drive', 'SHAREPOINT_FOLDER_ID' => 'folder', 'SHAREPOINT_ACCESS_TOKEN' => 'fixture-token',
            'SHAREPOINT_DOWNLOAD_HOSTS' => 'tenant.sharepoint.com']);
        $fixture = new SharePointGraphFixture();
        $repository = $provider === 'sharepoint'
            ? new SharePointRepository($settings, new GraphClient($settings, new ConfiguredAccessToken('fixture-token'), $fixture->client()))
            : RepositoryFactory::create($settings);
        self::assertInstanceOf(OriginalRepository::class, $repository);
        $repository->createProject('default', 'Synthetic original preservation', '');
        foreach (["\xef\xbb\xbf{\"unknown\": [1, 2]}\r\n", "\xff\xfe<\0x\0/\0>\0", "PK\0\xff\x10"] as $index => $bytes) {
            $path = OriginalContent::path(hash('sha256', 'import-' . $index), 'Original Test ü.' . $index);
            $record = $repository->storeOriginal('default', $path, $bytes, ['kind' => 'original_source']);
            self::assertSame($bytes, OriginalContent::bytes($record));
            self::assertSame(hash('sha256', $bytes), $record['sha256']);
            if ($provider === 'git') {
                $process = proc_open(
                    ['git', '--git-dir=' . $this->root . '/git/objects.git', 'show', $record['revision'] . ':' . ($folder === '' ? '' : $folder . '/') . $path],
                    [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
                    $pipes
                );
                self::assertIsResource($process);
                $native = stream_get_contents($pipes[1]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                self::assertSame(0, proc_close($process));
                self::assertSame($bytes, $native);
            }

            self::assertSame($record, $repository->getArtifact('default', $path, $record['revision']));
            self::assertCount(1, $repository->history('default', $path));
            json_encode($record, JSON_THROW_ON_ERROR);
            foreach ([
                fn () => $repository->storeOriginal('default', $path, $bytes, []),
                fn () => $repository->saveArtifact('default', $path, 'changed', [], $record['revision']),
                fn () => $repository->deleteArtifact('default', $path, $record['revision']),
            ] as $change) {
                try {
                    $change();
                    self::fail('Original changed.');
                } catch (\RuntimeException $error) {
                    self::assertContains($error->getMessage(), ['IMPORT_ORIGINAL_EXISTS', 'IMPORT_ORIGINAL_IMMUTABLE']);
                }
            }
            self::assertSame($record, $repository->getArtifact('default', $path));
        }
        self::assertCount(3, $repository->listArtifacts('default'));
        $repository->saveArtifact('default', 'templates/ordinary.oet', '<template/>', [], null);
        self::assertCount(4, $repository->listArtifacts('default'));
    }

    public function test_integrity_and_source_name_guards(): void
    {
        foreach (['../source.adl', 'a/b.adl', "a\\b.adl", "a\0.adl", 'a%2fb.adl', '..'] as $name) {
            try {
                OriginalContent::path(str_repeat('a', 64), $name);
                self::fail('Unsafe source name accepted.');
            } catch (\InvalidArgumentException $error) {
                self::assertSame('IMPORT_FILENAME_OR_ID_INVALID', $error->getMessage());
            }
        }
        $original = OriginalContent::envelope("\xff\xfe");
        $original['sha256'] = str_repeat('0', 64);
        $this->expectExceptionMessage('IMPORT_ORIGINAL_INTEGRITY_FAILED');
        OriginalContent::bytes($original);
    }
}
