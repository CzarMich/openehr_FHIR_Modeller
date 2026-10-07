<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Configuration;

final class StorageConfiguration
{
    public static function validate(Settings $settings): void
    {
        $dsn = $settings->get('GOVERNANCE_POSTGRES_DSN');
        if ($settings->get('GOVERNANCE_DATABASE_DRIVER') === 'postgres') {
            // PDO accepts credentials/options in DSNs; allow only a narrow deployment grammar.
            if (!preg_match('~^pgsql:host=[A-Za-z0-9_.-]+;port=[0-9]{1,5};dbname=[A-Za-z0-9_]+;sslmode=(?:verify-full|disable)(?:;sslrootcert=/[A-Za-z0-9_./-]+)?$~D', $dsn)
                || !preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $settings->get('GOVERNANCE_POSTGRES_USER'))
                || $settings->get('GOVERNANCE_POSTGRES_PASSWORD_FILE') === '') {
                throw new \InvalidArgumentException('INVALID_GOVERNANCE_POSTGRES_CONFIGURATION');
            }
        }
        if (!ctype_digit($settings->get('MODEL_CACHE_TTL')) || (int) $settings->get('MODEL_CACHE_TTL') < 1 || (int) $settings->get('MODEL_CACHE_TTL') > 86400
            || !preg_match('/^[A-Za-z0-9_-]{1,64}$/D', $settings->get('MODEL_CACHE_NAMESPACE'))) {
            throw new \InvalidArgumentException('INVALID_MODEL_CACHE_CONFIGURATION');
        }
        if ($settings->get('MODEL_CACHE_DRIVER') === 'redis') {
            if (!preg_match('~^(?:redis|rediss)://[A-Za-z0-9_.-]+:[0-9]{1,5}/[0-9]{1,2}$~D', $settings->get('MODEL_CACHE_URL'))
                || $settings->get('MODEL_CACHE_PASSWORD_FILE') === '' || $settings->get('MODEL_CACHE_SIGNING_KEY_FILE') === '') {
                throw new \InvalidArgumentException('INVALID_MODEL_CACHE_CONFIGURATION');
            }
        }
        foreach (['GOVERNANCE_POSTGRES_PASSWORD_FILE', 'MODEL_CACHE_PASSWORD_FILE', 'MODEL_CACHE_SIGNING_KEY_FILE'] as $key) {
            $path = $settings->get($key);
            if ($path !== '' && (!str_starts_with($path, '/') || str_contains($path, '..') || preg_match('/[\x00-\x1f\x7f]/', $path))) {
                throw new \InvalidArgumentException('INVALID_STORAGE_SECRET_PATH');
            }
        }
    }

    public static function secret(string $path): string
    {
        if (!is_file($path) || !is_readable($path) || filesize($path) > 4096) {
            throw new \RuntimeException('STORAGE_SECRET_UNAVAILABLE');
        }
        $secret = trim((string) file_get_contents($path));
        if (strlen($secret) < 32 || preg_match('/[\x00-\x20\x7f]/', $secret)) {
            throw new \RuntimeException('STORAGE_SECRET_INVALID');
        }
        return $secret;
    }
}
