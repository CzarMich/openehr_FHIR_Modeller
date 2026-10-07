<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Auth;

use GuzzleHttp\ClientInterface;
use OpenEHR\Assistant\Apis\HttpClientFactory;
use OpenEHR\Assistant\Configuration\Settings;

/** OAuth client credentials, cached only in this service instance and never logged or persisted. */
final class ClientCredentialsToken implements AccessTokenProvider
{
    private ClientInterface $client;
    private string $value = '';
    private int $expires = 0;

    public function __construct(Settings $settings, private readonly string $url, private readonly string $clientId,
        private readonly string $secret, private readonly string $scope, ?ClientInterface $client = null)
    {
        Settings::validateUrl($url);
        if ($clientId === '' || $secret === '' || $scope === '' || strlen($secret) > 4096
            || preg_match('/[\x00-\x1f\x7f]/', $clientId . $scope)) { throw new \InvalidArgumentException('SERVICE_CREDENTIALS_REQUIRED'); }
        $this->client = $client ?? HttpClientFactory::create($url, (int) $settings->get('HTTP_TIMEOUT'), $settings);
    }

    public function token(): string
    {
        if ($this->value !== '' && $this->expires > time() + 60) { return $this->value; }
        try {
            $response = $this->client->request('POST', $this->url, ['allow_redirects' => false, 'http_errors' => false,
                'form_params' => ['grant_type' => 'client_credentials', 'client_id' => $this->clientId,
                    'client_secret' => $this->secret, 'scope' => $this->scope]]);
            if ($response->getStatusCode() !== 200) { throw new \RuntimeException(); }
            $raw = $response->getBody()->read(65537);
            if (strlen($raw) > 65536) { throw new \RuntimeException(); }
            $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
            if (!is_array($data) || !is_string($data['access_token'] ?? null) || !is_string($data['token_type'] ?? null)
                || strcasecmp($data['token_type'], 'Bearer') !== 0 || !is_int($data['expires_in'] ?? null)
                || $data['expires_in'] < 61 || $data['expires_in'] > 86400) { throw new \RuntimeException(); }
            ConfiguredAccessToken::validate($data['access_token']);
            $this->value = $data['access_token']; $this->expires = time() + $data['expires_in'];
            return $this->value;
        } catch (\Throwable) { throw new \RuntimeException('SERVICE_AUTHENTICATION_FAILED'); }
    }
}
