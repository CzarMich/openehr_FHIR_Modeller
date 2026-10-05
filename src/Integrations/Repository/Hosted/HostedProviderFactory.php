<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\Hosted;

use GuzzleHttp\ClientInterface;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\HostedRepositoryProvider;

final class HostedProviderFactory
{
    public static function create(Settings $settings, ?ClientInterface $client = null): ?HostedRepositoryProvider
    {
        $provider = $settings->get('MODEL_REPOSITORY_PROVIDER');
        if (!in_array($provider, ['github', 'gitlab'], true)) { return null; }
        $remote = $settings->get('MODEL_GIT_REMOTE_URL');
        // OIDC readiness has no principal, and therefore no tenant remote.
        if ($remote === '' && $settings->get('AUTH_MODE') === 'oidc') { return null; }
        $url = parse_url($remote);
        $path = is_array($url) ? trim($url['path'] ?? '', '/') : '';
        $path = preg_replace('/\.git$/D', '', $path) ?? '';
        if (!is_array($url) || !in_array($url['scheme'] ?? '', ['https', 'ssh'], true) || !isset($url['host'])
            || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])
            || ($url['scheme'] === 'https' && isset($url['user']))
            || !preg_match('~^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$~D', $path)
            || str_contains($path, '..') || ($provider === 'github' && substr_count($path, '/') !== 1)) {
            throw new \InvalidArgumentException('INVALID_HOSTED_GIT_REMOTE');
        }
        $host = strtolower($url['host']);
        $base = $settings->get('MODEL_HOSTED_API_URL');
        if ($base === '') {
            $base = $provider === 'github' ? 'https://api.github.com/' : 'https://' . $host . '/api/v4/';
        }
        Settings::validateUrl($base);
        $apiHost = strtolower((string) parse_url($base, PHP_URL_HOST));
        if ($apiHost !== $host && !($provider === 'github' && $host === 'github.com' && $apiHost === 'api.github.com')) {
            throw new \InvalidArgumentException('HOSTED_API_REMOTE_HOST_MISMATCH');
        }
        $api = new HostedApi($settings, $base, $settings->get('MODEL_HOSTED_TOKEN'), $provider === 'github', $client);
        return $provider === 'github' ? new GitHubProvider($api, $path, $host) : new GitLabProvider($api, $path, $host);
    }
}
