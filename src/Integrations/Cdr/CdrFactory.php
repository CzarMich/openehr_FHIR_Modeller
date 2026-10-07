<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Cdr;

use OpenEHR\Assistant\Application\CdrWorkspace;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\Actor;

final class CdrFactory
{
    public static function workspace(Settings $settings, Actor $actor, NativeModels $models): CdrWorkspace
    {
        $http = new CdrHttp($settings);
        return new CdrWorkspace($settings, $actor, new OpenEhrRestAdapter($http, new ConfiguredCredentials()), new CdrConnection($http), $models);
    }
}
