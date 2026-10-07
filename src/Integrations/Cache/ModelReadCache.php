<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cache;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Configuration\StorageConfiguration;

/** Optional, authenticated JSON cache of immutable model reads. Never caches authorization or governance. */
final class ModelReadCache
{
    private ?\Redis $redis = null;
    private bool $unavailable = false;
    private ?string $signingKey = null;

    public function __construct(private readonly Settings $settings, private readonly string $scope)
    {
    }

    /** @param callable(): array<string, mixed> $load
     * @return array<string, mixed> */
    public function remember(string $identity, callable $load): array
    {
        if ($this->settings->get('MODEL_CACHE_DRIVER') === 'none') {
            return $load();
        }
        $key = $this->settings->get('MODEL_CACHE_NAMESPACE') . ':' . hash('sha256', $this->scope . "\0" . $identity);
        $connection = $this->connection();
        if ($connection !== null) {
            try {
                $cached = $connection->get($key);
                if (is_string($cached) && strlen($cached) <= 4194304) {
                    $envelope = json_decode($cached, true, 4, JSON_THROW_ON_ERROR);
                    if (is_array($envelope) && is_string($envelope['payload'] ?? null) && is_string($envelope['mac'] ?? null)
                        && is_int($envelope['expires'] ?? null) && $envelope['expires'] > time()
                        && hash_equals($this->mac($key, $envelope['expires'], $envelope['payload']), $envelope['mac'])) {
                        $value = json_decode($envelope['payload'], true, 64, JSON_THROW_ON_ERROR);
                        if (is_array($value)) {
                            return $value;
                        }
                    }
                }
            } catch (\Throwable) {
                $this->unavailable = true;
                // Cache failure/corruption is a miss; the authoritative loader still decides access.
            }
        }
        $value = $load();
        if ($connection !== null && !$this->unavailable) {
            try {
                $payload = json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if (strlen($payload) <= 2097152) {
                    $ttl = (int) $this->settings->get('MODEL_CACHE_TTL');
                    $expires = time() + $ttl;
                    $connection->setex($key, $ttl, json_encode(['payload' => $payload, 'expires' => $expires, 'mac' => $this->mac($key, $expires, $payload)], JSON_THROW_ON_ERROR));
                }
            } catch (\Throwable) {
                // Eviction, memory limits and outages cannot turn a successful repository read into an error.
            }
        }
        return $value;
    }

    private function mac(string $key, int $expires, string $payload): string
    {
        return hash_hmac(
            'sha256',
            $key . "\0" . $expires . "\0" . $payload,
            $this->signingKey ?? throw new \RuntimeException('MODEL_CACHE_UNAVAILABLE')
        );
    }

    private function connection(): ?\Redis
    {
        if ($this->unavailable) {
            return null;
        }
        if ($this->redis !== null) {
            return $this->redis;
        }
        try {
            $url = parse_url($this->settings->get('MODEL_CACHE_URL'));
            if (!is_array($url) || !isset($url['host'], $url['port'], $url['path'], $url['scheme'])) {
                return null;
            }
            $this->signingKey = StorageConfiguration::secret($this->settings->get('MODEL_CACHE_SIGNING_KEY_FILE'));
            $redis = new \Redis();
            // Local private network or verified TLS; short deadlines keep an outage bounded.
            // Native resolver timeouts can exceed the socket deadline when a service disappears.
            $address = $this->resolve($url['host'], $url['port']);
            $host = ($url['scheme'] === 'rediss' ? 'tls://' : '') . (str_contains($address, ':') ? '[' . $address . ']' : $address);
            if (!@$redis->connect(
                $host,
                $url['port'],
                0.15,
                null,
                0,
                0.15,
                $url['scheme'] === 'rediss' ? ['stream' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $url['host']]] : null
            )) {
                throw new \RuntimeException('CACHE_CONNECT_FAILED');
            }
            if (!$redis->auth(StorageConfiguration::secret($this->settings->get('MODEL_CACHE_PASSWORD_FILE')))
                || !$redis->select((int) substr($url['path'], 1))) {
                throw new \RuntimeException('CACHE_AUTH_FAILED');
            }
            // JSON only: never deserialize objects from a shared cache service.
            $redis->setOption(\Redis::OPT_SERIALIZER, \Redis::SERIALIZER_NONE);
            return $this->redis = $redis;
        } catch (\Throwable) {
            $this->unavailable = true;
            return null;
        }
    }
    private function resolve(string $host, int $port): string
    {
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            return $host;
        }
        $curl = curl_init('http://' . $host . ':' . $port);
        if ($curl === false) {
            throw new \RuntimeException('CACHE_CONNECT_FAILED');
        }
        try {
            // Connect-only sends no HTTP data to Valkey and bounds DNS plus TCP setup.
            curl_setopt_array($curl, [CURLOPT_CONNECT_ONLY => true, CURLOPT_TIMEOUT_MS => 150,
                CURLOPT_CONNECTTIMEOUT_MS => 150, CURLOPT_PROXY => '', CURLOPT_PROTOCOLS => CURLPROTO_HTTP]);
            if (curl_exec($curl) === false) {
                throw new \RuntimeException('CACHE_CONNECT_FAILED');
            }
            $address = curl_getinfo($curl, CURLINFO_PRIMARY_IP);
            if (filter_var($address, FILTER_VALIDATE_IP) === false) {
                throw new \RuntimeException('CACHE_CONNECT_FAILED');
            }
            return $address;
        } finally {
            curl_close($curl);
        }
    }

}
