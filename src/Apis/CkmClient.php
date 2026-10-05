<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Apis;

use GuzzleHttp\Client;
use GuzzleHttp\ClientTrait;
use GuzzleHttp\Promise\PromiseInterface;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Configuration\CkmAuthentication;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;

class CkmClient
{
    use ClientTrait;

    protected readonly Client $client;
    private readonly Settings $settings;
    private readonly string $source;
    private ?float $requestTimeout = null;
    /** @var array<string, string> */
    private readonly array $authentication;

    /** @param array<string, Client> $sourceClients Optional isolated transports for contract tests. */
    public function __construct(
        protected readonly LoggerInterface $logger,
        ?Client $client = null,
        ?Settings $settings = null,
        private readonly array $sourceClients = [],
        ?string $source = null
    ) {
        $this->settings = $settings ?? Settings::fromEnvironment();
        $this->source = $source ?? $this->settings->get('CKM_DEFAULT_SOURCE');
        $sources = $this->settings->ckmSources();
        if (!isset($sources[$this->source])) {
            throw new \InvalidArgumentException('CKM_SOURCE_UNKNOWN');
        }
        $profiles = CkmAuthentication::profiles($this->settings->get('CKM_AUTH'), $sources);
        $this->authentication = $profiles[$this->source] ?? [];
        $this->client = $client ?? $sourceClients[$this->source] ?? HttpClientFactory::create($sources[$this->source], (int) $this->settings->get('CKM_TIMEOUT'), $this->settings);
    }

    public function forSource(?string $source): self
    {
        $source ??= $this->settings->get('CKM_DEFAULT_SOURCE');
        if ($source === $this->source) {
            return $this;
        }
        $sources = $this->settings->ckmSources();
        if (!isset($sources[$source])) {
            throw new \Mcp\Exception\ToolCallException('CKM_SOURCE_UNKNOWN: select a name returned by ckm_sources.');
        }
        return new self($this->logger, null, $this->settings, $this->sourceClients, $source);
    }

    /** Limit a federated request to its remaining wall-clock budget. */
    public function withTimeout(float $seconds): self
    {
        if ($seconds <= 0 || !is_finite($seconds) || $seconds > 60) {
            throw new \InvalidArgumentException('INVALID_CKM_REQUEST_TIMEOUT');
        }
        $copy = clone $this;
        $copy->requestTimeout = min($seconds, (float) $this->settings->get('CKM_TIMEOUT'));
        return $copy;
    }

    /**
     * @return array<string, string> */
    public function sources(): array
    {
        return $this->settings->ckmSources();
    }

    public function defaultSource(): string
    {
        return $this->settings->get('CKM_DEFAULT_SOURCE');
    }

    /**
     * @param array<string, mixed> $options */
    public function request(string $method, $uri, array $options = []): ResponseInterface
    {
        HttpClientFactory::relativePath((string) $uri);
        return $this->client->request($method, $uri, $this->options($options));
    }

    /**
     * @param array<string, mixed> $options */
    public function requestAsync(string $method, $uri, array $options = []): PromiseInterface
    {
        HttpClientFactory::relativePath((string) $uri);
        return $this->client->requestAsync($method, $uri, $this->options($options));
    }

    /** @param array<string, mixed> $options
     * @return array<string, mixed> */
    private function options(array $options): array
    {
        $headers = CkmAuthentication::headers($this->authentication);
        if ($headers !== []) {
            unset($options['auth']);
            $reserved = array_map('strtolower', array_keys($headers));
            foreach (array_keys($options['headers'] ?? []) as $key) {
                if (in_array(strtolower((string) $key), $reserved, true)) {
                    unset($options['headers'][$key]);
                }
            }
            $options['headers'] = array_merge($options['headers'] ?? [], $headers);
            $options['allow_redirects'] = false;
            $options['cookies'] = false;
        }
        if ($this->requestTimeout !== null) {
            $options['timeout'] = $this->requestTimeout;
            $options['connect_timeout'] = min(5.0, $this->requestTimeout);
        }
        return $options;
    }
}
