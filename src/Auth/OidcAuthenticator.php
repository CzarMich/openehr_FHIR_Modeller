<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Auth;

use Firebase\JWT\JWK;
use Firebase\JWT\JWT;
use GuzzleHttp\ClientInterface;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use OpenEHR\Assistant\Configuration\Settings;
use Psr\Http\Message\ServerRequestInterface;
use Psr\SimpleCache\CacheInterface;
use Symfony\Component\Cache\Adapter\FilesystemAdapter;
use Symfony\Component\Cache\Psr16Cache;

/** Validates access tokens against an administrator-pinned issuer, audience and JWKS. */
final class OidcAuthenticator implements Authenticator
{
    private ClientInterface $client;
    private CacheInterface $cache;
    private string $cacheKey;

    public function __construct(private readonly Settings $settings, ?ClientInterface $client = null, ?CacheInterface $cache = null)
    {
        foreach (['OIDC_ISSUER', 'OIDC_AUDIENCE'] as $key) {
            if ($settings->get($key) === '') { throw new \InvalidArgumentException('OIDC_CONFIGURATION_REQUIRED'); }
        }
        $this->client = $client ?? HttpClientFactory::create($settings->get('OIDC_ISSUER'), (int) $settings->get('HTTP_TIMEOUT'), $settings);
        $this->cache = $cache ?? new Psr16Cache(new FilesystemAdapter('oidc-jwks', 300, APP_DATA_DIR . '/cache'));
        $this->cacheKey = hash('sha256', $settings->get('OIDC_ISSUER') . '|' . $settings->get('OIDC_JWKS_URI'));
    }

    public function authenticate(ServerRequestInterface $request): ?string
    {
        return $this->identity($request)?->id;
    }

    public function identity(ServerRequestInterface $request): ?Principal
    {
        $authorization = $request->getHeaderLine('Authorization');
        if (strlen($authorization) > 16384 || !preg_match('/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/Di', $authorization, $match)) { return null; }
        $token = $match[1];
        try {
            $header = json_decode(JWT::urlsafeB64Decode(explode('.', $token)[0]), true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($header) || ($header['alg'] ?? null) !== 'RS256' || !is_string($header['kid'] ?? null)
                || $header['kid'] === '' || strlen($header['kid']) > 200 || isset($header['crit']) || isset($header['jku']) || isset($header['x5u'])) { return null; }
            $keys = $this->keys($header['kid']);
            $oldLeeway = JWT::$leeway;
            try {
                JWT::$leeway = (int) $this->settings->get('OIDC_CLOCK_SKEW');
                $claims = (array) JWT::decode($token, JWK::parseKeySet(['keys' => $keys], 'RS256'));
            } finally { JWT::$leeway = $oldLeeway; }
            $now = time(); $skew = (int) $this->settings->get('OIDC_CLOCK_SKEW');
            if (($claims['iss'] ?? null) !== $this->settings->get('OIDC_ISSUER')
                || !is_string($claims['sub'] ?? null) || $claims['sub'] === '' || strlen($claims['sub']) > 300
                || !is_int($claims['exp'] ?? null) || !is_int($claims['iat'] ?? null)
                || $claims['exp'] <= $claims['iat'] || $claims['iat'] > $now + $skew
                || $claims['iat'] < $now - (int) $this->settings->get('OIDC_MAX_TOKEN_AGE') - $skew
                || (isset($claims['nbf']) && !is_int($claims['nbf']))) { return null; }
            $audience = $claims['aud'] ?? null;
            if (!is_array($audience)) { $audience = [$audience]; }
            if (!in_array($this->settings->get('OIDC_AUDIENCE'), $audience, true)) { return null; }
            $clients = $this->settings->csv('OIDC_ALLOWED_CLIENT_IDS');
            if ($clients !== [] && !in_array($claims['azp'] ?? $claims['appid'] ?? null, $clients, true)) { return null; }
            $scope = $claims['scope'] ?? $claims['scp'] ?? '';
            if (!is_string($scope)) { return null; }
            $scopes = array_values(array_filter(explode(' ', $scope)));
            if (array_diff($this->settings->csv('OIDC_REQUIRED_SCOPES'), $scopes) !== []) { return null; }
            $roles = $this->claim($claims, $this->settings->get('OIDC_ROLES_CLAIM')) ?? [];
            if (!is_array($roles) || !array_is_list($roles) || count($roles) > 100) { return null; }
            foreach ($roles as $role) { if (!is_string($role) || strlen($role) > 100) { return null; } }
            if (array_diff($this->settings->csv('OIDC_REQUIRED_ROLES'), $roles) !== []) { return null; }
            $tenantClaim = $this->settings->get('OIDC_TENANT_CLAIM');
            $tenant = $tenantClaim === '' ? $claims['iss'] : $this->claim($claims, $tenantClaim);
            if (!is_string($tenant) || $tenant === '' || strlen($tenant) > 300) { return null; }
            $allowedTenants = $this->settings->csv('OIDC_ALLOWED_TENANTS');
            if ($allowedTenants !== [] && !in_array($tenant, $allowedTenants, true)) { return null; }
            $identity = hash('sha256', json_encode([$claims['iss'], $tenant, $claims['sub']], JSON_THROW_ON_ERROR));
            // A bearer token can be delegated to an agent even when its original
            // authentication used MFA. Human approval requires a separate interactive act.
            return new Principal('oidc:' . $identity, Principal::tenantNamespace($claims['iss'], $tenant), $roles, $scopes);
        } catch (\Throwable) {
            // Tokens, claims, provider bodies and signing material never reach error responses/logs.
            return null;
        }
    }

