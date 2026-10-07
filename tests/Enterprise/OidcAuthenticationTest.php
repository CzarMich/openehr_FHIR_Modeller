<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use Firebase\JWT\JWT;
use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Response;
use Nyholm\Psr7\ServerRequest;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Auth\OidcAuthenticator;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\Cache\Psr16Cache;

#[CoversNothing]
final class OidcAuthenticationTest extends TestCase
{
    private static string $private = '';
    private static array $jwk;

    public static function setUpBeforeClass(): void
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($key, self::$private);
        $details = openssl_pkey_get_details($key);
        self::$jwk = ['kid' => 'test-key', 'kty' => 'RSA', 'alg' => 'RS256', 'use' => 'sig',
            'n' => JWT::urlsafeB64Encode($details['rsa']['n']), 'e' => JWT::urlsafeB64Encode($details['rsa']['e'])];
    }

    private function settings(array $overrides = []): Settings
    {
        return new Settings(array_replace(['AUTH_MODE' => 'oidc', 'OIDC_ISSUER' => 'https://identity.example/tenant',
            'OIDC_AUDIENCE' => 'modelling-api', 'OIDC_JWKS_URI' => 'https://identity.example/tenant/keys',
            'OIDC_ALLOWED_CLIENT_IDS' => 'trusted-client', 'OIDC_TENANT_CLAIM' => 'tid', 'OIDC_ALLOWED_TENANTS' => 'one,two'], $overrides));
    }

    private function claims(array $overrides = []): array
    {
        return array_replace(['iss' => 'https://identity.example/tenant', 'aud' => 'modelling-api', 'sub' => 'user-one',
            'exp' => time() + 600, 'iat' => time(), 'scope' => 'modelling.read', 'azp' => 'trusted-client',
            'tid' => 'one', 'roles' => ['reader'], 'amr' => ['pwd', 'otp']], $overrides);
    }

    private function verifier(?Psr16Cache $cache = null, ?MockHandler $mock = null, ?Settings $settings = null): OidcAuthenticator
    {
        $mock ??= new MockHandler([new Response(200, [], json_encode(['keys' => [self::$jwk]]))]);
        return new OidcAuthenticator($settings ?? $this->settings(), new Client(['handler' => HandlerStack::create($mock)]), $cache ?? new Psr16Cache(new ArrayAdapter()));
    }

    private function request(array $claims, string $key = '', string $kid = 'test-key'): ServerRequest
    {
        $token = JWT::encode($claims, $key ?: self::$private, 'RS256', $kid);
        return new ServerRequest('POST', 'https://localhost/mcp', ['Authorization' => 'Bearer ' . $token], '{}');
    }

    public function test_verified_identity_scopes_roles_tenant_and_http_guard(): void
    {
        $verifier = $this->verifier();
        $request = $this->request($this->claims());
        $identity = $verifier->identity($request);
        self::assertNotNull($identity);
        self::assertSame(Principal::tenantNamespace('https://identity.example/tenant', 'one'), $identity->tenant);
        self::assertSame(['reader'], $identity->roles);
        self::assertFalse($identity->human);
        self::assertStringStartsWith('oidc:', $identity->id);
        self::assertNull((new HttpGuard($this->settings(), $verifier))->check($request));
        self::assertSame($identity->id, $verifier->authenticate($request));
        self::assertNotSame($identity->id, $verifier->identity($this->request($this->claims(['tid' => 'two'])))->id);
    }

    #[DataProvider('invalidClaims')]
    public function test_invalid_claims_fail_closed(array $changes): void
    {
        self::assertNull($this->verifier()->identity($this->request($this->claims($changes))));
    }

    public static function invalidClaims(): array
    {
        return [[['iss' => 'https://evil.example']], [['aud' => 'wrong-api']], [['sub' => '']], [['exp' => 1]],
            [['exp' => null]], [['iat' => null]], [['iat' => time() + 600]], [['nbf' => time() + 600]],
            [['nbf' => '123']], [['iat' => time() - 9000]], [['scope' => 'unrelated']], [['scope' => ['modelling.read']]],
            [['roles' => 'administrator']], [['tid' => 'unauthorized']], [['tid' => null]], [['azp' => 'other-client']]];
    }

    public function test_forged_signature_and_algorithm_confusion_are_rejected(): void
    {
        $other = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        openssl_pkey_export($other, $private);
        self::assertNull($this->verifier()->identity($this->request($this->claims(), $private)));
        $hmac = JWT::encode($this->claims(), str_repeat('secret', 8), 'HS256', 'test-key');
        self::assertNull($this->verifier()->identity(new ServerRequest('POST', 'https://localhost/mcp', ['Authorization' => 'Bearer ' . $hmac])));
    }

    public function test_unknown_kid_refresh_is_bounded_and_rotation_is_accepted_after_refresh_window(): void
    {
        $cache = new Psr16Cache(new ArrayAdapter());
        $rotated = array_replace(self::$jwk, ['kid' => 'next-key']);
        $mock = new MockHandler([new Response(200, [], json_encode(['keys' => [self::$jwk]])), new Response(200, [], json_encode(['keys' => [$rotated]]))]);
        self::assertNotNull($this->verifier($cache, $mock)->identity($this->request($this->claims())));
        $next = $this->request($this->claims(), kid: 'next-key');
        self::assertNull($this->verifier($cache, $mock)->identity($next));
        self::assertSame(1, $mock->count());
        $cache->delete(hash('sha256', 'https://identity.example/tenant|https://identity.example/tenant/keys') . '-refresh');
        self::assertNotNull($this->verifier($cache, $mock)->identity($next));
        self::assertSame(0, $mock->count());
    }

    public function test_duplicate_signing_keys_and_upstream_failures_fail_closed(): void
    {
        foreach ([new Response(200, [], json_encode(['keys' => [self::$jwk, self::$jwk]])), new Response(503, [], 'sensitive-provider-body'),
            new Response(200, [], '<html>login</html>'), new Response(200, [], json_encode(['keys' => [array_replace(self::$jwk, ['use' => 'enc'])]]))] as $response) {
            self::assertNull($this->verifier(mock: new MockHandler([$response]))->identity($this->request($this->claims())));
        }
    }

    public function test_entra_scopes_and_nested_keycloak_roles_are_supported(): void
    {
        $claims = $this->claims(['scope' => null, 'scp' => 'modelling.read', 'realm_access' => ['roles' => ['modeller']], 'amr' => []]);
        $identity = $this->verifier(settings: $this->settings(['OIDC_ROLES_CLAIM' => 'realm_access.roles']))->identity($this->request($claims));
        self::assertNotNull($identity);
        self::assertSame(['modeller'], $identity->roles);
        self::assertFalse($identity->human);
        (new AccessPolicy($this->settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']), $identity))->assertModelWrite();
    }

    public function test_reader_cannot_write_even_when_deployment_writes_enabled(): void
    {
        $identity = $this->verifier()->identity($this->request($this->claims()));
        $this->expectExceptionMessage('WRITE_PERMISSION_REQUIRED');
        (new AccessPolicy($this->settings(['MODEL_REPOSITORY_WRITE_ENABLED' => 'true']), $identity))->assertModelWrite();
    }

    public function test_different_tenants_cannot_read_each_others_projects(): void
    {
        $root = sys_get_temp_dir() . '/oidc-tenants-' . bin2hex(random_bytes(8));
        $settings = $this->settings(['MODEL_REPOSITORY_PATH' => $root]);
        $one = RepositoryFactory::create($settings, new Principal('one', hash('sha256', 'one')));
        $two = RepositoryFactory::create($settings, new Principal('two', hash('sha256', 'two')));
        $one->createProject('private-project', 'Private', '');
        self::assertSame([], $two->listProjects());
        $this->expectExceptionMessage('PROJECT_NOT_FOUND');
        $two->getProject('private-project');
    }

    public function test_project_scopes_filter_reads_and_enforce_writes_at_repository_boundary(): void
    {
        $root = sys_get_temp_dir() . '/oidc-projects-' . bin2hex(random_bytes(8));
        $settings = $this->settings(['MODEL_REPOSITORY_PATH' => $root, 'PROJECT_RBAC_ENABLED' => 'true']);
        $tenant = hash('sha256', 'tenant');
        $admin = RepositoryFactory::create($settings, new Principal('admin', $tenant, [], ['projects:admin']));
        $admin->createProject('allowed', 'Allowed', '');
        $admin->createProject('denied', 'Denied', '');
        $reader = RepositoryFactory::create($settings, new Principal('reader', $tenant, ['reader'], ['project:allowed:read']));
        self::assertSame(['allowed'], array_column($reader->listProjects(), 'id'));
        self::assertSame('allowed', $reader->getProject('allowed')['id']);
        $this->expectExceptionMessage('PROJECT_PERMISSION_REQUIRED');
        $reader->getProject('denied');
    }

    public function test_verified_oidc_scope_claim_grants_only_the_named_project(): void
    {
        $root = sys_get_temp_dir() . '/oidc-project-claims-' . bin2hex(random_bytes(8));
        $settings = $this->settings(['MODEL_REPOSITORY_PATH' => $root, 'PROJECT_RBAC_ENABLED' => 'true']);
        $identity = $this->verifier(settings: $settings)->identity($this->request($this->claims(['scope' => 'modelling.read project:allowed:read'])));
        self::assertNotNull($identity);
        self::assertContains('project:allowed:read', $identity->scopes);
        $admin = RepositoryFactory::create($settings, new Principal('admin', $identity->tenant, [], ['projects:admin']));
        $admin->createProject('allowed', 'Allowed', '');
        $admin->createProject('denied', 'Denied', '');
        $scoped = RepositoryFactory::create($settings, $identity);
        self::assertSame(['allowed'], array_column($scoped->listProjects(), 'id'));
    }

    public function test_project_read_scope_cannot_write_and_write_scope_grants_project_access(): void
    {
        $root = sys_get_temp_dir() . '/oidc-project-write-' . bin2hex(random_bytes(8));
        $settings = $this->settings(['MODEL_REPOSITORY_PATH' => $root, 'PROJECT_RBAC_ENABLED' => 'true']);
        $tenant = hash('sha256', 'tenant');
        RepositoryFactory::create($settings, new Principal('admin', $tenant, [], ['projects:admin']))->createProject('p', 'P', '');
        $reader = RepositoryFactory::create($settings, new Principal('reader', $tenant, ['reader'], ['project:p:read']));
        try {
            $reader->saveArtifact('p', 'templates/a.oet', '<template/>', [], null);
            self::fail('Read-only project grant wrote an artifact.');
        } catch (\RuntimeException $error) {
            self::assertSame('PROJECT_PERMISSION_REQUIRED', $error->getMessage());
        }
        $writer = RepositoryFactory::create($settings, new Principal('writer', $tenant, ['modeller'], ['project:p:write']));
        self::assertNotSame('', $writer->saveArtifact('p', 'templates/a.oet', '<template/>', [], null)['revision']);
    }

    public function test_project_rbac_requires_verified_oidc_mode(): void
    {
        $this->expectExceptionMessage('PROJECT_RBAC_ENABLED requires AUTH_MODE=oidc.');
        new Settings(['PROJECT_RBAC_ENABLED' => 'true']);
    }

    public function test_discovery_verifies_issuer_and_reuses_cached_keys(): void
    {
        $settings = $this->settings(['OIDC_JWKS_URI' => '']);
        $mock = new MockHandler([
            new Response(200, [], json_encode(['issuer' => $settings->get('OIDC_ISSUER'), 'jwks_uri' => 'https://identity.example/discovered/keys'])),
            new Response(200, [], json_encode(['keys' => [self::$jwk]])),
        ]);
        $requests = [];
        $handler = HandlerStack::create($mock);
        $handler->push(\GuzzleHttp\Middleware::history($requests));
        $verifier = new OidcAuthenticator($settings, new Client(['handler' => $handler]), new Psr16Cache(new ArrayAdapter()));
        self::assertNotNull($verifier->identity($this->request($this->claims())));
        self::assertNotNull($verifier->identity($this->request($this->claims(['sub' => 'another-user']))));
        self::assertCount(2, $requests);
        self::assertSame('https://identity.example/tenant/.well-known/openid-configuration', (string) $requests[0]['request']->getUri());
        self::assertSame('https://identity.example/discovered/keys', (string) $requests[1]['request']->getUri());
        self::assertFalse($requests[0]['options']['allow_redirects']);
    }

    public function test_discovery_rejects_wrong_issuer_cross_origin_and_malformed_metadata(): void
    {
        foreach ([
            ['issuer' => 'https://wrong.example', 'jwks_uri' => 'https://identity.example/keys'],
            ['issuer' => 'https://identity.example/tenant', 'jwks_uri' => 'https://untrusted.example/keys'],
            ['issuer' => 'https://identity.example/tenant', 'jwks_uri' => 'https://identity.example:8443/keys'],
            ['issuer' => 'https://identity.example/tenant', 'jwks_uri' => 'http://identity.example/keys'],
            ['issuer' => 'https://identity.example/tenant'],
        ] as $metadata) {
            $mock = new MockHandler([new Response(200, [], json_encode($metadata))]);
            self::assertNull($this->verifier(mock: $mock, settings: $this->settings(['OIDC_JWKS_URI' => '']))->identity($this->request($this->claims())));
            self::assertSame(0, $mock->count());
        }
    }

    public function test_expiry_is_rechecked_when_reusing_a_verifier(): void
    {
        $verifier = $this->verifier();
        $request = $this->request($this->claims());
        self::assertNotNull($verifier->identity($request));
        try {
            JWT::$timestamp = time() + 1000;
            self::assertNull($verifier->identity($request));
        } finally {
            JWT::$timestamp = null;
        }
    }

    public function test_clock_skew_is_bounded_and_issuer_changes_isolate_namespaces(): void
    {
        self::assertNotNull($this->verifier()->identity($this->request($this->claims(['iat' => time() - 100, 'exp' => time() - 30]))));
        self::assertNull($this->verifier()->identity($this->request($this->claims(['iat' => time() - 100, 'exp' => time() - 90]))));
        self::assertNotNull($this->verifier()->identity($this->request($this->claims(['nbf' => time() + 30]))));
        self::assertNotSame(Principal::tenantNamespace('https://issuer-one.example', 'tenant'), Principal::tenantNamespace('https://issuer-two.example', 'tenant'));
    }

    public function test_invalid_headers_weak_keys_and_oversized_documents_are_rejected(): void
    {
        foreach ([['jku' => 'https://attacker.example/keys'], ['x5u' => 'https://attacker.example/cert'], ['crit' => ['custom']]] as $header) {
            $token = JWT::encode($this->claims(), self::$private, 'RS256', 'test-key', $header);
            self::assertNull($this->verifier()->identity(new ServerRequest('POST', 'https://localhost/mcp', ['Authorization' => 'Bearer ' . $token])));
        }
        foreach ([new Response(302, ['Location' => 'https://attacker.example'], ''), new Response(200, [], str_repeat(' ', 65537)),
            new Response(200, [], json_encode(['keys' => [array_replace(self::$jwk, ['n' => JWT::urlsafeB64Encode(str_repeat('a', 128))])]]))] as $response) {
            self::assertNull($this->verifier(mock: new MockHandler([$response]))->identity($this->request($this->claims())));
        }
    }

    public function test_repository_mapping_requires_distinct_remotes(): void
    {
        $this->expectExceptionMessage('Tenants require distinct Git remotes');
        $this->settings(['OIDC_TENANT_GIT_REMOTES' => json_encode([hash('sha256', 'one') => 'git@example.org:shared/models.git', hash('sha256', 'two') => 'git@example.org:shared/models.git'])]);
    }

    public function test_unmapped_remote_tenant_fails_closed(): void
    {
        $settings = $this->settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => sys_get_temp_dir() . '/oidc-unmapped-' . bin2hex(random_bytes(8)),
            'OIDC_TENANT_GIT_REMOTES' => json_encode([hash('sha256', 'one') => 'git@example.org:one/models.git'])]);
        $this->expectExceptionMessage('TENANT_REPOSITORY_NOT_CONFIGURED');
        RepositoryFactory::create($settings, new Principal('two', hash('sha256', 'two')));
    }

    public function test_tenants_have_independent_remote_git_history_and_conflicts(): void
    {
        $root = sys_get_temp_dir() . '/oidc-git-' . bin2hex(random_bytes(8));
        mkdir($root, 0700);
        foreach (['one', 'two'] as $tenant) {
            $process = new \OpenEHR\Assistant\Integrations\Repository\GitProcess($root, 10);
            self::assertSame(0, $process->run(['init', '--bare', '--initial-branch=main', $root . '/' . $tenant . '.git'])['code']);
        }
        $settings = $this->settings(['MODEL_REPOSITORY_PROVIDER' => 'git', 'MODEL_REPOSITORY_PATH' => $root . '/cache', 'MODEL_GIT_SYNC_SECONDS' => '0',
            'OIDC_TENANT_GIT_REMOTES' => json_encode([hash('sha256', 'one') => $root . '/one.git', hash('sha256', 'two') => $root . '/two.git'])]);
        $one = RepositoryFactory::create($settings, new Principal('one', hash('sha256', 'one')));
        $two = RepositoryFactory::create($settings, new Principal('two', hash('sha256', 'two')));
        $one->createProject('private-project', 'Private', '');
        $saved = $one->saveArtifact('private-project', 'requirements/one.txt', 'Only tenant one', [], null);
        self::assertSame([], $two->listProjects());
        $again = RepositoryFactory::create($settings->with(['MODEL_REPOSITORY_PATH' => $root . '/fresh-cache']), new Principal('one', hash('sha256', 'one')));
        self::assertSame('Only tenant one', $again->getArtifact('private-project', 'requirements/one.txt')['content']);
        self::assertCount(1, $again->history('private-project', 'requirements/one.txt'));
        $again->saveArtifact('private-project', 'requirements/one.txt', 'New revision', [], $saved['revision']);
        $this->expectExceptionMessage('REVISION_CONFLICT');
        $one->saveArtifact('private-project', 'requirements/one.txt', 'Stale revision', [], $saved['revision']);
    }
}
