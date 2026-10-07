<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\Hosted;

use GuzzleHttp\ClientInterface;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use OpenEHR\Assistant\Configuration\Settings;

/** Fixed administrator-selected origin. Never follows provider links or redirects. */
final readonly class HostedApi
{
    private ClientInterface $client;
    private int $limit;

    public function __construct(Settings $settings, string $base, private string $token, private bool $github, ?ClientInterface $client = null)
    {
        Settings::validateUrl($base);
        if (preg_match('/[\x00-\x20\x7f]/', $token)) { throw new \InvalidArgumentException('INVALID_HOSTED_TOKEN'); }
        $this->client = $client ?? HttpClientFactory::create($base, (int) $settings->get('HTTP_TIMEOUT'), $settings);
        $this->limit = (int) $settings->get('MAX_UPSTREAM_BYTES');
    }

    /** Path segments are encoded separately, including GitLab's namespaced project identifier.
     * @param list<string> $segments
     * @param array<string, mixed> $query
     * @param array<string, mixed>|null $body
     * @return array<mixed> */
    public function request(string $method, array $segments, array $query = [], ?array $body = null): array
    {
        foreach ($segments as $segment) {
            if ($segment === '' || in_array($segment, ['.', '..'], true) || preg_match('/[\x00-\x1f\x7f]/', $segment)) {
                throw new \InvalidArgumentException('INVALID_HOSTED_API_PATH');
            }
        }
        $headers = ['Accept' => 'application/json', 'User-Agent' => 'openEHR-Modelling-Assistant'];
        if ($this->github) {
            $headers['Accept'] = 'application/vnd.github+json';
            $headers['X-GitHub-Api-Version'] = '2026-03-10';
            if ($this->token !== '') { $headers['Authorization'] = 'Bearer ' . $this->token; }
        } elseif ($this->token !== '') { $headers['PRIVATE-TOKEN'] = $this->token; }
        $options = ['headers' => $headers, 'query' => $query, 'http_errors' => false, 'allow_redirects' => false];
        if ($body !== null) { $options['json'] = $body; }
        try {
            $response = $this->client->request($method, implode('/', array_map('rawurlencode', $segments)), $options);
        } catch (\Throwable) { throw new \RuntimeException('HOSTED_REPOSITORY_UNAVAILABLE'); }
        $status = $response->getStatusCode();
        if ($status < 200 || $status >= 300) {
            throw new \RuntimeException(match ($status) {
                401, 403 => 'HOSTED_REPOSITORY_ACCESS_DENIED', 404 => 'HOSTED_REPOSITORY_NOT_FOUND',
                409, 422 => 'HOSTED_REVIEW_CONFLICT', 429 => 'HOSTED_REPOSITORY_RATE_LIMITED',
                default => 'HOSTED_REPOSITORY_UNAVAILABLE',
            });
        }
        $raw = $response->getBody()->read($this->limit + 1);
        if (strlen($raw) > $this->limit) { throw new \RuntimeException('HOSTED_RESPONSE_TOO_LARGE'); }
        try { $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        if (!is_array($data)) { throw new \RuntimeException('HOSTED_INVALID_RESPONSE'); }
        return $data;
    }
}
