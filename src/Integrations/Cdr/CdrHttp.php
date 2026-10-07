<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

use OpenEHR\Assistant\Configuration\Settings;

/** Bounded, DNS-pinned, verified-TLS transport. No redirects, cookies or ambient proxy credentials. */
class CdrHttp
{
    public function __construct(private readonly Settings $settings)
    {
    }

    /**
     * @return array{scheme: string, host: string, port: int} */
    public function validateUrl(string $url): array
    {
        $parts = parse_url($url);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['fragment']) || isset($parts['query']) || strlen($url) > 1000 || preg_match('/[\x00-\x20\x7f]/', $url)) {
            throw new \InvalidArgumentException('CDR_INVALID_URL');
        }
        $host = strtolower(trim($parts['host'], '[]'));
        $allowed = in_array($host, $this->settings->csv('CDR_ALLOWED_HOSTS'), true);
        if ($parts['scheme'] !== 'https' && !($parts['scheme'] === 'http' && $allowed && $this->settings->get('CDR_ALLOW_HTTP') === 'true')) {
            throw new \InvalidArgumentException('CDR_HTTPS_REQUIRED');
        }
        return ['scheme' => $parts['scheme'], 'host' => $host, 'port' => $parts['port'] ?? ($parts['scheme'] === 'https' ? 443 : 80)];
    }

    /**
     * @param array<string, string> $headers
     * @param callable(): bool $cancelled
     *
     * @return array{status: int, body: string, content_type: string, headers: array<string, string>} */
    public function request(string $url, string $method, array $headers, ?string $body, int $timeout, string $ca, callable $cancelled): array
    {
        $target = $this->validateUrl($url);
        if ($timeout < 1 || $timeout > 120 || !in_array($method, ['GET', 'POST', 'OPTIONS'], true)) { throw new \InvalidArgumentException('CDR_INVALID_REQUEST'); }
        $host = $target['host'];
        $addresses = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : array_values(array_filter(array_merge(
            array_column(@dns_get_record($host, DNS_A) ?: [], 'ip'), array_column(@dns_get_record($host, DNS_AAAA) ?: [], 'ipv6')
        )));
        if ($addresses === []) { throw new \RuntimeException('CDR_DNS_FAILED'); }
        if (!in_array($host, $this->settings->csv('CDR_ALLOWED_HOSTS'), true)) {
            foreach ($addresses as $address) {
                if (!filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)
                    || str_starts_with(strtolower($address), '::ffff:')) { throw new \RuntimeException('CDR_NETWORK_NOT_ALLOWED'); }
            }
        }
        $lines = [];
        foreach ($headers as $name => $value) {
            if (!preg_match('/^[A-Za-z][A-Za-z0-9-]{0,79}$/D', $name) || preg_match('/[\x00-\x1f\x7f]/', $value)) { throw new \InvalidArgumentException('CDR_INVALID_HEADER'); }
            $lines[] = $name . ': ' . $value;
        }
        $curl = curl_init($url);
        if ($curl === false) { throw new \RuntimeException('CDR_UNAVAILABLE'); }
        $responseBody = ''; $responseHeaders = [];
        $transfer = new class { public bool $tooLarge = false; };
        try {
            $resolve = array_map(static fn (string $address): string => str_contains($address, ':') ? '[' . $address . ']' : $address, $addresses);
            curl_setopt_array($curl, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $lines,
                CURLOPT_FOLLOWLOCATION => false, CURLOPT_MAXREDIRS => 0, CURLOPT_PROXY => '', CURLOPT_TIMEOUT => $timeout,
                CURLOPT_CONNECTTIMEOUT => min(10, $timeout), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
                CURLOPT_RESOLVE => [$host . ':' . $target['port'] . ':' . implode(',', $resolve)],
                CURLOPT_NOPROGRESS => false,
                CURLOPT_XFERINFOFUNCTION => static fn (): int => $cancelled() ? 1 : 0,
                CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$responseBody, $transfer): int {
                    if (strlen($responseBody) + strlen($chunk) > 8388608) { $transfer->tooLarge = true; return 0; }
                    $responseBody .= $chunk; return strlen($chunk);
                },
                CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$responseHeaders): int {
                    $parts = explode(':', $line, 2);
                    if (count($parts) === 2 && in_array(strtolower($parts[0]), ['content-type', 'allow', 'openehr-version', 'openehr-rest-api-version'], true)) {
                        $responseHeaders[strtolower($parts[0])] = substr(trim($parts[1]), 0, 200);
                    }
                    return strlen($line);
                },
            ]);
            if ($ca !== '') { curl_setopt($curl, CURLOPT_CAINFO_BLOB, $ca); }
            elseif ($this->settings->get('HTTP_CA_BUNDLE') !== '') { curl_setopt($curl, CURLOPT_CAINFO, $this->settings->get('HTTP_CA_BUNDLE')); }
            if ($body !== null) { curl_setopt($curl, CURLOPT_POSTFIELDS, $body); }
            $ok = curl_exec($curl);
            if ($ok === false) {
                throw new \RuntimeException($transfer->tooLarge ? 'CDR_RESPONSE_LIMIT' : ($cancelled() ? 'CDR_CANCELLED' : match (curl_errno($curl)) {
                    CURLE_OPERATION_TIMEDOUT => 'CDR_TIMEOUT', CURLE_SSL_CACERT, CURLE_SSL_CONNECT_ERROR => 'CDR_TLS_FAILED',
                    CURLE_COULDNT_RESOLVE_HOST => 'CDR_DNS_FAILED', default => 'CDR_UNAVAILABLE',
                }));
            }
            return ['status' => (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE), 'body' => $responseBody,
                'content_type' => (string) curl_getinfo($curl, CURLINFO_CONTENT_TYPE), 'headers' => $responseHeaders];
        } finally { curl_close($curl); }
    }
}
