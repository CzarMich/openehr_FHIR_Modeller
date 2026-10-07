<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Mcp;

use Mcp\Schema\Enum\ProtocolVersion;
use Mcp\Schema\ServerCapabilities;

/** The product's transport contract, independent of modelling domain services. */
final class ProtocolProfile
{
    /** @return list<ProtocolVersion> */
    public static function versions(): array
    {
        return [ProtocolVersion::V2025_03_26, ProtocolVersion::V2025_06_18, ProtocolVersion::V2025_11_25];
    }

    public static function negotiate(string $requested): ProtocolVersion
    {
        $version = ProtocolVersion::tryFrom($requested);
        return in_array($version, self::versions(), true) ? $version : ProtocolVersion::V2025_11_25;
    }

    public static function capabilities(): ServerCapabilities
    {
        // Bundled resources are static; no update delivery/subscription service exists.
        return new ServerCapabilities(
            tools: true,
            resources: true,
            resourcesSubscribe: false,
            prompts: true,
            logging: true,
            completions: true
        );
    }
}
