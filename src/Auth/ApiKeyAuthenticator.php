<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Auth;

use Psr\Http\Message\ServerRequestInterface;

final readonly class ApiKeyAuthenticator implements Authenticator
{
    public function __construct(private string $key, private string $header = 'X-API-Key')
    {
    }

    public function authenticate(ServerRequestInterface $request): ?string
    {
        $provided = $request->getHeaderLine($this->header);
        return $this->key !== '' && hash_equals($this->key, $provided) ? 'api-key-service' : null;
    }
}
