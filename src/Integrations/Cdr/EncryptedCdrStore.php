<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;

/** Encrypted profile configuration and query metadata. Query result rows never enter this store. */
final class EncryptedCdrStore
{
    private string $directory;
    private string $key;
    private string $owner;

    public function __construct(Settings $settings, Actor $actor)
    {
        $this->directory = $settings->get('CDR_DATA_DIR');
        $keyFile = $settings->get('CDR_ENCRYPTION_KEY_FILE');
        $hex = $keyFile !== '' && is_file($keyFile) ? trim((string) file_get_contents($keyFile)) : '';
        if (!preg_match('/^[a-f0-9]{64}$/D', $hex)) { throw new \RuntimeException('CDR_ENCRYPTION_NOT_CONFIGURED'); }
        $this->key = (string) hex2bin($hex);
        $this->owner = hash('sha256', $actor->tenant . "\0" . $actor->id);
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE');
        }
    }

    /**
     * @return array<string, mixed> */
    public function read(): array
    {
        return $this->locked(static fn (array $state): array => $state, false);
    }

    /**
     * @param callable(array<string, mixed>): array<string, mixed> $change
     * @return array<string, mixed> */
    public function update(callable $change): array { return $this->locked($change, true); }

    /**
     * @param callable(array<string, mixed>): array<string, mixed> $change
     * @return array<string, mixed> */
    private function locked(callable $change, bool $write): array
    {
        $base = $this->directory . '/' . $this->owner;
        $lock = fopen($base . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX)) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
        try {
            $state = ['connections' => [], 'saved' => [], 'history' => []];
            if (is_file($base . '.json')) {
                if (filesize($base . '.json') > 33554432) { throw new \RuntimeException('CDR_STORAGE_INVALID'); }
                $record = json_decode((string) file_get_contents($base . '.json'), true, 8, JSON_THROW_ON_ERROR);
                if (!is_array($record)) { throw new \RuntimeException('CDR_STORAGE_INVALID'); }
                $plain = openssl_decrypt(base64_decode((string) ($record['data'] ?? ''), true) ?: '', 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA,
                    base64_decode((string) ($record['iv'] ?? ''), true) ?: '', base64_decode((string) ($record['tag'] ?? ''), true) ?: '', $this->owner);
                if ($plain === false) { throw new \RuntimeException('CDR_STORAGE_INVALID'); }
                $state = json_decode($plain, true, 64, JSON_THROW_ON_ERROR);
                if (!is_array($state) || !is_array($state['connections'] ?? null) || !is_array($state['saved'] ?? null)
                    || !is_array($state['history'] ?? null)) { throw new \RuntimeException('CDR_STORAGE_INVALID'); }
            }
            $state = $change($state);
            if ($write) {
                $iv = random_bytes(12); $tag = '';
                $cipher = openssl_encrypt(json_encode($state, JSON_THROW_ON_ERROR), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag, $this->owner);
                if ($cipher === false) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
                $temporary = $base . '.' . bin2hex(random_bytes(8));
                try {
                    $encoded = json_encode(['iv' => base64_encode($iv), 'tag' => base64_encode($tag), 'data' => base64_encode($cipher)], JSON_THROW_ON_ERROR);
                    if (strlen($encoded) > 33554432 || file_put_contents($temporary, $encoded, LOCK_EX) !== strlen($encoded)) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
                    chmod($temporary, 0600);
                    if (!rename($temporary, $base . '.json')) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
                } finally { if (is_file($temporary)) { unlink($temporary); } }
            }
            return $state;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }

    public function jobPath(string $id): string
    {
        if (!preg_match('/^[a-f0-9]{32}$/D', $id)) { throw new \InvalidArgumentException('CDR_INVALID_JOB'); }
        return $this->directory . '/' . $this->owner . '-job-' . $id;
    }
}
