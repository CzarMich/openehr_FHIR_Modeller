<?php

declare(strict_types=1);

use OpenEHR\Assistant\Configuration\Settings;

$settings = Settings::fromEnvironment();
define('APP_NAME', $settings->get('MCP_SERVER_NAME'));
define('APP_TITLE', $settings->get('PRODUCT_NAME'));
define('APP_DESCRIPTION', $settings->get('PRODUCT_DESCRIPTION'));
define('APP_ICON', $settings->get('PRODUCT_LOGO_URL'));
define('APP_VERSION', '0.21.0');
define('APP_ENV', $settings->get('APP_ENV'));
define('LOG_LEVEL', $settings->get('LOG_LEVEL'));
define('APP_DIR', dirname(__DIR__));
define('APP_RESOURCES_DIR', APP_DIR . '/resources');
define('APP_DATA_DIR', (getenv('XDG_DATA_HOME') ?: '/tmp') . '/openehr-modelling-assistant');
define('CKM_API_BASE_URL', rtrim($settings->get('CKM_API_BASE_URL'), '/') . '/');
define('HTTP_SSL_VERIFY', true);
define('HTTP_TIMEOUT', (float) $settings->get('HTTP_TIMEOUT'));
define('MCP_ALLOWED_HOSTS', $settings->get('MCP_ALLOWED_HOSTS'));
