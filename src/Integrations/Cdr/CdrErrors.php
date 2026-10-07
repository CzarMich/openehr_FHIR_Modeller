<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

final class CdrErrors
{
    public static function safe(string $message): string
    {
        return preg_match('/^(?:CDR|ENGINE)_[A-Z_]{1,70}$/D', $message) ? $message : 'CDR_OPERATION_FAILED';
    }
}
