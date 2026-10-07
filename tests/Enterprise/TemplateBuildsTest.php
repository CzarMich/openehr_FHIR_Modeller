<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Application\TemplateBuilds;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class TemplateBuildsTest extends TestCase
{
    private string $root;
    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/build-test-' . bin2hex(random_bytes(8));
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
        return [['filesystem', 'opt2_adl'], ['git', 'opt2_adl'], ['filesystem', 'opt14_xml'], ['git', 'opt14_xml']];
    }

    #[DataProvider('providers')]
    public function test_build_preserves_exact_sources_and_atomically_saves_native_opt_and_evidence(string $provider, string $format): void
    {
        $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => $provider, 'MODEL_REPOSITORY_PATH' => $this->root,
            'MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $repository = RepositoryFactory::create($settings);
        $repository->createProject('default', 'Synthetic', '');
        $source = $repository->saveArtifact('default', 'templates/model.adlt', 'old source', [], null);
        $repository->saveArtifact('default', 'templates/model.adlt', 'new source', [], $source['revision']);
        $dependency = $repository->saveArtifact('default', 'archetypes/root.adls', 'dependency', [], null);
        $port = $this->createMock(OpenEhrEngine::class);
        $report = NativeEngineTest::report('old source', 'compile/template');
        $output = $format === 'opt14_xml' ? '<template xmlns="http://schemas.openehr.org/v1"/>' : 'operational_template fixture';
        $report['output'] = ['content' => $output, 'format' => $format, 'sha256' => hash('sha256', $output)];
        $report['compilation_actions'] = [['code' => 'SOURCE_ID', 'value' => 'synthetic']];
        $report['limitations'] = ['Clinical review is independent.'];
        $port->method('compile')->with('old source', [['identifier' => 'model.v1.0.0', 'content' => 'dependency', 'sha256' => hash('sha256', 'dependency')]])->willReturn($report);
        $service = new TemplateBuilds(new NativeModels($port), $repository, new AccessPolicy($settings), new Actor('fixture-service', 'shared', ['modeller']));
        $deps = [['identifier' => 'model.v1.0.0', 'path' => $dependency['path'], 'revision' => $dependency['revision']]];
        $first = $service->compile('default', $source['path'], $source['revision'], $deps);
        self::assertTrue($first['saved']);
        self::assertFalse($first['clinical_approval']);
        $artifact = $repository->getArtifact('default', $first['artifact']['path'], $first['artifact']['revision']);
        self::assertSame($output, $artifact['content']);
        self::assertSame($format === 'opt14_xml' ? 'compiled_opt14' : 'compiled_opt2', $artifact['metadata']['kind']);
        self::assertSame($report['compilation_actions'], $artifact['metadata']['build']['report']['compilation_actions']);
        self::assertSame($report['limitations'], $artifact['metadata']['build']['report']['limitations']);
        self::assertSame('DRAFT', $artifact['status']);
        self::assertSame($source['sha256'], $artifact['metadata']['build']['source']['sha256']);
        self::assertSame($dependency['revision'], $artifact['metadata']['build']['dependencies'][0]['revision']);
        self::assertSame('fixture-service', $artifact['metadata']['build']['actor']['id']);
        self::assertSame('new source', $repository->getArtifact('default', $source['path'])['content']);
        $repeat = $service->compile('default', $source['path'], $source['revision'], $deps);
        self::assertSame($first['build_id'], $repeat['build_id']);
        self::assertSame($first['artifact']['revision'], $repeat['artifact']['revision']);
        self::assertCount(1, $repository->history('default', $first['artifact']['path']));
        $repository->saveArtifact('default', $artifact['path'], 'tampered', [], $artifact['revision']);
        $this->expectExceptionMessage('ENGINE_BUILD_CONFLICT');
        $service->compile('default', $source['path'], $source['revision'], $deps);
    }

    #[DataProvider('providers')]
    public function test_changed_builds_keep_the_filename_and_preserve_exact_previous_versions(string $provider, string $format): void
    {
        $settings = new Settings(['MODEL_REPOSITORY_PROVIDER' => $provider, 'MODEL_REPOSITORY_PATH' => $this->root,
            'MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $repository = RepositoryFactory::create($settings);
        $repository->createProject('default', 'Synthetic', '');
        $source = $repository->saveArtifact('default', 'templates/oet/renal.oet', 'first source', [], null);
        $port = $this->createMock(OpenEhrEngine::class);
        $port->expects(self::exactly(3))->method('compile')->willReturnCallback(static function (string $content) use ($format): array {
            $report = NativeEngineTest::report($content, 'compile/template');
            $output = 'compiled ' . $content;
            $report['output'] = ['content' => $output, 'format' => $format, 'sha256' => hash('sha256', $output)];
            return $report;
        });
        $service = new TemplateBuilds(new NativeModels($port), $repository, new AccessPolicy($settings), new Actor('fixture-service', 'shared', ['modeller']));
        $first = $service->compile('default', $source['path'], $source['revision'], []);
        $updated = $repository->saveArtifact('default', $source['path'], 'second source', [], $source['revision']);
        $second = $service->compile('default', $updated['path'], $updated['revision'], []);
        self::assertSame('templates/opt/renal.opt', $second['artifact']['path']);
        self::assertSame($first['artifact']['path'], $second['artifact']['path']);
        self::assertNotSame($first['build_id'], $second['build_id']);
        self::assertNotSame($first['artifact']['sha256'], $second['artifact']['sha256']);
        self::assertSame('compiled second source', $repository->getArtifact('default', $second['artifact']['path'])['content']);
        self::assertSame('compiled first source', $repository->getArtifact('default', $first['artifact']['path'], $first['artifact']['revision'])['content']);
        self::assertCount(2, $repository->history('default', $second['artifact']['path']));
        $repeat = $service->compile('default', $updated['path'], $updated['revision'], []);
        self::assertFalse($repeat['changed']);
        self::assertSame($second['artifact']['revision'], $repeat['artifact']['revision']);
    }

    public function test_failed_compilation_saves_nothing_and_write_permission_is_required(): void
    {
        $settings = new Settings(['MODEL_REPOSITORY_PATH' => $this->root, 'MODEL_REPOSITORY_WRITE_ENABLED' => 'true']);
        $repository = RepositoryFactory::create($settings);
        $repository->createProject('default', 'Synthetic', '');
        $source = $repository->saveArtifact('default', 'templates/model.adlt', 'bad source', [], null);
        $port = $this->createMock(OpenEhrEngine::class);
        $port->expects(self::once())->method('compile')->willReturn(['valid' => false, 'findings' => [['code' => 'BAD_MODEL']]]);
        $actor = new Actor('fixture-service', 'shared', ['modeller']);
        $service = new TemplateBuilds(new NativeModels($port), $repository, new AccessPolicy($settings), $actor);
        self::assertFalse($service->compile('default', $source['path'], $source['revision'], [])['saved']);
        self::assertCount(1, $repository->listArtifacts('default'));
        $disabled = new TemplateBuilds(new NativeModels($port), $repository, new AccessPolicy(new Settings()), $actor);
        $this->expectExceptionMessage('WRITES_DISABLED');
        $disabled->compile('default', $source['path'], $source['revision'], []);
    }
}
