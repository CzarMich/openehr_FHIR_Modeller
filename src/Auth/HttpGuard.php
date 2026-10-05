<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Auth;

use OpenEHR\Assistant\Configuration\Settings;
use Nyholm\Psr7\Response;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** Transport-only policy; never accepts identity supplied through tool arguments. */
final readonly class HttpGuard
{
    public function __construct(private Settings $settings, private ?Authenticator $oidc = null)
    {
    }

    public function principal(ServerRequestInterface $request): ?string
    {
        return match ($this->settings->get('AUTH_MODE')) {
            'none' => $this->settings->get('APP_ENV') !== 'production' ? 'local-development' : null,
            'api_key' => (new ApiKeyAuthenticator($this->settings->get('AUTH_API_KEY'), $this->settings->get('AUTH_API_KEY_HEADER')))->authenticate($request),
            'oidc' => $this->oidc?->authenticate($request),
            default => null,
        };
    }

    public function check(ServerRequestInterface $request): ?ResponseInterface
    {
        if (($rejection = $this->checkHostOrigin($request)) !== null) { return $rejection; }
        $origin = $request->getHeaderLine('Origin');
        if ($request->getMethod() === 'OPTIONS') {
            return new Response(204, [
                'Access-Control-Allow-Origin' => $origin,
                'Access-Control-Allow-Methods' => 'POST, GET, PUT, DELETE',
                'Access-Control-Allow-Headers' => 'Content-Type, Accept, Authorization, ' . $this->settings->get('AUTH_API_KEY_HEADER') . ', Mcp-Session-Id, MCP-Protocol-Version',
                'Vary' => 'Origin',
            ]);
        }
        if ($this->principal($request) === null) {
            return $this->error(401, 'AUTHENTICATION_REQUIRED')->withHeader('WWW-Authenticate', 'Bearer');
        }
        return $this->checkBody($request);
    }

    /** Shared boundary for purpose-specific REST authentication. */
    public function transportCheck(ServerRequestInterface $request, ?int $bodyLimit = null): ?ResponseInterface
    {
        return $this->checkHostOrigin($request) ?? $this->checkBody($request, $bodyLimit);
    }

    private function checkHostOrigin(ServerRequestInterface $request): ?ResponseInterface
    {
        $host = strtolower($request->getHeaderLine('Host'));
        $hostname = str_starts_with($host, '[') ? substr($host, 0, (int) strpos($host, ']') + 1) : explode(':', $host)[0];
        if ($host === '' || str_contains($host, ',') || !in_array($hostname, array_map('strtolower', $this->settings->csv('MCP_ALLOWED_HOSTS')), true)) {
            return $this->error(403, 'HOST_FORBIDDEN');
        }
        $origin = $request->getHeaderLine('Origin');
        if ($origin !== '' && !in_array($origin, $this->settings->csv('CORS_ALLOWED_ORIGINS'), true)) {
            return $this->error(403, 'ORIGIN_FORBIDDEN');
        }
        return null;
    }

    private function checkBody(ServerRequestInterface $request, ?int $bodyLimit = null): ?ResponseInterface
    {
        // php://input often has no reported size. Read a bounded prefix and rewind
        // so SDK decoding sees the same payload; never trust Content-Length alone.
        $body = $request->getBody();
        $size = $body->getSize();
        $limit = $bodyLimit ?? (int) $this->settings->get('MAX_REQUEST_BYTES');
        if ($size === null && $body->isSeekable()) {
            $body->rewind();
            $size = strlen($body->read($limit + 1));
            $body->rewind();
        }
        if ($size === null || $size > $limit) {
            return $this->error(413, 'REQUEST_TOO_LARGE');
        }
        return null;
    }

    private function error(int $status, string $code): ResponseInterface
    {
        return new Response($status, ['Content-Type' => 'application/json'], json_encode(['error' => ['code' => $code]], JSON_THROW_ON_ERROR));
    }
}
