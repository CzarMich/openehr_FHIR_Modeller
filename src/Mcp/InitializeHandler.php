<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

use Mcp\Schema\Implementation;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\InitializeRequest;
use Mcp\Schema\Result\InitializeResult;
use Mcp\Server\Configuration;
use Mcp\Server\Handler\Request\RequestHandlerInterface;
use Mcp\Server\Session\SessionInterface;

/** Preserve SDK handshake state while selecting a supported client-requested version.
 * @implements RequestHandlerInterface<InitializeResult> */
final readonly class InitializeHandler implements RequestHandlerInterface
{
    public function __construct(private Implementation $info, private string $instructions)
    {
    }

    public function supports(Request $request): bool
    {
        return $request instanceof InitializeRequest;
    }

    /** @return Response<InitializeResult> */
    public function handle(Request $request, SessionInterface $session): Response
    {
        if (!$request instanceof InitializeRequest) {
            throw new \LogicException('Initialization handler received another operation.');
        }
        $version = ProtocolProfile::negotiate($request->protocolVersion);
        $configuration = new Configuration(
            $this->info,
            ProtocolProfile::capabilities(),
            instructions: $this->instructions,
            protocolVersion: $version
        );
        $session->set('protocol_version', $version->value);
        return (new \Mcp\Server\Handler\Request\InitializeHandler($configuration))->handle($request, $session);
    }
}
