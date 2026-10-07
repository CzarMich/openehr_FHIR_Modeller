<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Firebase\JWT\JWT;
use Nyholm\Psr7\ServerRequest;
use OpenEHR\Assistant\Auth\InteractiveReviewAuthenticator;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class InteractiveReviewAuthenticatorTest extends TestCase
{
    private const string KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    private const string ORIGIN = 'https://models.example';
    private const string ISSUER = 'https://identity.example/realm';
    private const string LOCAL_ISSUER = 'https://models.example/identity/local';
    private const string BODY = '{"state":"REVIEWED"}';
    private const string TARGET = '/api/v1/reviews/' . 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' . '/transitions';

    private function settings(array $overrides = []): Settings
    {
        return new Settings(array_replace(['GOVERNANCE_ENABLED' => 'true', 'GOVERNANCE_BROWSER_ORIGIN' => self::ORIGIN,
            'GOVERNANCE_OIDC_ISSUER' => self::ISSUER, 'GOVERNANCE_BROWSER_KEYS' => json_encode(['active' => self::KEY, 'previous' => str_repeat('b', 64)], JSON_THROW_ON_ERROR)], $overrides));
    }
    private function claims(array $replace = []): array
    {
        return array_replace(['iss' => self::ORIGIN, 'aud' => 'openehr-modelling-review', 'identity_issuer' => self::ISSUER,
            'sub' => 'reviewer-subject', 'tenant' => self::ISSUER, 'roles' => ['modelling-reviewer', 'modelling-approver'],
            'iat' => time(), 'exp' => time() + 60, 'session_started' => time() - 30, 'jti' => bin2hex(random_bytes(32)),
            'method' => 'POST', 'target' => self::TARGET, 'body_sha256' => hash('sha256', self::BODY)], $replace);
    }
    private function request(array $claims = [], string $key = self::KEY, string $kid = 'active', string $type = 'openehr-review+jwt'): ServerRequest
    {
        $jwt = JWT::encode($this->claims($claims), $key, 'HS256', $kid, ['typ' => $type]);
        return new ServerRequest('POST', self::ORIGIN . self::TARGET, ['Authorization' => 'Bearer ' . $jwt], self::BODY);
    }
    public function test_exact_request_creates_a_human_actor_once_and_maps_only_configured_roles(): void
    {
        $auth = new InteractiveReviewAuthenticator($this->settings(), new SqliteAuditStore(':memory:')); $request = $this->request();
        $actor = $auth->authenticate($request); self::assertNotNull($actor); self::assertTrue($actor->human);
        self::assertSame(['reviewer', 'approver'], $actor->roles); self::assertSame('shared', $actor->tenant);
        self::assertNull($auth->authenticate($request));
        $ordinaryAdmin = $auth->authenticate($this->request(['roles' => ['administrator']])); self::assertNotNull($ordinaryAdmin); self::assertSame([], $ordinaryAdmin->roles);
        $platformAdmin = $auth->authenticate($this->request(['roles' => ['modelling-administrator']])); self::assertNotNull($platformAdmin);
        self::assertSame(['modeller', 'reviewer', 'approver', 'publisher'], $platformAdmin->roles);
    }
    public function test_signed_project_scopes_are_retained_for_repository_authorization(): void
    {
        $auth = new InteractiveReviewAuthenticator($this->settings(), new SqliteAuditStore(':memory:'));
        $actor = $auth->authenticate($this->request(['project_scopes' => ['project:alpha:read', 'project:beta:write']]));
        self::assertNotNull($actor);
        self::assertSame(['project:alpha:read', 'project:beta:write'], $actor->projectScopes);
    }
    public function test_oidc_actor_identity_and_tenant_match_native_bearer_subject_without_granting_bearer_human_status(): void
    {
        $settings = $this->settings(['AUTH_MODE' => 'oidc', 'OIDC_ISSUER' => self::ISSUER, 'OIDC_AUDIENCE' => 'modelling-api',
            'OIDC_TENANT_CLAIM' => 'organisation', 'OIDC_ALLOWED_TENANTS' => 'hospital-a']);
        $auth = new InteractiveReviewAuthenticator($settings, new SqliteAuditStore(':memory:'));
        $actor = $auth->authenticate($this->request(['tenant' => 'hospital-a'])); self::assertNotNull($actor);
        self::assertSame(Principal::tenantNamespace(self::ISSUER, 'hospital-a'), $actor->tenant);
        self::assertSame('oidc:' . hash('sha256', json_encode([self::ISSUER, 'hospital-a', 'reviewer-subject'], JSON_THROW_ON_ERROR)), $actor->id);
        self::assertNull($auth->authenticate($this->request(['tenant' => 'hospital-b'])));
    }
    public function test_configured_native_local_identity_is_a_distinct_human_method(): void
    {
        $settings = $this->settings(['GOVERNANCE_LOCAL_IDENTITY_ISSUER' => self::LOCAL_ISSUER]);
        $auth = new InteractiveReviewAuthenticator($settings, new SqliteAuditStore(':memory:'));
        $claims = ['identity_issuer' => self::LOCAL_ISSUER, 'identity_method' => 'interactive_local', 'tenant' => self::LOCAL_ISSUER];
        $actor = $auth->authenticate($this->request($claims));
        self::assertNotNull($actor);
        self::assertTrue($actor->human);
        self::assertSame('interactive_local', $actor->method);
        self::assertStringStartsWith('local:', $actor->id);
        self::assertSame('shared', $actor->tenant);
        self::assertNull($auth->authenticate($this->request([...$claims, 'identity_issuer' => self::ISSUER])));
    }
    public static function invalidClaims(): array
    {
        return [[['iss' => 'https://other.example']], [['aud' => 'modelling-api']], [['identity_issuer' => 'https://other.identity']],
            [['sub' => '']], [['exp' => 1]], [['iat' => 1]], [['exp' => time() + 86400]], [['iat' => time() + 86400]],
            [['session_started' => time() - 86400]], [['session_started' => time() + 86400]], [['method' => 'GET']],
            [['target' => '/mcp']], [['body_sha256' => str_repeat('0', 64)]], [['jti' => 'bad']], [['tenant' => 'another']],
            [['roles' => 'modelling-approver']], [['roles' => array_fill(0, 101, 'modelling-approver')]],
            [['project_scopes' => 'project:alpha:read']], [['project_scopes' => ['project:*:read']]],
            [['project_scopes' => array_fill(0, 101, 'project:alpha:read')]]];
    }
    #[DataProvider('invalidClaims')]
    public function test_wrong_audience_time_identity_roles_and_request_binding_fail_closed(array $claims): void
    {
        $auth = new InteractiveReviewAuthenticator($this->settings(), new SqliteAuditStore(':memory:'));
        self::assertNull($auth->authenticate($this->request($claims)));
    }
    public function test_token_type_key_id_signature_and_rotation_are_verified(): void
    {
        $auth = new InteractiveReviewAuthenticator($this->settings(), new SqliteAuditStore(':memory:'));
        self::assertNull($auth->authenticate($this->request(type: 'JWT')));
        self::assertNull($auth->authenticate($this->request(key: str_repeat('c', 64))));
        self::assertNull($auth->authenticate($this->request(kid: 'unknown')));
        self::assertNotNull($auth->authenticate($this->request(key: str_repeat('b', 64), kid: 'previous')));
        $retired = new InteractiveReviewAuthenticator($this->settings(['GOVERNANCE_BROWSER_KEYS' => json_encode(['active' => self::KEY], JSON_THROW_ON_ERROR)]), new SqliteAuditStore(':memory:'));
        self::assertNull($retired->authenticate($this->request(key: str_repeat('b', 64), kid: 'previous')));
    }
    public function test_disabled_feature_and_plain_api_credentials_cannot_attest_a_human(): void
    {
        $auth = new InteractiveReviewAuthenticator($this->settings(['GOVERNANCE_ENABLED' => 'false']), new SqliteAuditStore(':memory:'));
        self::assertNull($auth->authenticate($this->request()));
        $auth = new InteractiveReviewAuthenticator($this->settings(), new SqliteAuditStore(':memory:'));
        self::assertNull($auth->authenticate(new ServerRequest('POST', self::ORIGIN . self::TARGET, ['X-API-Key' => str_repeat('a', 64)], self::BODY)));
    }
}
