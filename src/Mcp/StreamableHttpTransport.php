<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

final class StreamableHttpTransport extends \Mcp\Server\Transport\StreamableHttpTransport
{
    use CorrelatesRequestErrors;
}
