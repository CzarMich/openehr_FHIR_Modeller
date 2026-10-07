<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Auth;

use Psr\Http\Message\ServerRequestInterface;

interface Authenticator
{
    /** Returns a stable principal identifier; credentials must never be returned. */
    public function authenticate(ServerRequestInterface $request): ?string;
}
