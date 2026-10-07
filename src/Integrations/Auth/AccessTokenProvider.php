<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Auth;

/** Outbound service credential boundary; unrelated to inbound human/client identity. */
interface AccessTokenProvider
{
    public function token(): string;
}
