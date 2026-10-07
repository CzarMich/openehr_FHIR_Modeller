<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Rest;

use Nyholm\Psr7\Response;
use OpenEHR\Assistant\Application\AqlWorkbench;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Auth\InteractiveReviewAuthenticator;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Integrations\Cdr\CdrErrors;
use OpenEHR\Assistant\Integrations\Cdr\CdrFactory;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/** Private browser API, with purpose-specific, body-bound identity assertions and replay protection. */
final readonly class CdrApi
{
    public function __construct(private Settings $settings, private AuditStore $audit, private NativeModels $models) {}

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        if (($rejection = (new HttpGuard($this->settings))->transportCheck($request, 16777216)) !== null) { return $rejection; }
        if ($this->settings->get('CDR_ENABLED') !== 'true') { return $this->response(503, ['error' => ['code' => 'CDR_NOT_CONFIGURED']]); }
        $actor = (new InteractiveReviewAuthenticator($this->settings, $this->audit))->authenticate($request, 'cdr');
        if ($actor === null) { return $this->response(401, ['error' => ['code' => 'CDR_SIGN_IN_REQUIRED']]); }
        if ($request->getMethod() !== 'POST' || $request->getUri()->getQuery() !== '') { return $this->response(405, ['error' => ['code' => 'CDR_METHOD_NOT_ALLOWED']]); }
        if (!preg_match('~^application/json(?:\s*;|$)~i', $request->getHeaderLine('Content-Type'))) { return $this->response(415, ['error' => ['code' => 'CDR_JSON_REQUIRED']]); }
        try {
            $input = json_decode((string) $request->getBody(), true, 64, JSON_THROW_ON_ERROR);
            if (!is_array($input)) { throw new \InvalidArgumentException('CDR_INVALID_REQUEST'); }
            $operation = substr($request->getUri()->getPath(), strlen('/api/v1/cdr/'));
            $fields = match ($operation) {
                'connections' => [], 'history', 'history-clear', 'saved' => ['connection_id'],
                'connection-save' => ['connection'], 'connection-delete', 'connection-test', 'capabilities' => ['id'],
                'saved-get', 'saved-delete' => ['id', 'connection_id'],
                'templates' => ['id', 'identifier'], 'execute', 'execute-metadata' => ['id', 'query', 'parameters', 'fetch', 'offset', 'job'], 'cancel' => ['job'],
                'saved-save' => ['name', 'query', 'id', 'connection_id'], 'validate', 'explain' => ['query', 'templates'],
                'generate' => ['content', 'format', 'paths', 'dependencies'], 'inspect' => ['content', 'format', 'dependencies'], 'compile' => ['content', 'dependencies'],
                default => throw new \InvalidArgumentException('CDR_UNKNOWN_OPERATION'),
            };
            if (array_diff(array_keys($input), $fields) !== []) { throw new \InvalidArgumentException('CDR_INVALID_REQUEST'); }
            $cdr = CdrFactory::workspace($this->settings, $actor, $this->models);
            $workbench = new AqlWorkbench($this->models);
            $result = match ($operation) {
                'connections' => $cdr->connections(), 'connection-save' => $cdr->saveConnection($input['connection'] ?? []),
                'connection-delete' => $cdr->deleteConnection($input['id'] ?? ''), 'connection-test' => $cdr->test($input['id'] ?? ''),
                'capabilities' => $cdr->capabilities($input['id'] ?? ''), 'templates' => $cdr->templates($input['id'] ?? '', $input['identifier'] ?? null),
                'execute', 'execute-metadata' => $cdr->execute($input['id'] ?? '', $input['query'] ?? '', $input['parameters'] ?? [], $input['fetch'] ?? 100, $input['offset'] ?? 0, $input['job'] ?? null, $operation === 'execute'),
                'cancel' => $cdr->cancel($input['job'] ?? ''), 'history' => $cdr->history($input['connection_id'] ?? null), 'history-clear' => $cdr->clearHistory($input['connection_id'] ?? null),
                'saved' => $cdr->saved(null, $input['connection_id'] ?? null), 'saved-get' => $cdr->saved($input['id'] ?? '', $input['connection_id'] ?? null),
                'saved-save' => $cdr->saveQuery($input['name'] ?? '', $input['query'] ?? '', $input['id'] ?? null, $input['connection_id'] ?? null),
                'saved-delete' => $cdr->deleteQuery($input['id'] ?? '', $input['connection_id'] ?? null),
                'validate' => $this->models->validate($input['query'] ?? '', 'aql', $input['templates'] ?? []),
                'explain' => $workbench->explain($input['query'] ?? '', $input['templates'] ?? []),
                'generate' => $workbench->generate($input['content'] ?? '', $input['format'] ?? '', $input['paths'] ?? [], $input['dependencies'] ?? []),
                'inspect' => $this->models->inspect($input['content'] ?? '', $input['format'] ?? '', $input['dependencies'] ?? []),
                'compile' => $this->models->compile($input['content'] ?? '', $input['dependencies'] ?? []),
            };
            return $this->response(200, $result);
        } catch (\Throwable $error) {
            $code = CdrErrors::safe($error->getMessage());
            $status = $error instanceof \InvalidArgumentException || $error instanceof \TypeError || $error instanceof \JsonException ? 400
                : ($error instanceof \DomainException ? 403 : (str_ends_with($code, '_NOT_FOUND') ? 404 : 502));
            return $this->response($status, ['error' => ['code' => $code]]);
        }
    }

    /**
     * @param array<string, mixed> $value */
    private function response(int $status, array $value): ResponseInterface
    {
        return new Response($status, ['Content-Type' => 'application/json', 'Cache-Control' => 'no-store', 'X-Content-Type-Options' => 'nosniff'], json_encode($value, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE));
    }
}
