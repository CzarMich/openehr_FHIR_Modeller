<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenEHR\Assistant\Application\RepositoryService;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Integrations\Repository\Hosted\HostedProviderFactory;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Tools\RepositoryTools;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class HostedRepositoryTest extends TestCase
{
    private array $requests = [];

    private function provider(string $kind, array $responses, array $settings = []): \OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider
    {
        $stack = HandlerStack::create(new MockHandler(array_map(fn ($data) => $data instanceof Response ? $data : new Response(200, [], json_encode($data)), $responses)));
        $stack->push(Middleware::history($this->requests));
        $config = new Settings($settings + ['MODEL_REPOSITORY_PROVIDER' => $kind, 'MODEL_HOSTED_TOKEN' => 'private-test-token',
            'MODEL_GIT_REMOTE_URL' => $kind === 'github' ? 'ssh://git@github.com/clinic/models.git' : 'https://gitlab.example.org/group/sub/models.git']);
        return HostedProviderFactory::create($config, new Client(['handler' => $stack, 'base_uri' => 'https://example.org/']))
            ?? throw new \LogicException('Fixture has no provider.');
    }

    private function githubReview(): array
    {
        return ['number' => 7, 'html_url' => 'https://github.com/clinic/models/pull/7', 'title' => 'Review model', 'state' => 'open', 'draft' => true,
            'head' => ['ref' => 'model/admission', 'sha' => str_repeat('a', 40), 'repo' => ['full_name' => 'clinic/models']],
            'base' => ['ref' => 'main', 'sha' => str_repeat('b', 40)], 'merged' => false];
    }

    private function gitlabReview(): array
    {
        return ['iid' => 8, 'web_url' => 'https://gitlab.example.org/group/sub/models/-/merge_requests/8',
            'title' => 'Draft: Review model', 'state' => 'opened', 'draft' => true, 'source_branch' => 'model/admission',
            'target_branch' => 'main', 'source_project_id' => 12, 'target_project_id' => 12, 'sha' => str_repeat('c', 40),
            'diff_refs' => ['base_sha' => str_repeat('b', 40)]];
    }

    public function test_github_metadata_branches_and_reviews_use_pinned_api_contract(): void
    {
        $provider = $this->provider('github', [
            ['html_url' => 'https://github.com/clinic/models', 'default_branch' => 'main', 'private' => true, 'archived' => false],
            [['name' => 'main', 'commit' => ['sha' => str_repeat('b', 40)], 'protected' => true], ['name' => 'draft', 'commit' => ['sha' => 'unknown']]],
            [], $this->githubReview(), [$this->githubReview()], $this->githubReview(),
        ]);
        self::assertSame('clinic/models', $provider->metadata()['repository']);
        $branches = $provider->branches(2);
        self::assertTrue($branches['branches'][0]['protected']);
        self::assertNull($branches['branches'][1]['protected']);
        self::assertNull($branches['next_page']);
        $review = $provider->requestReview('model/admission', 'main', 'Review model', 'Review evidence');
        self::assertTrue($review['created']); self::assertTrue($review['draft']); self::assertFalse($review['clinical_approval']);
        self::assertFalse($provider->requestReview('model/admission', 'main', 'Review model', '')['created']);
        self::assertSame(7, $provider->review(7)['number']);
        $post = $this->requests[3]['request']; $payload = json_decode((string) $post->getBody(), true);
        self::assertSame('POST', $post->getMethod()); self::assertTrue($payload['draft']);
        self::assertFalse($payload['maintainer_can_modify']);
        self::assertSame('/repos/clinic/models/pulls', $post->getUri()->getPath());
        self::assertSame('2026-03-10', $post->getHeaderLine('X-GitHub-Api-Version'));
        self::assertSame('Bearer private-test-token', $post->getHeaderLine('Authorization'));
        self::assertStringContainsString('page=2', $this->requests[1]['request']->getUri()->getQuery());
    }

    public function test_gitlab_nested_project_paths_are_encoded_once_and_drafts_are_reused(): void
    {
        $provider = $this->provider('gitlab', [
            ['web_url' => 'https://gitlab.example.org/group/sub/models', 'default_branch' => 'main', 'visibility' => 'private'],
            [['name' => 'main', 'commit' => ['id' => 'revision'], 'protected' => true]],
            [], $this->gitlabReview(), [$this->gitlabReview()], $this->gitlabReview(),
        ]);
        self::assertSame('group/sub/models', $provider->metadata()['repository']);
        self::assertTrue($provider->branches()['branches'][0]['protected']);
        self::assertTrue($provider->requestReview('model/admission', 'main', 'Review model', 'Evidence')['draft']);
        self::assertFalse($provider->requestReview('model/admission', 'main', 'Review model', '')['created']);
        self::assertSame(8, $provider->review(8)['number']);
        $post = $this->requests[3]['request'];
        self::assertSame('/projects/group%2Fsub%2Fmodels/merge_requests', $post->getUri()->getPath());
        self::assertSame('private-test-token', $post->getHeaderLine('PRIVATE-TOKEN'));
        self::assertSame('', $post->getHeaderLine('Authorization'));
        self::assertSame('Draft: Review model', json_decode((string) $post->getBody(), true)['title']);
    }

    public function test_fork_request_cannot_be_reused_as_our_repository_review(): void
    {
        $fork = $this->githubReview(); $fork['head']['repo']['full_name'] = 'another/models';
        $provider = $this->provider('github', [[$fork], $this->githubReview()]);
        self::assertTrue($provider->requestReview('model/admission', 'main', 'Review model', '')['created']);
        self::assertCount(2, $this->requests);
    }

    #[DataProvider('errors')]
    public function test_provider_errors_do_not_echo_bodies_or_forward_tokens(int $status, string $expected): void
    {
        $provider = $this->provider('github', [new Response($status, ['Location' => 'https://attacker.invalid'], 'private-test-token')]);
        try { $provider->metadata(); self::fail('Upstream error accepted.'); }
        catch (\RuntimeException $error) { self::assertSame($expected, $error->getMessage()); }
        self::assertCount(1, $this->requests);
        self::assertFalse($this->requests[0]['options']['allow_redirects']);
    }

    public static function errors(): array
    {
        return [[301, 'HOSTED_REPOSITORY_UNAVAILABLE'], [401, 'HOSTED_REPOSITORY_ACCESS_DENIED'], [403, 'HOSTED_REPOSITORY_ACCESS_DENIED'],
            [404, 'HOSTED_REPOSITORY_NOT_FOUND'], [409, 'HOSTED_REVIEW_CONFLICT'], [422, 'HOSTED_REVIEW_CONFLICT'],
            [429, 'HOSTED_REPOSITORY_RATE_LIMITED'], [500, 'HOSTED_REPOSITORY_UNAVAILABLE']];
    }

    #[DataProvider('invalidConfigurations')]
    public function test_configuration_rejects_host_mismatch_credentials_and_path_injection(array $settings): void
    {
        $this->expectException(\InvalidArgumentException::class);
        HostedProviderFactory::create(new Settings($settings + ['MODEL_REPOSITORY_PROVIDER' => 'github', 'MODEL_GIT_REMOTE_URL' => 'ssh://git@github.com/clinic/models.git']));
    }

    public static function invalidConfigurations(): array
    {
        return [[['MODEL_GIT_REMOTE_URL' => '']], [['MODEL_GIT_REMOTE_URL' => 'https://token@github.com/clinic/models.git']],
            [['MODEL_GIT_REMOTE_URL' => 'http://github.com/clinic/models']], [['MODEL_GIT_REMOTE_URL' => 'https://github.com/clinic/%2e%2e']],
            [['MODEL_GIT_REMOTE_URL' => 'https://github.com/clinic/models?token=secret']], [['MODEL_GIT_REMOTE_URL' => '/local/models.git']],
            [['MODEL_HOSTED_API_URL' => 'https://attacker.invalid/api']], [['MODEL_HOSTED_TOKEN' => "token\r\nInjected: yes"]]];
    }

    #[DataProvider('badBranches')]
    public function test_review_input_is_validated_before_network(string $branch): void
    {
        $provider = $this->provider('github', []);
        $this->expectException(\InvalidArgumentException::class);
        try { $provider->requestReview($branch, 'main', 'Review', ''); }
        finally { self::assertSame([], $this->requests); }
    }

    public static function badBranches(): array { return [['main'], ['../escape'], ['-flag'], ['a//b'], ['a.lock'], ['a/.b'], ["a\nHeader"]]; }

    public function test_oversized_response_fails_without_returning_partial_metadata(): void
    {
        $provider = $this->provider('github', [new Response(200, [], str_repeat('x', 101))], ['MAX_UPSTREAM_BYTES' => '100']);
        $this->expectExceptionMessage('HOSTED_RESPONSE_TOO_LARGE'); $provider->metadata();
    }

    public function test_untrusted_browser_link_is_rejected(): void
    {
        $review = $this->githubReview(); $review['html_url'] = 'https://attacker.invalid/fake';
        $this->expectExceptionMessage('HOSTED_INVALID_RESPONSE'); $this->provider('github', [$review])->review(7);
    }

    public function test_invalid_json_is_rejected(): void
    {
        $this->expectExceptionMessage('HOSTED_INVALID_RESPONSE'); $this->provider('gitlab', [new Response(200, [], '{bad')])->metadata();
    }

    public function test_page_boundary_is_explicit(): void
    {
        $items = array_fill(0, 100, ['name' => 'main', 'commit' => ['sha' => 'revision']]);
        self::assertSame(4, $this->provider('github', [$items])->branches(3)['next_page']);
    }

    public function test_readonly_and_oidc_reader_cannot_open_reviews_or_create_branches(): void
    {
        $repository = $this->createStub(ModelRepository::class);
        foreach ([new Settings(), new Settings(['AUTH_MODE' => 'oidc', 'MODEL_REPOSITORY_WRITE_ENABLED' => 'true'])] as $settings) {
            $service = new RepositoryTools(new RepositoryService($repository, new AccessPolicy($settings), $settings));
            self::assertFalse($service->createBranch('model/new', str_repeat('a', 40))['success']);
            self::assertFalse($service->requestReview('model/new', 'Review')['success']);
        }
    }

    public function test_equivalent_ssh_and_https_remotes_cannot_cross_tenant_boundaries(): void
    {
        $this->expectExceptionMessage('Tenants require distinct Git remotes.');
        new Settings(['OIDC_TENANT_GIT_REMOTES' => json_encode([
            str_repeat('a', 64) => 'ssh://git@github.com/Clinic/Models.git',
            str_repeat('b', 64) => 'https://github.com/clinic/models',
        ])]);
    }

    public function test_tenant_repository_identity_comes_from_scoped_git_remote(): void
    {
        $root = sys_get_temp_dir() . '/hosted-tenant-' . bin2hex(random_bytes(8));
        $tenant = str_repeat('a', 64);
        $principal = new Principal('test', $tenant);
        $settings = new Settings(['AUTH_MODE' => 'oidc', 'MODEL_REPOSITORY_PROVIDER' => 'github', 'MODEL_REPOSITORY_PATH' => $root,
            'OIDC_TENANT_GIT_REMOTES' => json_encode([$tenant => 'ssh://git@github.com/tenant-a/models.git'])]);
        try {
            self::assertFalse(RepositoryFactory::create($settings)->capabilities()['reviews']);
            $repository = RepositoryFactory::create($settings, $principal);
            self::assertTrue($repository->capabilities()['reviews']);
            $property = new \ReflectionProperty($repository->hosting(), 'repository');
            self::assertSame('tenant-a/models', $property->getValue($repository->hosting()));
        } finally {
            if (is_dir($root)) {
                $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
                foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); }
                rmdir($root);
            }
        }
    }
}
