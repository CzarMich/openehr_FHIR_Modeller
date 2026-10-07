<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Apis;

use GuzzleHttp\Client;
use GuzzleHttp\RequestOptions;
use OpenEHR\Assistant\Configuration\Settings;
use Psr\Http\Message\ResponseInterface;

final class HttpClientFactory
{
    public static function create(string $baseUrl, int $timeout, Settings $settings, ?string $bearer = null): Client
    {
        Settings::validateUrl($baseUrl);
        $limit = (int) $settings->get('MAX_UPSTREAM_BYTES');
        $config = [
            'base_uri' => rtrim($baseUrl, '/') . '/',
            RequestOptions::VERIFY => $settings->get('HTTP_CA_BUNDLE') ?: true,
            RequestOptions::TIMEOUT => $timeout,
            RequestOptions::CONNECT_TIMEOUT => min(5, $timeout),
            RequestOptions::ALLOW_REDIRECTS => false,
            RequestOptions::COOKIES => false,
            RequestOptions::ON_HEADERS => static function (ResponseInterface $response) use ($limit): void {
                if ((int) $response->getHeaderLine('Content-Length') > $limit) {
                    throw new \RuntimeException('External response exceeds configured size limit.');
                }
            },
            RequestOptions::PROGRESS => static function (float $total, float $downloaded) use ($limit): void {
                if ($downloaded > $limit || $total > $limit) {
                    throw new \RuntimeException('External response exceeds configured size limit.');
                }
            },
        ];
        if ($bearer !== null && $bearer !== '') {
            $config[RequestOptions::HEADERS] = ['Authorization' => 'Bearer ' . $bearer];
        }
        // Deliberately read proxy configuration from the process environment only.
        if (getenv('HTTPS_PROXY')) {
            $config[RequestOptions::PROXY] = ['https' => getenv('HTTPS_PROXY'), 'no' => explode(',', (string) getenv('NO_PROXY'))];
        }
        return new Client($config);
    }

    public static function relativePath(string $path): void
    {
        if ($path === '' || str_starts_with($path, '/') || str_contains($path, ':')
            || str_contains($path, '\\') || str_contains($path, '%')
            || preg_match('~(^|/)\.\.?(/|$)|[?#\x00-\x20\x7f]~', $path)) {
            throw new \InvalidArgumentException('Invalid external API path.');
        }
    }
}
