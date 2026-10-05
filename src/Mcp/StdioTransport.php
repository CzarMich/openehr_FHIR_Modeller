<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

final class StdioTransport extends \Mcp\Server\Transport\StdioTransport
{
    use CorrelatesRequestErrors;
}
