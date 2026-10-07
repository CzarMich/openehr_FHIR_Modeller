<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Firebase\JWT\JWT;
use Nyholm\Psr7\ServerRequest;
use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Governance\ValidationProvider;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Repository\FileSystemRepository;
use OpenEHR\Assistant\Rest\ReviewApi;
use OpenEHR\Assistant\Tests\Helpers\OutputSchemaValidator;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class ReviewApiTest extends TestCase
{
    private const string KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private string $directory;
    private Settings $settings;
    private SqliteAuditStore $audit;
    private ReviewApi $api;
    private array $view;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/review-api-' . bin2hex(random_bytes(8));
        $this->settings = new Settings(['GOVERNANCE_ENABLED' => 'true', 'GOVERNANCE_BROWSER_ORIGIN' => 'https://models.example',
            'GOVERNANCE_OIDC_ISSUER' => 'https://identity.example', 'GOVERNANCE_BROWSER_KEYS' => json_encode(['active' => self::KEY], JSON_THROW_ON_ERROR),
            'MODEL_REPOSITORY_WRITE_ENABLED' => 'true', 'MODEL_REPOSITORY_PATH' => $this->directory, 'MCP_ALLOWED_HOSTS' => 'models.example',
            'AUTH_MODE' => 'api_key', 'AUTH_API_KEY' => str_repeat('z', 64)]);
        $repository = new FileSystemRepository($this->directory); $repository->createProject('project', 'Synthetic', '');
        $source = $repository->saveArtifact('project', 'templates/test.oet', TerminologyBindingPlanTest::MODEL, [], null);
        $this->audit = new SqliteAuditStore(':memory:');
        $validator = $this->createStub(ValidationProvider::class);
        $validator->method('evaluate')->willReturnCallback(static fn (string $content, string $format): array => ModelGovernanceTest::qualifiedReport($content));
        $service = new ModelGovernance($repository, $this->audit, new ReviewPolicy(), $validator, new AccessPolicy($this->settings), new Actor('service', 'shared', ['modeller']));
        $view = $service->prepare('project', 'templates/test.oet', $source['revision'], 'Synthetic review fixture.');
        $view = $service->validate($view['subject'], $view['sequence']);
        $this->view = $service->transition($view['subject'], $view['sequence'], 'REVIEW_REQUESTED', 'Synthetic review request.');
        $this->api = new ReviewApi($this->settings, $this->audit, $validator);
    }
    protected function tearDown(): void
    {
        $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->directory, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $file) { $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname()); } rmdir($this->directory);
    }
    private function request(string $method, string $target, array $input = [], array $replace = []): ServerRequest
    {
        $body = $method === 'GET' ? '' : json_encode($input, JSON_THROW_ON_ERROR);
        $claims = array_replace(['iss' => 'https://models.example', 'aud' => 'openehr-modelling-review', 'identity_issuer' => 'https://identity.example',
            'sub' => 'human-fixture', 'tenant' => 'https://identity.example', 'roles' => ['modelling-reviewer', 'modelling-approver'],
            'iat' => time(), 'exp' => time() + 60, 'session_started' => time(), 'jti' => bin2hex(random_bytes(32)),
            'method' => $method, 'target' => $target, 'body_sha256' => hash('sha256', $body)], $replace);
        $token = JWT::encode($claims, self::KEY, 'HS256', 'active', ['typ' => 'openehr-review+jwt']);
        return new ServerRequest($method, 'https://models.example' . $target, ['Authorization' => 'Bearer ' . $token, 'Content-Type' => 'application/json'], $body);
    }
    private function target(): string { return '/api/v1/reviews/' . $this->view['subject']; }
    public function test_chat_session_reads_governance_without_decision_freshness_bypass(): void
    {
        $old = ['session_started' => time() - 1800, 'roles' => ['modelling-administrator']];
        self::assertSame(200, $this->api->handle($this->request('GET', $this->target(), replace: $old))->getStatusCode());
        self::assertSame(401, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input(), $old))->getStatusCode());
        self::assertSame(401, $this->api->handle($this->request('GET', $this->target(), replace: ['session_started' => time() - 3601]))->getStatusCode());
        $noRole = $this->api->handle($this->request('GET', $this->target(), replace: ['roles' => ['administrator']]));
        self::assertSame(403, $noRole->getStatusCode());
        self::assertStringContainsString('GOVERNANCE_ROLE_REQUIRED', (string) $noRole->getBody());
    }
    public function test_platform_administrator_has_all_governance_roles_without_skipping_lifecycle(): void
    {
        $owner = ['roles' => ['modelling-administrator']];
        self::assertSame(403, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input('PUBLISHED'), $owner))->getStatusCode());
        $response = $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input(), $owner));
        self::assertSame(200, $response->getStatusCode());
        $this->view = json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR);
        self::assertSame(200, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input('APPROVED'), $owner))->getStatusCode());
    }
    private function input(string $state = 'REVIEWED'): array
    {
        return ['state' => $state, 'expectedSequence' => $this->view['sequence'], 'comment' => 'Synthetic human review.', 'validationDigest' => $this->view['validation_digest']];
    }
    private function assertContract(array $value, string $name): void
    {
        $document = json_decode(file_get_contents(__DIR__ . '/../../docs/openapi/reviews.json'), true, 64, JSON_THROW_ON_ERROR);
        $resolve = function (array $schema) use (&$resolve, $document): array {
            if (isset($schema['$ref'])) {
                $prefix = '#/components/schemas/';
                self::assertStringStartsWith($prefix, $schema['$ref']);
                return $resolve($document['components']['schemas'][substr($schema['$ref'], strlen($prefix))]);
            }
            foreach ($schema as $key => $value) { if (is_array($value)) { $schema[$key] = $resolve($value); } }
            return $schema;
        };
        OutputSchemaValidator::assertValid($value, $resolve($document['components']['schemas'][$name]));
        $this->addToAssertionCount(1);
    }
    public function test_signed_browser_request_reads_source_and_records_an_exact_human_transition(): void
    {
        $list = $this->api->handle($this->request('GET', '/api/v1/reviews?project=project')); self::assertSame(200, $list->getStatusCode());
        self::assertCount(1, json_decode((string) $list->getBody(), true, 64, JSON_THROW_ON_ERROR)['items']);
        $this->assertContract(json_decode((string) $list->getBody(), true, 64, JSON_THROW_ON_ERROR), 'ReviewList');
        $read = $this->api->handle($this->request('GET', $this->target())); self::assertSame(200, $read->getStatusCode());
        $result = json_decode((string) $read->getBody(), true, 64, JSON_THROW_ON_ERROR);
        $this->assertContract($result, 'Review');
        self::assertSame(TerminologyBindingPlanTest::MODEL, $result['content']); self::assertContains('REVIEWED', $result['available_transitions']);
        $request = $this->request('POST', $this->target() . '/transitions', $this->input());
        $response = $this->api->handle($request); self::assertSame(200, $response->getStatusCode());
        $view = json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR); self::assertSame('REVIEWED', $view['state']);
        $this->assertContract($view, 'Review');
        self::assertTrue($view['events'][3]['actor']['human']); self::assertFalse($view['clinical_approval']);
        self::assertSame(401, $this->api->handle($request)->getStatusCode());
        self::assertSame(409, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input()))->getStatusCode());
        $this->view = $view;
        $response = $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input('APPROVED')));
        self::assertSame(200, $response->getStatusCode()); self::assertSame('APPROVED', json_decode((string) $response->getBody(), true, 64, JSON_THROW_ON_ERROR)['state']);
    }
    public function test_model_api_key_and_raw_author_claim_cannot_approve(): void
    {
        $request = $this->request('POST', $this->target() . '/transitions', $this->input('APPROVED'))->withoutHeader('Authorization')->withHeader('X-API-Key', str_repeat('z', 64));
        self::assertSame(401, $this->api->handle($request)->getStatusCode());
        self::assertSame(400, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input() + ['human' => true]))->getStatusCode());
        self::assertCount(3, $this->audit->events('shared', $this->view['subject']));
    }
    public function test_host_origin_query_method_and_json_contracts_are_enforced(): void
    {
        self::assertSame(403, $this->api->handle($this->request('GET', $this->target())->withHeader('Host', 'evil.example'))->getStatusCode());
        self::assertSame(403, $this->api->handle($this->request('GET', $this->target())->withHeader('Origin', 'https://evil.example'))->getStatusCode());
        self::assertSame(400, $this->api->handle($this->request('GET', '/api/v1/reviews?project=project&actor=forged'))->getStatusCode());
        self::assertSame(405, $this->api->handle($this->request('DELETE', $this->target()))->getStatusCode());
        self::assertSame(415, $this->api->handle($this->request('POST', $this->target() . '/transitions', $this->input())->withHeader('Content-Type', 'text/plain'))->getStatusCode());
    }
}
