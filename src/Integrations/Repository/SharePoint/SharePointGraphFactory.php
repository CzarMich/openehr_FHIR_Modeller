<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\SharePoint;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Auth\ClientCredentialsToken;
use OpenEHR\Assistant\Integrations\Auth\ConfiguredAccessToken;

final class SharePointGraphFactory
{
    public static function create(Settings $settings): GraphClient
    {
        $token = $settings->get('SHAREPOINT_ACCESS_TOKEN');
        if ($token !== '') {
            $tokens = new ConfiguredAccessToken($token);
        } else {
            $url = $settings->get('SHAREPOINT_TOKEN_URL');
            if ($url === '') {
                $tenant = $settings->get('SHAREPOINT_TENANT_ID');
                if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9.-]{0,249}$/D', $tenant)) { throw new \InvalidArgumentException('SHAREPOINT_TENANT_REQUIRED'); }
                $url = 'https://login.microsoftonline.com/' . $tenant . '/oauth2/v2.0/token';
            }
            $tokens = new ClientCredentialsToken($settings, $url, $settings->get('SHAREPOINT_CLIENT_ID'),
                $settings->get('SHAREPOINT_CLIENT_SECRET'), $settings->get('SHAREPOINT_TOKEN_SCOPE'));
        }
        return new GraphClient($settings, $tokens);
    }
}
