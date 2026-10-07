<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Rest;

use Nyholm\Psr7\Response;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** Versioned model application API; the HTTP mount must authenticate before dispatch. */
final readonly class ModelApi
{
    public function __construct(private Settings $settings, private ModelRepository $repository, private AccessPolicy $access)
    {
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        if (($rejection = (new HttpGuard($this->settings))->transportCheck($request)) !== null) {
            return $rejection;
        }
        $path = $request->getUri()->getPath();
        $method = $request->getMethod();
        try {
            if ($path === '/api/v1/projects' && $method === 'GET') {
                if ($request->getUri()->getQuery() !== '') {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_QUERY');
                }
                return $this->response(200, ['projects' => $this->repository->listProjects(), 'capabilities' => $this->repository->capabilities()]);
            }
            if ($path === '/api/v1/projects' && $method === 'POST') {
                if ($request->getUri()->getQuery() !== '') {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_QUERY');
                }
                $input = $this->input($request);
                if (array_diff(array_keys($input), ['id', 'name', 'description']) !== [] || !is_string($input['id'] ?? null)
                    || !is_string($input['name'] ?? null) || (isset($input['description']) && !is_string($input['description']))) {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_INPUT');
                }
                $this->access->assertModelWrite();
                return $this->response(201, ['project' => $this->repository->createProject($input['id'], $input['name'], $input['description'] ?? '')]);
            }
            if (preg_match('~^/api/v1/projects/([A-Za-z0-9._-]{1,100})$~D', $path, $match) && $method === 'GET'
                && $request->getUri()->getQuery() === '') {
                return $this->response(200, ['project' => $this->repository->getProject($match[1]), 'artifacts' => $this->repository->listArtifacts($match[1])]);
            }
            if (preg_match('~^/api/v1/projects/([A-Za-z0-9._-]{1,100})/archive$~D', $path, $match) && $method === 'POST'
                && $request->getUri()->getQuery() === '') {
                $input = $this->input($request);
                if (array_diff(array_keys($input), ['expectedRevision']) !== [] || !is_string($input['expectedRevision'] ?? null)
                    || $input['expectedRevision'] === '') {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_INPUT');
                }
                $this->access->assertModelWrite();
                return $this->response(200, ['project' => $this->repository->archiveProject($match[1], $input['expectedRevision'])]);
            }
            if (($path === '/api/v1/artifacts' || $path === '/api/v1/artifact-history') && in_array($method, ['GET', 'PUT'], true)) {
                $query = $this->query($request, $path === '/api/v1/artifact-history' ? ['project', 'path'] : ['project', 'path', 'revision']);
                if (!is_string($query['project'] ?? null) || !is_string($query['path'] ?? null) || $query['project'] === '' || $query['path'] === '') {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_QUERY');
                }
                if ($path === '/api/v1/artifact-history') {
                    return $method === 'GET' ? $this->response(200, ['versions' => $this->repository->history($query['project'], $query['path'])])
                        : $this->error(405, 'METHOD_NOT_ALLOWED');
                }
                if ($method === 'GET') {
                    return $this->response(200, $this->repository->getArtifact($query['project'], $query['path'], $query['revision'] ?? null));
                }
                $input = $this->input($request);
                if (array_diff(array_keys($input), ['content', 'metadata', 'expectedRevision']) !== [] || !is_string($input['content'] ?? null)
                    || (isset($input['metadata']) && (!is_array($input['metadata']) || ($input['metadata'] !== [] && array_is_list($input['metadata']))))
                    || (isset($input['expectedRevision']) && !is_string($input['expectedRevision']))) {
                    throw new \InvalidArgumentException('INVALID_MODEL_API_INPUT');
                }
                $this->access->assertModelWrite();
                return $this->response(200, $this->repository->saveArtifact($query['project'], $query['path'], $input['content'],
                    $input['metadata'] ?? [], $input['expectedRevision'] ?? null));
            }
            return $this->error(404, 'NOT_FOUND');
        } catch (\JsonException|\InvalidArgumentException $error) {
            return $this->error($error->getMessage() === 'JSON_REQUIRED' ? 415 : 400,
                $error->getMessage() === 'INVALID_MODEL_API_QUERY' ? 'INVALID_MODEL_API_QUERY' : ($error->getMessage() === 'JSON_REQUIRED' ? 'JSON_REQUIRED' : 'INVALID_MODEL_API_INPUT'));
        } catch (\RuntimeException $error) {
            return match ($error->getMessage()) {
                'PROJECT_NOT_FOUND', 'ARTIFACT_NOT_FOUND' => $this->error(404, $error->getMessage()),
                'MODEL_REVISION_CONFLICT', 'REVISION_CONFLICT', 'GOVERNANCE_REVISION_CONFLICT', 'PROJECT_ARCHIVED' => $this->error(409, $error->getMessage()),
                'WRITES_DISABLED', 'WRITE_PERMISSION_REQUIRED', 'PROJECT_PERMISSION_REQUIRED' => $this->error(403, $error->getMessage()),
                default => $this->error(500, 'MODEL_OPERATION_FAILED'),
            };
        }
    }

    /** @return array<string, mixed> */
    private function input(ServerRequestInterface $request): array
    {
        if (!preg_match('/^application\/json(?:\s*;|$)/i', $request->getHeaderLine('Content-Type'))) {
            throw new \InvalidArgumentException('JSON_REQUIRED');
        }
        $input = json_decode((string) $request->getBody(), true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($input) || array_is_list($input)) {
            throw new \InvalidArgumentException('INVALID_MODEL_API_INPUT');
        }
        return $input;
    }

    /** @param list<string> $allowed
     * @return array<string, string> */
    private function query(ServerRequestInterface $request, array $allowed): array
    {
        parse_str($request->getUri()->getQuery(), $query);
        $result = [];
        foreach ($query as $key => $value) {
            if (!is_string($key) || !in_array($key, $allowed, true) || !is_string($value)) {
                throw new \InvalidArgumentException('INVALID_MODEL_API_QUERY');
            }
            $result[$key] = $value;
        }
        return $result;
    }

    /** @param array<string, mixed> $result */
    private function response(int $status, array $result): ResponseInterface
    {
        return new Response($status, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'],
            json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private function error(int $status, string $code): ResponseInterface
    {
        return $this->response($status, ['error' => ['code' => $code]]);
    }
}