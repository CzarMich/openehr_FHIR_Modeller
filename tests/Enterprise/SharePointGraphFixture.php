<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use GuzzleHttp\Client;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;

/** Stateful Graph contract fixture: conditional writes are enforced independently of adapter code. */
final class SharePointGraphFixture
{
    public array $requests = [];
    public array $heads = [];
    public array $files = [];
    public bool $unique = true;
    public ?\Closure $beforeCas = null;
    public bool $failCommit = false;
    public bool $failUpload = false;
    public bool $createRace = false;

    public function client(): Client
    {
        return new Client(['handler' => function (RequestInterface $request, array $options) {
            $this->requests[] = ['request' => $request, 'options' => $options];
            return Create::promiseFor($this->respond($request));
        }]);
    }

    private function respond(RequestInterface $request): Response
    {
        $method = $request->getMethod(); $path = rawurldecode($request->getUri()->getPath());
        parse_str($request->getUri()->getQuery(), $query);
        if ($request->getHeaderLine('Authorization') !== 'Bearer fixture-token') { return new Response(401); }
        if ($path === '/v1.0/sites/site/lists/list/columns' && $method === 'GET') {
            return $this->json(['value' => [
                ['name' => 'ModelProjectId', 'text' => new \stdClass(), 'indexed' => true, 'enforceUniqueValues' => $this->unique],
                ['name' => 'SnapshotItemId', 'text' => new \stdClass()], ['name' => 'SnapshotHash', 'text' => new \stdClass()],
            ]]);
        }
        if ($path === '/v1.0/sites/site/lists/list/items') {
            if ($method === 'GET') {
                $rows = array_values($this->heads);
                if (isset($query['$filter'])) {
                    if (!preg_match("/^fields\/ModelProjectId eq '([A-Za-z0-9_-]+)'$/D", $query['$filter'], $match)) { return new Response(400); }
                    $rows = array_values(array_filter($rows, fn ($row) => $row['fields']['ModelProjectId'] === $match[1]));
                }
                return $this->json(['value' => $rows]);
            }
            if ($method === 'POST') {
                $fields = json_decode((string) $request->getBody(), true)['fields'];
                foreach ($this->heads as $row) { if ($row['fields']['ModelProjectId'] === $fields['ModelProjectId']) { return new Response(400); } }
                $id = (string) (count($this->heads) + 1);
                $this->heads[$id] = ['id' => $id, 'eTag' => '"1"', 'fields' => $fields];
                return $this->createRace ? new Response(400) : $this->json($this->heads[$id], 201);
            }
        }
        if (preg_match('~^/v1.0/sites/site/lists/list/items/([0-9]+)/fields$~D', $path, $match) && $method === 'PATCH') {
            if ($this->beforeCas !== null) { $hook = $this->beforeCas; $this->beforeCas = null; $hook(); }
            if ($this->failCommit) { return new Response(503); }
            $id = $match[1];
            if ($request->getHeaderLine('If-Match') !== $this->heads[$id]['eTag']) { return new Response(412); }
            $this->heads[$id]['fields'] = array_replace($this->heads[$id]['fields'], json_decode((string) $request->getBody(), true));
            $this->heads[$id]['eTag'] = '"' . ((int) trim($this->heads[$id]['eTag'], '"') + 1) . '"';
            return $this->json($this->heads[$id]['fields']);
        }
        if (preg_match('~^/v1.0/drives/drive/items/folder:/snapshot-([a-f0-9]{48})\.json:/content$~D', $path, $match) && $method === 'PUT') {
            if ($this->failUpload) { return new Response(503); }
            $id = $match[1];
            if (isset($this->files[$id])) { throw new \LogicException('Attempt to replace an immutable snapshot.'); }
            $this->files[$id] = (string) $request->getBody();
            return $this->json(['id' => $id], 201);
        }
        if (preg_match('~^/v1.0/drives/drive/items/([a-f0-9]{48})(/content)?$~D', $path, $match) && $method === 'GET') {
            $content = $this->files[$match[1]] ?? null;
            if ($content === null) { return new Response(404); }
            return isset($match[2]) ? new Response(200, [], $content) : $this->json(['id' => $match[1],
                'size' => strlen($content), 'file' => new \stdClass(), 'parentReference' => ['id' => 'folder']]);
        }
        throw new \LogicException('Unexpected Graph fixture operation: ' . $method . ' ' . $path);
    }

    private function json(array $value, int $status = 200): Response
    { return new Response($status, ['Content-Type' => 'application/json'], json_encode($value, JSON_THROW_ON_ERROR)); }
}
