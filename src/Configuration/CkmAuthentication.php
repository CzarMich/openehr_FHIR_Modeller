<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Configuration;

/** Per-source outbound credentials. Values never belong in client-visible source discovery. */
final class CkmAuthentication
{
    /** @param array<string, string> $sources
     * @return array<string, array<string, string>> */
    public static function profiles(string $json, array $sources): array
    {
        if (strlen($json) > 65536) {
            throw new \InvalidArgumentException('INVALID_CKM_AUTH_CONFIGURATION');
        }
        try {
            $data = \OpenEHR\Assistant\Validation\JsonDocument::parse($json);
        } catch (\JsonException|\InvalidArgumentException) {
            throw new \InvalidArgumentException('INVALID_CKM_AUTH_CONFIGURATION');
        }
        if (!$data instanceof \stdClass || count(get_object_vars($data)) > 32) {
            throw new \InvalidArgumentException('INVALID_CKM_AUTH_CONFIGURATION');
        }
        $profiles = [];
        foreach (get_object_vars($data) as $source => $profile) {
            if (!isset($sources[$source]) || !$profile instanceof \stdClass) {
                throw new \InvalidArgumentException('INVALID_CKM_AUTH_SOURCE');
            }
            $values = get_object_vars($profile);
            foreach ($values as $value) {
                if (!is_string($value)) {
                    throw new \InvalidArgumentException('INVALID_CKM_AUTH_CONFIGURATION');
                }
            }
            $method = $values['method'] ?? '';
            $allowed = ['method', 'secret', 'secret_file'];
            if ($method === 'basic') {
                $allowed[] = 'username';
                if (!isset($values['username']) || $values['username'] === '' || strlen($values['username']) > 200
                    || preg_match('/[:\x00-\x1f\x7f]/', $values['username'])) {
                    throw new \InvalidArgumentException('INVALID_CKM_AUTH_USERNAME');
                }
            } elseif ($method === 'api_key') {
                $allowed[] = 'header';
                $header = $values['header'] ?? '';
                if (!preg_match('/^[A-Za-z][A-Za-z0-9-]{0,99}$/D', $header)
                    || in_array(strtolower($header), ['host', 'cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect', 'accept', 'accept-encoding', 'forwarded', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'], true)) {
                    throw new \InvalidArgumentException('INVALID_CKM_AUTH_HEADER');
                }
            } elseif (!in_array($method, ['bearer', 'session'], true)) {
                throw new \InvalidArgumentException('INVALID_CKM_AUTH_METHOD');
            }
            if (array_diff(array_keys($values), $allowed) !== [] || isset($values['secret']) === isset($values['secret_file'])) {
                throw new \InvalidArgumentException('INVALID_CKM_AUTH_CONFIGURATION');
            }
            if (isset($values['secret'])) {
                self::validateSecret($values['secret'], $method);
            } elseif (!str_starts_with($values['secret_file'], '/') || strlen($values['secret_file']) > 4096
                || preg_match('/[\x00-\x1f\x7f]/', $values['secret_file'])) {
                throw new \InvalidArgumentException('INVALID_CKM_SECRET_FILE');
            }
            $profiles[$source] = $values;
        }
        return $profiles;
    }

    /** @param array<string, string> $profile
     * @return array<string, string> */
    public static function headers(array $profile): array
    {
        if ($profile === []) {
            return [];
        }
        $secret = $profile['secret'] ?? null;
        if ($secret === null) {
            $path = $profile['secret_file'];
            // Deployment-selected regular files only; callers never select paths through MCP.
            if (!is_file($path) || !is_readable($path) || filesize($path) > 32769) {
                throw new \RuntimeException('CKM_CREDENTIAL_UNAVAILABLE');
            }
            $value = @file_get_contents($path, false, null, 0, 32770);
            if ($value === false) {
                throw new \RuntimeException('CKM_CREDENTIAL_UNAVAILABLE');
            }
            $secret = preg_replace('/\r?\n\z/', '', $value) ?? '';
        }
        self::validateSecret($secret, $profile['method']);
        return match ($profile['method']) {
            'basic' => ['Authorization' => 'Basic ' . base64_encode($profile['username'] . ':' . $secret)],
            'bearer' => ['Authorization' => 'Bearer ' . $secret],
            'session' => ['JSESSIONID' => $secret],
            'api_key' => [$profile['header'] => $secret],
            default => throw new \RuntimeException('INVALID_CKM_AUTH_METHOD'),
        };
    }

    private static function validateSecret(string $secret, string $method): void
    {
        if ($secret === '' || strlen($secret) > 32768 || preg_match('/[\x00-\x1f\x7f]/', $secret)
            || ($method !== 'basic' && !preg_match('/^[\x21-\x7e]+$/D', $secret))) {
            throw new \InvalidArgumentException('INVALID_CKM_CREDENTIAL');
        }
    }
}