    /** @return list<array<string, mixed>> */
    private function keys(string $kid): array
    {
        $cached = $this->cache->get($this->cacheKey);
        $keys = is_array($cached) && is_array($cached['keys'] ?? null) ? $cached['keys'] : [];
        $matching = array_values(array_filter($keys, static fn (mixed $key): bool => is_array($key) && ($key['kid'] ?? null) === $kid));
        if ($matching === []) {
            $lastRefresh = $this->cache->get($this->cacheKey . '-refresh');
            if (is_int($lastRefresh) && time() - $lastRefresh < 30) { throw new \RuntimeException('OIDC_REFRESH_RATE_LIMITED'); }
            $this->cache->set($this->cacheKey . '-refresh', time(), 30);
            $document = $this->document($this->jwksUri());
            if (!is_array($document['keys'] ?? null) || !array_is_list($document['keys']) || count($document['keys']) > 100) { throw new \RuntimeException('OIDC_JWKS_INVALID'); }
            $this->cache->set($this->cacheKey, $document, 300);
            $matching = array_values(array_filter($document['keys'], static fn (mixed $key): bool => is_array($key) && ($key['kid'] ?? null) === $kid));
        }
        if (count($matching) !== 1) { throw new \RuntimeException('OIDC_KEY_NOT_UNIQUE'); }
        $key = $matching[0];
        if (($key['kty'] ?? null) !== 'RSA' || ($key['alg'] ?? 'RS256') !== 'RS256' || ($key['use'] ?? 'sig') !== 'sig'
            || (isset($key['key_ops']) && (!is_array($key['key_ops']) || !in_array('verify', $key['key_ops'], true)))
            || !is_string($key['n'] ?? null) || strlen(JWT::urlsafeB64Decode($key['n'])) < 256
            || strlen(JWT::urlsafeB64Decode($key['n'])) > 1024) { throw new \RuntimeException('OIDC_KEY_REJECTED'); }
        return [$key];
    }

    private function jwksUri(): string
    {
        $pinned = $this->settings->get('OIDC_JWKS_URI');
        if ($pinned !== '') { return $pinned; }
        $key = $this->cacheKey . '-discovery';
        $uri = $this->cache->get($key);
        if (is_string($uri)) { return $uri; }
        $issuer = $this->settings->get('OIDC_ISSUER');
        $metadata = $this->document(rtrim($issuer, '/') . '/.well-known/openid-configuration');
        if (($metadata['issuer'] ?? null) !== $issuer || !is_string($metadata['jwks_uri'] ?? null)) {
            throw new \RuntimeException('OIDC_DISCOVERY_INVALID');
        }
        $uri = $metadata['jwks_uri'];
        Settings::validateUrl($uri);
        // Discovery cannot redirect trust to another host. Administrators can pin
        // a separately trusted key endpoint explicitly through OIDC_JWKS_URI.
        if (strtolower((string) parse_url($uri, PHP_URL_HOST)) !== strtolower((string) parse_url($issuer, PHP_URL_HOST))
            || (parse_url($uri, PHP_URL_PORT) ?: 443) !== (parse_url($issuer, PHP_URL_PORT) ?: 443)) {
            throw new \RuntimeException('OIDC_DISCOVERY_ORIGIN_REJECTED');
        }
        $this->cache->set($key, $uri, 300);
        return $uri;
    }

    /** @return array<string, mixed> */
    private function document(string $uri): array
    {
        $response = $this->client->request('GET', $uri, [
            'headers' => ['Accept' => 'application/json'], 'allow_redirects' => false,
            'http_errors' => false, 'stream' => true,
        ]);
        $stream = $response->getBody();
        try {
            $body = '';
            while (strlen($body) <= 65536) {
                $chunk = $stream->read(min(8192, 65537 - strlen($body)));
                if ($chunk === '') {
                    if ($stream->eof()) { break; }
                    throw new \RuntimeException('OIDC_RESPONSE_INCOMPLETE');
                }
                $body .= $chunk;
                if ($stream->eof()) { break; }
            }
            if ($response->getStatusCode() !== 200 || strlen($body) > 65536) {
                throw new \RuntimeException('OIDC_DOCUMENT_UNAVAILABLE');
            }
            $document = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($document) || array_is_list($document)) { throw new \RuntimeException('OIDC_DOCUMENT_INVALID'); }
            return $document;
        } finally {
            $stream->close();
        }
    }

    /** @param array<string, mixed> $claims */
    private function claim(array $claims, string $path): mixed
    {
        $value = $claims;
        foreach (explode('.', $path) as $segment) {
            if ($value instanceof \stdClass) { $value = (array) $value; }
            if (!is_array($value) || !array_key_exists($segment, $value)) { return null; }
            $value = $value[$segment];
        }
        return $value;
    }
}
