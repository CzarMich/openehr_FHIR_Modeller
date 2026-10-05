<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

use OpenEHR\Assistant\Domain\Cdr\CredentialResolver;

/** Connection records reach this boundary only after authenticated decryption or administrator configuration. */
final class ConfiguredCredentials implements CredentialResolver
{
    public function resolve(array $connection): array
    {
        $credentials = [];
        foreach (['password', 'token', 'apiKey', 'clientSecret'] as $name) {
            $value = $connection['secrets'][$name] ?? '';
            $reference = $connection['secretRefs'][$name] ?? null;
            if ($reference !== null) {
                if (!is_string($reference) || !preg_match('/^env:CDR_SECRET_[A-Z0-9_]+$/D', $reference)) {
                    throw new \RuntimeException('CDR_CREDENTIAL_REFERENCE_INVALID');
                }
                $value = getenv(substr($reference, 4));
                if ($value === false || $value === '') { throw new \RuntimeException('CDR_CREDENTIAL_UNAVAILABLE'); }
            }
            if (!is_string($value) || strlen($value) > 8192 || preg_match('/[\x00-\x1f\x7f]/', $value)) {
                throw new \RuntimeException('CDR_CREDENTIAL_INVALID');
            }
            $credentials[$name] = $value;
        }
        return $credentials;
    }
}
