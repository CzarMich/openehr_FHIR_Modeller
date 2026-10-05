<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Nyholm\Psr7\ServerRequest;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Rest\ModelApi;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ModelApiTest extends TestCase
{
    private string $directory;
    private Settings $settings;
    private ModelApi $api;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/model-api-' . bin2hex(random_bytes(8));
        $this->settings = new Settings(['APP_ENV' => 'testing', 'AUTH_MODE' => 'none', 'MODEL_REPOSITORY_WRITE_ENABLED' => 'true',
            'MODEL_REPOSITORY_PATH' => $this->directory, 'MCP_ALLOWED_HOSTS' => 'models.example']);
        $repository = new FileSystemRepository($this->directory);
        $repository->createProject('p', 'Fixture project', '');
        $this->api = new ModelApi($this->settings, $repository, new AccessPolicy($this->settings));
    }

    protected function tearDown(): void
    {
        if (!is_dir($this->directory)) {
            return;
        }
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($this->directory);
    }

    private function request(string $method, string $target, array $input = [], string $contentType = 'application/json'): ServerRequest
    {
        $body = in_array($method, ['POST', 'PUT'], true) ? json_encode($input, JSON_THROW_ON_ERROR) : '';
        return new ServerRequest($method, 'https://models.example' . $target, ['Host' => 'models.example', 'Content-Type' => $contentType], $body);
    }

    private function responseBody(string $method, string $target, array $input = []): array
    {
        return json_decode((string) $this->api->handle($this->request($method, $target, $input))->getBody(), true, 32, JSON_THROW_ON_ERROR);
    }

    public function test_projects_and_artifact_crud_use_repository_revisions(): void
    {
        $list = $this->api->handle($this->request('GET', '/api/v1/projects'));
        self::assertSame(200, $list->getStatusCode());
        self::assertSame(['p'], array_column($this->responseBody('GET', '/api/v1/projects')['projects'], 'id'));
        self::assertSame('p', $this->responseBody('GET', '/api/v1/projects/p')['project']['id']);

        $created = $this->api->handle($this->request('POST', '/api/v1/projects', ['id' => 'new', 'name' => 'New project']));
        self::assertSame(201, $created->getStatusCode());
        self::assertSame('new', json_decode((string) $created->getBody(), true, 32, JSON_THROW_ON_ERROR)['project']['id']);

        $query = http_build_query(['project' => 'p', 'path' => 'templates/test.oet']);
        $saved = $this->api->handle($this->request('PUT', '/api/v1/artifacts?' . $query, ['content' => '<template/>', 'metadata' => []]));
        self::assertSame(200, $saved->getStatusCode());
        $revision = json_decode((string) $saved->getBody(), true, 32, JSON_THROW_ON_ERROR)['revision'];
        self::assertSame('<template/>', $this->responseBody('GET', '/api/v1/artifacts?' . $query)['content']);
        self::assertCount(1, $this->responseBody('GET', '/api/v1/artifact-history?' . $query)['versions']);

        $stale = $this->api->handle($this->request('PUT', '/api/v1/artifacts?' . $query, ['content' => '<stale/>', 'expectedRevision' => 'old']));
        self::assertSame(409, $stale->getStatusCode());
        self::assertSame('REVISION_CONFLICT', json_decode((string) $stale->getBody(), true, 32, JSON_THROW_ON_ERROR)['error']['code']);
        $updated = $this->api->handle($this->request('PUT', '/api/v1/artifacts?' . $query, ['content' => '<updated/>', 'expectedRevision' => $revision]));
        self::assertSame(200, $updated->getStatusCode());
    }

    public function test_api_rejects_unknown_fields_methods_queries_and_untrusted_hosts(): void
    {
        self::assertSame(400, $this->api->handle($this->request('POST', '/api/v1/projects', ['id' => 'x', 'name' => 'X', 'admin' => true]))->getStatusCode());
        self::assertSame(400, $this->api->handle($this->request('GET', '/api/v1/projects?all=true'))->getStatusCode());
        self::assertSame(404, $this->api->handle($this->request('DELETE', '/api/v1/projects/p'))->getStatusCode());
        self::assertSame(403, $this->api->handle($this->request('GET', '/api/v1/projects/p')->withHeader('Host', 'evil.example'))->getStatusCode());
        self::assertSame(415, $this->api->handle($this->request('POST', '/api/v1/projects', ['id' => 'x'], 'text/plain'))->getStatusCode());
    }

    public function test_project_archive_requires_current_revision_and_prevents_later_writes(): void
    {
        $project = $this->responseBody('GET', '/api/v1/projects/p')['project'];
        $revision = $project['revision'];
        $stale = $this->api->handle($this->request('POST', '/api/v1/projects/p/archive', ['expectedRevision' => 'stale']));
        self::assertSame(409, $stale->getStatusCode());
        self::assertSame('REVISION_CONFLICT', json_decode((string) $stale->getBody(), true, 32, JSON_THROW_ON_ERROR)['error']['code']);

        $archived = $this->api->handle($this->request('POST', '/api/v1/projects/p/archive', ['expectedRevision' => $revision]));
        self::assertSame(200, $archived->getStatusCode());
        $archivedProject = json_decode((string) $archived->getBody(), true, 32, JSON_THROW_ON_ERROR)['project'];
        self::assertSame('ARCHIVED', $archivedProject['status']);

        $write = $this->api->handle($this->request('PUT', '/api/v1/artifacts?' . http_build_query(['project' => 'p', 'path' => 'templates/test.oet']), ['content' => '<template/>']));
        self::assertSame(409, $write->getStatusCode());
    }
}