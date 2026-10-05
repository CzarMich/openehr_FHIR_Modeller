<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Auth\ClientCredentialsToken;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class SharePointRepositoryTest extends TestCase
{
    private function settings(array $overrides = []): Settings
    {
        return new Settings($overrides + ['MODEL_REPOSITORY_PROVIDER' => 'sharepoint', 'SHAREPOINT_SITE_ID' => 'site',
            'SHAREPOINT_LIST_ID' => 'list', 'SHAREPOINT_DRIVE_ID' => 'drive', 'SHAREPOINT_FOLDER_ID' => 'folder',
            'SHAREPOINT_ACCESS_TOKEN' => 'fixture-token', 'SHAREPOINT_DOWNLOAD_HOSTS' => 'tenant.sharepoint.com']);
    }

    private function repository(SharePointGraphFixture $fixture, array $overrides = []): SharePointRepository
    {
        $settings = $this->settings($overrides);
        return new SharePointRepository($settings, new GraphClient($settings, new ConfiguredAccessToken('fixture-token'), $fixture->client()));
    }

    public function test_full_repository_contract_round_trips_revisions_history_metadata_and_tombstones(): void
    {
        $fixture = new SharePointGraphFixture(); $a = $this->repository($fixture);
        $project = $a->createProject('neonatal', 'Neonatal', 'Synthetic fixture');
        $first = $a->saveArtifact('neonatal', 'templates/model.oet', '<first/>', ['source' => 'fixture'], null);
        $second = $a->saveArtifact('neonatal', 'templates/model.oet', '<second/>', [], $first['revision']);
        $b = $this->repository($fixture);
        self::assertSame('sharepoint', $first['provider']); self::assertFalse($b->capabilities()['offline']);
        self::assertCount(1, $b->listProjects()); self::assertCount(1, $b->listArtifacts('neonatal'));
        self::assertSame($second, $b->getArtifact('neonatal', 'templates/model.oet'));
        self::assertSame($first, $b->getArtifact('neonatal', 'templates/model.oet', $first['revision']));
        self::assertCount(2, $b->history('neonatal', 'templates/model.oet'));
        $b->deleteArtifact('neonatal', 'templates/model.oet', $second['revision']);
        self::assertSame([], $b->listArtifacts('neonatal'));
        self::assertSame('DELETED', $b->history('neonatal', 'templates/model.oet')[2]['status']);
        self::assertSame('ARCHIVED', $b->archiveProject('neonatal', $project['revision'])['status']);
        self::assertCount(5, $fixture->files);
        $this->expectExceptionMessage('PROJECT_ARCHIVED');
        $b->saveArtifact('neonatal', 'templates/other.oet', '<x/>', [], null);
    }

    public function test_stale_artifact_revision_is_rejected_before_upload(): void
    {
        $fixture = new SharePointGraphFixture(); $repository = $this->repository($fixture);
        $repository->createProject('project', 'Test', '');
        $first = $repository->saveArtifact('project', 'aql/query.aql', 'SELECT e FROM EHR e', [], null);
        $repository->saveArtifact('project', 'aql/query.aql', 'SELECT e/ehr_id/value FROM EHR e', [], $first['revision']);
        $count = count($fixture->files);
        try { $repository->saveArtifact('project', 'aql/query.aql', 'stale', [], $first['revision']); self::fail('Stale write accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('REVISION_CONFLICT', $error->getMessage()); }
        self::assertCount($count, $fixture->files);
    }

    public function test_two_instances_cannot_publish_over_a_concurrent_update(): void
    {
        $fixture = new SharePointGraphFixture(); $a = $this->repository($fixture); $b = $this->repository($fixture);
        $a->createProject('project', 'Test', '');
        $first = $a->saveArtifact('project', 'templates/model.oet', '<first/>', [], null);
        $fixture->beforeCas = fn () => $b->saveArtifact('project', 'templates/model.oet', '<winner/>', [], $first['revision']);
        try { $a->saveArtifact('project', 'templates/model.oet', '<loser/>', [], $first['revision']); self::fail('Concurrent update overwritten.'); }
        catch (\RuntimeException $error) { self::assertSame('REVISION_CONFLICT', $error->getMessage()); }
        self::assertSame('<winner/>', $a->getArtifact('project', 'templates/model.oet')['content']);
        self::assertCount(2, $a->history('project', 'templates/model.oet'));
        self::assertCount(4, $fixture->files, 'Unreferenced candidate must remain harmless until audited retention.');
    }

    #[DataProvider('failureStages')]
    public function test_failed_remote_write_does_not_publish_partial_state(string $stage): void
    {
        $fixture = new SharePointGraphFixture(); $repository = $this->repository($fixture);
        $repository->createProject('project', 'Test', '');
        $before = $fixture->heads;
        $fixture->$stage = true;
        try { $repository->saveArtifact('project', 'templates/model.oet', '<candidate/>', [], null); self::fail('Failure accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('SHAREPOINT_UNAVAILABLE', $error->getMessage()); }
        self::assertSame($before, $fixture->heads);
        self::assertSame([], $repository->listArtifacts('project'));
    }

    public static function failureStages(): array { return [['failUpload'], ['failCommit']]; }

    public function test_unique_index_is_required_before_any_mutation(): void
    {
        $fixture = new SharePointGraphFixture(); $fixture->unique = false;
        try { $this->repository($fixture)->createProject('project', 'Test', ''); self::fail('Non-unique list accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('SHAREPOINT_UNIQUE_PROJECT_INDEX_REQUIRED', $error->getMessage()); }
        self::assertSame([], $fixture->files); self::assertSame([], $fixture->heads);
    }

    public function test_creation_race_is_reported_from_unique_index_rejection(): void
    {
        $fixture = new SharePointGraphFixture(); $fixture->createRace = true;
        $this->expectExceptionMessage('REVISION_CONFLICT');
        $this->repository($fixture)->createProject('project', 'Test', '');
    }

    public function test_modified_cloud_blob_is_detected_by_snapshot_digest(): void
    {
        $fixture = new SharePointGraphFixture(); $repository = $this->repository($fixture);
        $repository->createProject('project', 'Test', '');
        $fixture->files[array_key_first($fixture->files)] = '{}';
        $this->expectExceptionMessage('SHAREPOINT_SNAPSHOT_INTEGRITY_FAILED'); $repository->getProject('project');
    }

    public function test_agent_cannot_claim_approval_metadata(): void
    {
        $fixture = new SharePointGraphFixture();
        $this->expectExceptionMessage('RESERVED_METADATA_FIELD: approved_by');
        $this->repository($fixture)->saveArtifact('project', 'templates/model.oet', '<draft/>', ['approved_by' => 'agent'], null);
    }

    public function test_project_limit_is_enforced_before_upload(): void
    {
        $fixture = new SharePointGraphFixture(); $repository = $this->repository($fixture, ['SHAREPOINT_MAX_PROJECT_BYTES' => '1048576']);
        $repository->createProject('project', 'Test', '');
        try { $repository->saveArtifact('project', 'templates/model.oet', str_repeat('x', 1048576), [], null); self::fail('Oversize snapshot accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('PROJECT_SIZE_LIMIT', $error->getMessage()); }
        self::assertCount(1, $fixture->files);
    }

    private function mockClient(array $responses, array &$requests): Client
    {
        $stack = HandlerStack::create(new MockHandler($responses)); $stack->push(Middleware::history($requests));
        return new Client(['handler' => $stack]);
    }

    public function test_download_redirect_is_followed_without_graph_credentials(): void
    {
        $apiCalls = []; $downloads = [];
        $api = $this->mockClient([new Response(302, ['Location' => 'https://tenant.sharepoint.com/download?opaque=secret'])], $apiCalls);
        $download = $this->mockClient([new Response(200, [], 'snapshot')], $downloads);
        $graph = new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'), $api, $download);
        self::assertSame('snapshot', $graph->content('drives/drive/items/item/content'));
        self::assertSame('Bearer fixture-token', $apiCalls[0]['request']->getHeaderLine('Authorization'));
        self::assertSame('', $downloads[0]['request']->getHeaderLine('Authorization'));
        self::assertSame('', $downloads[0]['request']->getHeaderLine('Cookie'));
        self::assertFalse($downloads[0]['options']['allow_redirects']);
    }

    #[DataProvider('badDownloads')]
    public function test_download_redirect_cannot_escape_the_explicit_hosts(string $url): void
    {
        $requests = []; $downloads = [];
        $graph = new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'),
            $this->mockClient([new Response(302, ['Location' => $url])], $requests), $this->mockClient([], $downloads));
        try { $graph->content('drives/drive/items/item/content'); self::fail('Untrusted download accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('SHAREPOINT_DOWNLOAD_HOST_REJECTED', $error->getMessage()); }
        self::assertSame([], $downloads);
    }

    public static function badDownloads(): array
    {
        return [['https://attacker.test/token'], ['http://tenant.sharepoint.com/file'], ['https://tenant.sharepoint.com:8443/file'],
            ['https://user@tenant.sharepoint.com/file'], ['https://tenant.sharepoint.com/file#fragment']];
    }

    public function test_pagination_is_bounded_to_the_same_collection_and_origin(): void
    {
        $requests = [];
        $responses = [new Response(200, [], json_encode(['value' => [['id' => '1']], '@odata.nextLink' => 'https://graph.microsoft.com/v1.0/sites/site/lists/list/items?$skiptoken=second'])),
            new Response(200, [], '{"value":[{"id":"2"}]}')];
        $graph = new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'), $this->mockClient($responses, $requests));
        self::assertSame([['id' => '1'], ['id' => '2']], $graph->collection('sites/site/lists/list/items'));
        self::assertStringContainsString('%24skiptoken=second', $requests[1]['request']->getUri()->getQuery());
    }

    #[DataProvider('badPages')]
    public function test_pagination_cannot_send_credentials_to_another_resource(string $next): void
    {
        $requests = [];
        $graph = new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'), $this->mockClient([
            new Response(200, [], json_encode(['value' => [], '@odata.nextLink' => $next])),
        ], $requests));
        $this->expectExceptionMessage('SHAREPOINT_INVALID_PAGINATION'); $graph->collection('sites/site/lists/list/items');
    }

    public static function badPages(): array
    {
        return [['https://attacker.test/v1.0/sites/site/lists/list/items'], ['https://graph.microsoft.com/v1.0/sites/other/lists/list/items'],
            ['https://graph.microsoft.com:8443/v1.0/sites/site/lists/list/items'], ['https://graph.microsoft.com/v1.0/sites/site/lists/list/items?0=evil']];
    }

    public function test_client_credentials_uses_form_body_and_caches_only_valid_bearer_tokens(): void
    {
        $requests = [];
        $client = $this->mockClient([new Response(200, [], '{"access_token":"fixture-token","token_type":"Bearer","expires_in":3600}')], $requests);
        $provider = new ClientCredentialsToken($this->settings(), 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token', 'client', 'private-secret', 'https://graph.microsoft.com/.default', $client);
        self::assertSame('fixture-token', $provider->token()); self::assertSame('fixture-token', $provider->token());
        self::assertCount(1, $requests); self::assertSame('', $requests[0]['request']->getUri()->getQuery());
        parse_str((string) $requests[0]['request']->getBody(), $form);
        self::assertSame('client_credentials', $form['grant_type']); self::assertSame('private-secret', $form['client_secret']);
        self::assertFalse($requests[0]['options']['allow_redirects']);
    }

    public function test_authentication_failure_redacts_provider_details(): void
    {
        $requests = [];
        $provider = new ClientCredentialsToken($this->settings(), 'https://identity.example.test/token', 'client', 'private-secret', 'scope',
            $this->mockClient([new Response(401, [], 'private-secret')], $requests));
        $this->expectExceptionMessage('SERVICE_AUTHENTICATION_FAILED'); $provider->token();
    }

    public function test_oidc_tenants_cannot_share_the_same_list_or_snapshot_folder(): void
    {
        $target = ['site_id' => 'site', 'list_id' => 'list', 'drive_id' => 'drive', 'folder_id' => 'folder'];
        $this->expectExceptionMessage('Tenants require distinct SharePoint lists and folders.');
        $this->settings(['OIDC_TENANT_SHAREPOINT_REPOSITORIES' => json_encode([str_repeat('a', 64) => $target, str_repeat('b', 64) => $target])]);
    }
    #[DataProvider('unsafePaths')]
    public function test_logical_path_injection_is_rejected_before_graph_access(string $path): void
    {
        $fixture = new SharePointGraphFixture();
        try { $this->repository($fixture)->saveArtifact('project', $path, 'unsafe', [], null); self::fail('Unsafe path accepted.'); }
        catch (\InvalidArgumentException $error) { self::assertSame('INVALID_ARTIFACT_PATH', $error->getMessage()); }
        self::assertSame([], $fixture->requests);
    }

    public static function unsafePaths(): array { return [['../../secret'], ['templates/../secret'], ['templates/%2e%2e/secret'], ['templates/a?redirect=evil']]; }

    public function test_snapshot_pointer_cannot_read_outside_its_configured_folder(): void
    {
        $requests = [];
        $responses = [new Response(200, [], json_encode(['value' => [
            ['name' => 'ModelProjectId', 'text' => new \stdClass(), 'indexed' => true, 'enforceUniqueValues' => true],
            ['name' => 'SnapshotItemId', 'text' => new \stdClass()], ['name' => 'SnapshotHash', 'text' => new \stdClass()],
        ]])), new Response(200, [], json_encode(['value' => [['id' => '1', 'eTag' => '\"1\"', 'fields' => [
            'ModelProjectId' => 'project', 'SnapshotItemId' => 'item', 'SnapshotHash' => str_repeat('a', 64),
        ]]]])), new Response(200, [], '{"parentReference":{"id":"other-tenant"},"size":10,"file":{}}')];
        $repository = new SharePointRepository($this->settings(), new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'), $this->mockClient($responses, $requests)));
        try { $repository->getProject('project'); self::fail('Cross-folder pointer accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('SHAREPOINT_INVALID_SNAPSHOT', $error->getMessage()); }
        self::assertCount(3, $requests, 'Content request must not be sent.');
    }

    #[DataProvider('badTokenResponses')]
    public function test_invalid_oauth_tokens_fail_closed(Response $response): void
    {
        $requests = [];
        $provider = new ClientCredentialsToken($this->settings(), 'https://identity.example.test/token', 'client', 'secret', 'scope',
            $this->mockClient([$response], $requests));
        $this->expectExceptionMessage('SERVICE_AUTHENTICATION_FAILED'); $provider->token();
    }

    public static function badTokenResponses(): array
    {
        return [[new Response(302, ['Location' => 'https://attacker.test'])], [new Response(200, [], '{bad')],
            [new Response(200, [], '{"access_token":"value","token_type":"Basic","expires_in":3600}')],
            [new Response(200, [], '{"access_token":"value","token_type":"Bearer","expires_in":0}')],
            [new Response(200, [], json_encode(['access_token' => "bad\r\nHeader", 'token_type' => 'Bearer', 'expires_in' => 3600]))],
            [new Response(200, [], str_repeat('x', 65537))]];
    }

    public function test_expired_service_credential_is_refreshed(): void
    {
        $requests = [];
        $responses = array_map(fn ($token) => new Response(200, [], json_encode(['access_token' => $token, 'token_type' => 'Bearer', 'expires_in' => 3600])), ['first', 'second']);
        $provider = new ClientCredentialsToken($this->settings(), 'https://identity.example.test/token', 'client', 'secret', 'scope', $this->mockClient($responses, $requests));
        self::assertSame('first', $provider->token());
        (new \ReflectionProperty($provider, 'expires'))->setValue($provider, time() - 1);
        self::assertSame('second', $provider->token()); self::assertCount(2, $requests);
    }

    public function test_oversized_graph_response_and_second_redirect_are_rejected(): void
    {
        $requests = [];
        $graph = new GraphClient($this->settings(['MAX_UPSTREAM_BYTES' => '100']), new ConfiguredAccessToken('fixture-token'),
            $this->mockClient([new Response(200, [], str_repeat('x', 101))], $requests));
        try { $graph->content('drives/drive/items/item/content'); self::fail('Oversize response accepted.'); }
        catch (\RuntimeException $error) { self::assertSame('SHAREPOINT_RESPONSE_TOO_LARGE', $error->getMessage()); }
        $downloads = [];
        $graph = new GraphClient($this->settings(), new ConfiguredAccessToken('fixture-token'),
            $this->mockClient([new Response(302, ['Location' => 'https://tenant.sharepoint.com/file'])], $requests),
            $this->mockClient([new Response(302, ['Location' => 'https://attacker.test'])], $downloads));
        $this->expectExceptionMessage('SHAREPOINT_UNAVAILABLE'); $graph->content('drives/drive/items/item/content');
    }

    public function test_oidc_provider_requires_a_signed_tenant_mapping(): void
    {
        $settings = $this->settings(['AUTH_MODE' => 'oidc']);
        $this->expectExceptionMessage('TENANT_REPOSITORY_NOT_CONFIGURED');
        \OpenEHR\Assistant\Integrations\Repository\RepositoryFactory::create($settings, new \OpenEHR\Assistant\Auth\Principal('subject', str_repeat('a', 64)));
    }

    public function test_oidc_provider_uses_the_tenant_list_and_folder_without_a_global_fallback(): void
    {
        $tenant = str_repeat('a', 64);
        $settings = $this->settings(['AUTH_MODE' => 'oidc', 'OIDC_TENANT_SHAREPOINT_REPOSITORIES' => json_encode([
            $tenant => ['site_id' => 'tenant-site', 'list_id' => 'tenant-list', 'drive_id' => 'tenant-drive', 'folder_id' => 'tenant-folder'],
        ])]);
        $repository = \OpenEHR\Assistant\Integrations\Repository\RepositoryFactory::create($settings, new \OpenEHR\Assistant\Auth\Principal('subject', $tenant));
        self::assertInstanceOf(SharePointRepository::class, $repository);
        $store = (new \ReflectionProperty(\OpenEHR\Assistant\Domain\Repository\SnapshotRepository::class, 'store'))->getValue($repository);
        self::assertSame('sites/tenant-site/lists/tenant-list', (new \ReflectionProperty($store, 'listPath'))->getValue($store));
        self::assertSame('tenant-folder', (new \ReflectionProperty($store, 'folder'))->getValue($store));
    }

    public function test_deep_metadata_is_rejected_before_any_remote_mutation(): void
    {
        $fixture = new SharePointGraphFixture(); $repository = $this->repository($fixture);
        $metadata = ['leaf' => 'value'];
        for ($i = 0; $i < 65; $i++) { $metadata = ['nested' => $metadata]; }
        try { $repository->saveArtifact('project', 'templates/test.oet', '<draft/>', $metadata, null); self::fail('Deep metadata accepted.'); }
        catch (\InvalidArgumentException $error) { self::assertSame('INVALID_ARTIFACT_METADATA', $error->getMessage()); }
        self::assertSame([], $fixture->requests);
    }

}
