<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\SharePoint;

use GuzzleHttp\ClientInterface;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Auth\AccessTokenProvider;
use Psr\Http\Message\ResponseInterface;

/** Restricted Microsoft Graph boundary. Download redirects use a separate credential-free request. */
final readonly class GraphClient
{
    private ClientInterface $client;
    private ClientInterface $downloads;
    private string $base;
    private int $limit;
    /** @var list<string> */
    private array $downloadHosts;

    public function __construct(Settings $settings, private AccessTokenProvider $tokens, ?ClientInterface $client = null, ?ClientInterface $downloads = null)
    {
        $this->base = rtrim($settings->get('SHAREPOINT_GRAPH_URL'), '/') . '/';
        Settings::validateUrl($this->base);
        $this->client = $client ?? HttpClientFactory::create($this->base, (int) $settings->get('HTTP_TIMEOUT'), $settings);
        $this->downloads = $downloads ?? HttpClientFactory::create($this->base, (int) $settings->get('HTTP_TIMEOUT'), $settings);
        $this->limit = (int) $settings->get('MAX_UPSTREAM_BYTES');
        $this->downloadHosts = $settings->csv('SHAREPOINT_DOWNLOAD_HOSTS');
        foreach ($this->downloadHosts as $host) {
            if (!preg_match('/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/D', $host)) { throw new \InvalidArgumentException('INVALID_SHAREPOINT_DOWNLOAD_HOST'); }
        }
    }

    /** @param array<string, mixed> $query
     * @param array<string, mixed>|string|null $body
     * @param array<string, string> $headers
     * @return array<string, mixed> */
    public function json(string $method, string $path, array $query = [], array|string|null $body = null, array $headers = []): array
    {
        $response = $this->request($method, $path, $query, $body, $headers);
        $this->success($response);
        try { $data = json_decode($this->body($response), true, 64, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \RuntimeException('SHAREPOINT_INVALID_RESPONSE'); }
        if (!is_array($data) || ($data !== [] && array_is_list($data))) { throw new \RuntimeException('SHAREPOINT_INVALID_RESPONSE'); }
        return $data;
    }

    /** Bound pagination to the exact collection path on the configured Graph origin.
     * @param array<string, mixed> $query
     * @return list<array<string, mixed>> */
    public function collection(string $path, array $query = []): array
    {
        $items = []; $seen = [];
        for ($page = 0; $page < 100; $page++) {
            $data = $this->json('GET', $path, $query);
            if (!is_array($data['value'] ?? null) || !array_is_list($data['value'])) { throw new \RuntimeException('SHAREPOINT_INVALID_RESPONSE'); }
            foreach ($data['value'] as $item) {
                if (!is_array($item) || count($items) >= 10000) { throw new \RuntimeException('SHAREPOINT_COLLECTION_LIMIT'); }
                $items[] = $item;
            }
            if (!isset($data['@odata.nextLink'])) { return $items; }
            $next = $data['@odata.nextLink'];
            if (!is_string($next) || isset($seen[$next]) || strlen($next) > 16384) { throw new \RuntimeException('SHAREPOINT_INVALID_PAGINATION'); }
            $seen[$next] = true;
            $expected = parse_url($this->base . $path); $url = parse_url($next);
            if (!is_array($url) || !is_array($expected) || isset($url['user']) || isset($url['pass']) || isset($url['fragment'])
                || ($url['scheme'] ?? '') !== 'https' || ($url['host'] ?? '') !== ($expected['host'] ?? '')
                || ($url['port'] ?? 443) !== ($expected['port'] ?? 443)
                || ($url['path'] ?? '') !== ($expected['path'] ?? '') || preg_match('/[\x00-\x20\x7f]/', $next)) {
                throw new \RuntimeException('SHAREPOINT_INVALID_PAGINATION');
            }
            parse_str($url['query'] ?? '', $parameters);
            $query = [];
            foreach ($parameters as $key => $value) {
                if (!is_string($key)) { throw new \RuntimeException('SHAREPOINT_INVALID_PAGINATION'); }
                $query[$key] = $value;
            }
        }
        throw new \RuntimeException('SHAREPOINT_COLLECTION_LIMIT');
    }

    public function content(string $path): string
    {
        $response = $this->request('GET', $path);
        if ($response->getStatusCode() === 302) {
            $location = $response->getHeaderLine('Location'); $url = parse_url($location);
            if (!is_array($url) || ($url['scheme'] ?? '') !== 'https' || !in_array($url['host'] ?? '', $this->downloadHosts, true)
                || ($url['port'] ?? 443) !== 443 || isset($url['user']) || isset($url['pass']) || isset($url['fragment'])
                || preg_match('/[\x00-\x20\x7f]/', $location)) { throw new \RuntimeException('SHAREPOINT_DOWNLOAD_HOST_REJECTED'); }
            try {
                $response = $this->downloads->request('GET', $location, ['http_errors' => false, 'allow_redirects' => false,
                    'headers' => ['Accept' => 'application/octet-stream'], 'cookies' => false]);
            } catch (\Throwable) { throw new \RuntimeException('SHAREPOINT_UNAVAILABLE'); }
        }
        $this->success($response);
        return $this->body($response);
    }

    /** @param array<string, mixed> $query
     * @param array<string, mixed>|string|null $body
     * @param array<string, string> $headers */
    private function request(string $method, string $path, array $query = [], array|string|null $body = null, array $headers = []): ResponseInterface
    {
        if (!preg_match('~^[A-Za-z][A-Za-z0-9_!.,:%/-]*$~D', $path) || str_contains(rawurldecode($path), '..')
            || str_contains($path, '//')) { throw new \InvalidArgumentException('INVALID_GRAPH_PATH'); }
        foreach ($headers as $value) {
            if (preg_match('/[\x00-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('INVALID_GRAPH_HEADER'); }
        }
        $options = ['allow_redirects' => false, 'http_errors' => false, 'query' => $query,
            'headers' => $headers + ['Authorization' => 'Bearer ' . $this->tokens->token(), 'Accept' => 'application/json']];
        if (is_array($body)) { $options['json'] = $body; }
        elseif (is_string($body)) { $options['body'] = $body; $options['headers']['Content-Type'] = 'application/json'; }
        try { return $this->client->request($method, $this->base . $path, $options); }
        catch (\Throwable) { throw new \RuntimeException('SHAREPOINT_UNAVAILABLE'); }
    }

    private function body(ResponseInterface $response): string
    {
        $body = $response->getBody()->read($this->limit + 1);
        if (strlen($body) > $this->limit) { throw new \RuntimeException('SHAREPOINT_RESPONSE_TOO_LARGE'); }
        return $body;
    }

    private function success(ResponseInterface $response): void
    {
        if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300) { return; }
        throw new \RuntimeException(match ($response->getStatusCode()) {
            400 => 'SHAREPOINT_REJECTED', 401, 403 => 'SHAREPOINT_ACCESS_DENIED', 404 => 'SHAREPOINT_NOT_FOUND',
            409, 412 => 'REVISION_CONFLICT', 429 => 'SHAREPOINT_RATE_LIMITED', default => 'SHAREPOINT_UNAVAILABLE',
        });
    }
}
