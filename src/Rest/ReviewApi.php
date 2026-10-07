<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Rest;

use Nyholm\Psr7\Response;
use OpenEHR\Assistant\Application\ModelGovernance;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Auth\InteractiveReviewAuthenticator;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Governance\ReviewPolicy;
use OpenEHR\Assistant\Domain\Governance\ValidationProvider;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** Human review API. It does not accept the MCP authentication mechanism. */
final readonly class ReviewApi
{
    public function __construct(private Settings $settings, private AuditStore $audit, private ValidationProvider $validator)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        if (($rejection = (new HttpGuard($this->settings))->transportCheck($request)) !== null) {
            return $rejection;
        }
        if ($this->settings->get('GOVERNANCE_ENABLED') !== 'true') {
            return $this->error(503, 'GOVERNANCE_NOT_CONFIGURED');
        }
        $actor = (new InteractiveReviewAuthenticator($this->settings, $this->audit))->authenticate($request);
        if ($actor === null) {
            return $this->error(401, 'INTERACTIVE_REVIEW_AUTHENTICATION_REQUIRED');
        }
        if ($actor->roles === []) {
            return $this->error(403, 'GOVERNANCE_ROLE_REQUIRED');
        }
        try {
            $identity = new Principal($actor->id, $actor->tenant, $actor->roles,
                [...$actor->projectScopes, 'governance.write'], true, 'interactive_oidc');
            $service = new ModelGovernance(
                RepositoryFactory::create($this->settings, $identity),
                $this->audit,
                new ReviewPolicy(),
                $this->validator,
                new AccessPolicy($this->settings, $identity),
                $actor
            );
            $path = $request->getUri()->getPath();
            $method = $request->getMethod();
            if ($path === '/api/v1/reviews' && $method === 'GET') {
                parse_str($request->getUri()->getQuery(), $query);
                if (array_diff(array_keys($query), ['project', 'count', 'offset']) !== [] || !is_string($query['project'] ?? null)) {
                    throw new \InvalidArgumentException('INVALID_REVIEW_QUERY');
                }
                foreach (['count' => '25', 'offset' => '0'] as $key => $default) {
                    $query[$key] ??= $default;
                    if (!is_string($query[$key]) || !ctype_digit($query[$key]) || strlen($query[$key]) > 5) {
                        throw new \InvalidArgumentException('INVALID_REVIEW_QUERY');
                    }
                }
                return $this->response(200, $service->list($query['project'], (int) $query['count'], (int) $query['offset']));
            }
            if (!preg_match('~^/api/v1/reviews/([a-f0-9]{64})(/transitions)?$~D', $path, $match) || $request->getUri()->getQuery() !== '') {
                return $this->error(404, 'NOT_FOUND');
            }
            if ($method === 'GET' && !isset($match[2])) {
                return $this->response(200, $service->get($match[1], true));
            }
            if ($method !== 'POST' || ($match[2] ?? '') !== '/transitions') {
                return $this->error(405, 'METHOD_NOT_ALLOWED');
            }
            if (!preg_match('~^application/json(?:\s*;|$)~i', $request->getHeaderLine('Content-Type'))) {
                return $this->error(415, 'JSON_REQUIRED');
            }
            $input = json_decode((string) $request->getBody(), true, 16, JSON_THROW_ON_ERROR);
            if (!is_array($input) || array_diff(array_keys($input), ['state', 'expectedSequence', 'comment', 'validationDigest']) !== []
                || !is_string($input['state'] ?? null) || !is_int($input['expectedSequence'] ?? null) || !is_string($input['comment'] ?? null)
                || (isset($input['validationDigest']) && !is_string($input['validationDigest']))) {
                throw new \InvalidArgumentException('INVALID_REVIEW_TRANSITION');
            }
            return $this->response(200, $service->transition($match[1], $input['expectedSequence'], $input['state'], $input['comment'], $input['validationDigest'] ?? null));
        } catch (\JsonException|\InvalidArgumentException) {
            return $this->error(400, 'INVALID_REVIEW_INPUT');
        } catch (\DomainException $error) {
            $code = preg_match('/^GOVERNANCE_[A-Z_]+$/D', $error->getMessage()) ? $error->getMessage() : 'REVIEW_ACTION_FORBIDDEN';
            return $this->error(403, $code);
        } catch (\RuntimeException $error) {
            $code = $error->getMessage();
            if (in_array($code, ['GOVERNANCE_REVISION_CONFLICT', 'GOVERNANCE_SOURCE_CHANGED', 'MODEL_REVISION_CONFLICT'], true)) {
                return $this->error(409, $code);
            }
            if ($code === 'GOVERNANCE_SUBJECT_NOT_FOUND') {
                return $this->error(404, $code);
            }
            if (in_array($code, ['WRITES_DISABLED', 'HUMAN_GOVERNANCE_PERMISSION_REQUIRED'], true)) {
                return $this->error(403, $code);
            }
            return $this->error(500, 'GOVERNANCE_OPERATION_FAILED');
        }
    }

    /** @param array<string, mixed> $result */
    private function response(int $status, array $result): ResponseInterface
    {
        return new Response(
            $status,
            ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'],
            json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
        );
    }
    private function error(int $status, string $code): ResponseInterface
    {
        return $this->response($status, ['error' => ['code' => $code]]);
    }
}
