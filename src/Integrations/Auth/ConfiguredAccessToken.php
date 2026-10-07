<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Auth;

final readonly class ConfiguredAccessToken implements AccessTokenProvider
{
    public function __construct(private string $value) { self::validate($value); }
    public function token(): string { return $this->value; }
    public static function validate(string $value): void
    {
        if ($value === '' || strlen($value) > 32768 || !preg_match('#^[A-Za-z0-9._~+/-]+=*$#D', $value)) {
            throw new \InvalidArgumentException('INVALID_SERVICE_TOKEN');
        }
    }
}
