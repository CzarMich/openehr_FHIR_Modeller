<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Fhir;

use GuzzleHttp\Client;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Standards\StandardsProvider;

final readonly class HttpFhirProvider implements StandardsProvider
{
    private Client $client;
    public function __construct(private Settings $settings, private string $tenant = 'shared', ?Client $client = null)
    {
        $this->client = $client ?? new Client(['timeout' => 560, 'connect_timeout' => 5, 'allow_redirects' => false,
            'cookies' => false, 'http_errors' => false, 'proxy' => '', 'verify' => true]);
    }

    public function standard(): string { return 'FHIR'; }

    /** The configured private engine is a deployment dependency, not an external registry. */
    public function assertReady(): void
    {
        $url = $this->settings->get('FHIR_ENGINE_URL');
        if ($url === '') { return; }
        try {
            $response = $this->client->get(rtrim($url, '/') . '/health', ['timeout' => 2, 'connect_timeout' => 1,
                'allow_redirects' => false, 'http_errors' => false]);
            $data = json_decode($response->getBody()->read(65537), true, 16, JSON_THROW_ON_ERROR);
            if ($response->getStatusCode() !== 200 || !is_array($data) || ($data['status'] ?? null) !== 'ok'
                || ($data['toolsReady'] ?? false) !== true) { throw new \RuntimeException('FHIR_ENGINE_NOT_READY'); }
        } catch (\Throwable) { throw new \RuntimeException('FHIR_ENGINE_NOT_READY'); }
    }

    public function execute(string $operation, array $parameters): array
    {
        $url = $this->settings->get('FHIR_ENGINE_URL');
        $file = $this->settings->get('FHIR_ENGINE_KEY_FILE');
        if ($url === '' || $file === '' || !is_readable($file)) { throw new \RuntimeException('FHIR_ENGINE_NOT_CONFIGURED'); }
        $key = trim((string) file_get_contents($file));
        if (strlen($key) < 32) { throw new \RuntimeException('FHIR_ENGINE_KEY_INVALID'); }
        $body = json_encode(['operation' => $operation, 'parameters' => (object) $parameters, 'tenant' => $this->tenant], JSON_THROW_ON_ERROR);
        if (strlen($body) > 8388608) { throw new \InvalidArgumentException('FHIR_INPUT_LIMIT'); }
        try {
            $response = $this->client->post(rtrim($url, '/') . '/execute', ['body' => $body,
                'headers' => ['Authorization' => 'Bearer ' . $key, 'Content-Type' => 'application/json'],
                'on_headers' => static function (\Psr\Http\Message\ResponseInterface $r): void {
                    if ((int) $r->getHeaderLine('Content-Length') > 16777216) { throw new \RuntimeException('FHIR_OUTPUT_LIMIT'); }
                }, 'progress' => static function (float $total, float $downloaded): void {
                    if ($total > 16777216 || $downloaded > 16777216) { throw new \RuntimeException('FHIR_OUTPUT_LIMIT'); }
                }]);
            $raw = $response->getBody()->read(16777217);
            if (strlen($raw) > 16777216) { throw new \RuntimeException('FHIR_OUTPUT_LIMIT'); }
            $data = json_decode($raw, true, 96, JSON_THROW_ON_ERROR);
        } catch (\Throwable) { throw new \RuntimeException('FHIR_ENGINE_UNAVAILABLE'); }
        if (!is_array($data)) { throw new \RuntimeException('FHIR_ENGINE_RESPONSE_INVALID'); }
        if ($response->getStatusCode() !== 200 || isset($data['error'])) {
            $code = $data['error']['code'] ?? '';
            throw new \RuntimeException(is_string($code) && preg_match('/^[A-Z][A-Z0-9_]{2,80}$/D', $code) ? $code : 'FHIR_ENGINE_REJECTED');
        }
        return $data;
    }
}
