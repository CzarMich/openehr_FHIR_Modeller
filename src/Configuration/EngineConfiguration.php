<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Configuration;

final class EngineConfiguration
{
    public static function validate(Settings $settings): void
    {
        $url = $settings->get('OPENEHR_ENGINE_URL');
        if ($url !== '' && $url !== 'http://127.0.0.1:8090') {
            Settings::validateUrl($url);
            if (parse_url($url, PHP_URL_PATH) || str_ends_with($url, '/')) {
                throw new \InvalidArgumentException('OPENEHR_ENGINE_URL requires an origin without a path.');
            }
        }
        $timeout = $settings->get('OPENEHR_ENGINE_TIMEOUT');
        if (!ctype_digit($timeout) || (int) $timeout < 1 || (int) $timeout > 60) {
            throw new \InvalidArgumentException('OPENEHR_ENGINE_TIMEOUT must be 1..60 seconds.');
        }
        $path = $settings->get('OPENEHR_ENGINE_KEY_FILE');
        if ($url !== '' && (!str_starts_with($path, '/') || strlen($path) > 4096 || preg_match('/[\x00-\x1f\x7f]/', $path))) {
            throw new \InvalidArgumentException('OPENEHR_ENGINE_KEY_FILE requires an absolute secret-file path.');
        }
    }

    public static function key(Settings $settings): string
    {
        $path = $settings->get('OPENEHR_ENGINE_KEY_FILE');
        if (!is_file($path) || !is_readable($path) || filesize($path) > 257) {
            throw new \RuntimeException('ENGINE_CREDENTIAL_UNAVAILABLE');
        }
        $value = @file_get_contents($path, false, null, 0, 258);
        if (!is_string($value) || !preg_match('/^[a-f0-9]{64,128}\n?$/D', $value)) {
            throw new \RuntimeException('ENGINE_CREDENTIAL_INVALID');
        }
        return rtrim($value, "\n");
    }
}
