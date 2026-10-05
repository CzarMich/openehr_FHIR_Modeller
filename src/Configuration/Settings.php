<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Configuration;

use InvalidArgumentException;

/** Deployment configuration, independent of modelling services. */
final class Settings
{
    public const array DEFAULTS = [
        'APP_ENV' => 'development', 'PRODUCT_NAME' => 'openEHR Modelling Assistant',
        'PRODUCT_SHORT_NAME' => 'openEHR Modelling Assistant', 'PRODUCT_VENDOR' => 'Michael Anywar',
        'PRODUCT_DESCRIPTION' => 'AI-assisted openEHR modelling and knowledge services',
        'PRODUCT_URL' => '', 'PRODUCT_SUPPORT_URL' => '', 'PRODUCT_DOCUMENTATION_URL' => '',
        'PRODUCT_LOGO_URL' => '', 'MCP_SERVER_NAME' => 'openehr-modelling-assistant',
        'MCP_TRANSPORT' => 'streamable-http', 'MCP_HOST' => '127.0.0.1', 'MCP_PORT' => '8343',
        'MCP_ALLOWED_HOSTS' => 'localhost,127.0.0.1,[::1]', 'CORS_ALLOWED_ORIGINS' => '',
        'AUTH_MODE' => 'none', 'AUTH_API_KEY' => '', 'AUTH_API_KEY_HEADER' => 'X-API-Key',
        'OIDC_ISSUER' => '', 'OIDC_AUDIENCE' => '', 'OIDC_JWKS_URI' => '',
        'OIDC_CLOCK_SKEW' => '60', 'OIDC_MAX_TOKEN_AGE' => '7200', 'OIDC_ALLOWED_CLIENT_IDS' => '',
        'OIDC_REQUIRED_SCOPES' => 'modelling.read', 'OIDC_ROLES_CLAIM' => 'roles', 'OIDC_REQUIRED_ROLES' => '',
        'OIDC_WRITE_ROLES' => 'modeller,administrator', 'OIDC_TENANT_CLAIM' => '', 'OIDC_ALLOWED_TENANTS' => '',
        'PROJECT_RBAC_ENABLED' => 'false',
        'OIDC_TENANT_GIT_REMOTES' => '{}',
        'GOVERNANCE_DATABASE_DRIVER' => 'sqlite', 'GOVERNANCE_POSTGRES_DSN' => '',
        'GOVERNANCE_POSTGRES_USER' => 'modelling_app', 'GOVERNANCE_POSTGRES_PASSWORD_FILE' => '',
        'MODEL_CACHE_DRIVER' => 'none', 'MODEL_CACHE_URL' => 'redis://cache:6379/0',
        'MODEL_CACHE_PASSWORD_FILE' => '', 'MODEL_CACHE_SIGNING_KEY_FILE' => '',
        'MODEL_CACHE_TTL' => '300', 'MODEL_CACHE_NAMESPACE' => 'openehr-models-v1',
        'GOVERNANCE_ENABLED' => 'false', 'GOVERNANCE_DATABASE_PATH' => '/data/governance/audit.sqlite',
        'GOVERNANCE_BROWSER_ORIGIN' => '', 'GOVERNANCE_OIDC_ISSUER' => '', 'GOVERNANCE_LOCAL_IDENTITY_ISSUER' => '', 'GOVERNANCE_BROWSER_KEYS' => '{}',
        'GOVERNANCE_SESSION_MAX_AGE' => '900', 'GOVERNANCE_BROWSER_SESSION_MAX_AGE' => '3600',
        'GOVERNANCE_ROLE_MAP' => '{"modeller":["modelling-modeller","modelling-administrator"],"reviewer":["modelling-reviewer","modelling-administrator"],"approver":["modelling-approver","modelling-administrator"],"publisher":["modelling-publisher","modelling-administrator"]}',
        'CKM_API_BASE_URL' => 'https://ckm.openehr.org/ckm/rest/', 'CKM_TIMEOUT' => '15',
        'CKM_SOURCES' => '{}', 'CKM_DEFAULT_SOURCE' => 'default', 'CKM_AUTH' => '{}', 'CKM_FEDERATION_TIMEOUT' => '30',
        'TERMINOLOGY_FHIR_BASE_URL' => '', 'TERMINOLOGY_BEARER_TOKEN' => '',
        'TERMINOLOGY_API_KEY' => '', 'TERMINOLOGY_API_KEY_HEADER' => 'X-API-Key',
        'TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER' => 'url',
        'HTTP_TIMEOUT' => '15', 'HTTP_SSL_VERIFY' => 'true', 'HTTP_CA_BUNDLE' => '',
        'OPENEHR_ENGINE_URL' => '', 'OPENEHR_ENGINE_KEY_FILE' => '', 'OPENEHR_ENGINE_TIMEOUT' => '50',
        'CDR_ENABLED' => 'false', 'CDR_DATA_DIR' => '/data/cdr', 'CDR_ENCRYPTION_KEY_FILE' => '',
        'CDR_CONNECTIONS_FILE' => '', 'CDR_ALLOWED_HOSTS' => '', 'CDR_ALLOW_HTTP' => 'false',
        'MAX_REQUEST_BYTES' => '2097152', 'MAX_UPSTREAM_BYTES' => '8388608',
        'LOG_LEVEL' => 'info', 'MODEL_REPOSITORY_PROVIDER' => 'filesystem',
        'MODEL_REPOSITORY_PATH' => '/tmp/openehr-models', 'MODEL_REPOSITORY_WRITE_ENABLED' => 'false',
        'MODEL_GIT_LAYOUT' => 'categories', 'MODEL_GIT_CONTENT_PATH' => '', 'MODEL_GIT_REMOTE_URL' => '', 'MODEL_GIT_BRANCH' => 'main', 'MODEL_GIT_SYNC_SECONDS' => '5',
        'MODEL_GIT_TIMEOUT' => '30', 'MODEL_GIT_AUTHOR_NAME' => 'openEHR Modelling Assistant',
        'MODEL_GIT_AUTHOR_EMAIL' => 'modelling-assistant@localhost',
        'SHAREPOINT_GRAPH_URL' => 'https://graph.microsoft.com/v1.0/',
        'SHAREPOINT_SITE_ID' => '', 'SHAREPOINT_LIST_ID' => '', 'SHAREPOINT_DRIVE_ID' => '', 'SHAREPOINT_FOLDER_ID' => '',
        'SHAREPOINT_ACCESS_TOKEN' => '', 'SHAREPOINT_TENANT_ID' => '', 'SHAREPOINT_CLIENT_ID' => '', 'SHAREPOINT_CLIENT_SECRET' => '',
        'SHAREPOINT_TOKEN_URL' => '', 'SHAREPOINT_TOKEN_SCOPE' => 'https://graph.microsoft.com/.default',
        'SHAREPOINT_DOWNLOAD_HOSTS' => '', 'SHAREPOINT_MAX_PROJECT_BYTES' => '8388608',
        'OIDC_TENANT_SHAREPOINT_REPOSITORIES' => '{}',
        'MODEL_HOSTED_API_URL' => '', 'MODEL_HOSTED_TOKEN' => '', 'MODEL_GIT_REVIEW_TARGET' => 'main',
        'MODEL_GIT_SSH_KEY_FILE' => '', 'MODEL_GIT_KNOWN_HOSTS_FILE' => '',
    ];

    /** @var array<string, string> */
    private array $values;

    /**
     * @param array<string, string> $overrides */
    public function __construct(array $overrides = [])
    {
        $this->values = array_replace(self::DEFAULTS, $overrides);
        EngineConfiguration::validate($this);
        foreach (['MCP_TRANSPORT' => ['stdio', 'streamable-http'], 'AUTH_MODE' => ['none', 'api_key', 'oidc'],
            'APP_ENV' => ['development', 'testing', 'production'],
            'GOVERNANCE_DATABASE_DRIVER' => ['sqlite', 'postgres'], 'MODEL_CACHE_DRIVER' => ['none', 'redis'],
            'MODEL_GIT_LAYOUT' => ['categories', 'flat'],
            'TERMINOLOGY_CODESYSTEM_VALIDATE_PARAMETER' => ['url', 'system'],
            'LOG_LEVEL' => ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'],
            'MODEL_REPOSITORY_PROVIDER' => ['filesystem', 'git', 'github', 'gitlab', 'sharepoint']] as $key => $allowed) {
            if (!in_array($this->get($key), $allowed, true)) {
                throw new InvalidArgumentException("Invalid configuration: $key.");
            }
        }
        foreach (['HTTP_TIMEOUT', 'CKM_TIMEOUT', 'MAX_REQUEST_BYTES', 'MAX_UPSTREAM_BYTES', 'MCP_PORT', 'MODEL_GIT_TIMEOUT', 'SHAREPOINT_MAX_PROJECT_BYTES'] as $key) {
            if (!ctype_digit($this->get($key)) || (int) $this->get($key) < 1) {
                throw new InvalidArgumentException("$key must be a positive integer.");
            }
        }
        if (!ctype_digit($this->get('MODEL_GIT_SYNC_SECONDS')) || (int) $this->get('MODEL_GIT_SYNC_SECONDS') > 300 || (int) $this->get('MODEL_GIT_TIMEOUT') > 120) {
            throw new InvalidArgumentException('Git sync must be 0..300 seconds and timeout 1..120 seconds.');
        }
        if (!ctype_digit($this->get('OIDC_CLOCK_SKEW')) || (int) $this->get('OIDC_CLOCK_SKEW') > 120
            || !ctype_digit($this->get('OIDC_MAX_TOKEN_AGE')) || (int) $this->get('OIDC_MAX_TOKEN_AGE') < 60 || (int) $this->get('OIDC_MAX_TOKEN_AGE') > 86400) {
            throw new InvalidArgumentException('Invalid OIDC clock or token age configuration.');
        }
        if ((int) $this->get('MCP_PORT') > 65535) {
            throw new InvalidArgumentException('MCP_PORT must be <= 65535.');
        }
        foreach (['HTTP_SSL_VERIFY', 'MODEL_REPOSITORY_WRITE_ENABLED', 'GOVERNANCE_ENABLED', 'PROJECT_RBAC_ENABLED', 'CDR_ENABLED', 'CDR_ALLOW_HTTP'] as $key) {
            if (!in_array($this->get($key), ['true', 'false'], true)) {
                throw new InvalidArgumentException("$key must be true or false.");
            }
        }
        if ($this->get('HTTP_SSL_VERIFY') !== 'true') {
            throw new InvalidArgumentException('TLS verification cannot be disabled. Configure HTTP_CA_BUNDLE.');
        }
        foreach (['CDR_DATA_DIR', 'CDR_ENCRYPTION_KEY_FILE', 'CDR_CONNECTIONS_FILE'] as $key) {
            if ($this->get($key) !== '' && (!str_starts_with($this->get($key), '/') || str_contains($this->get($key), "\0"))) {
                throw new InvalidArgumentException('Invalid CDR storage configuration.');
            }
        }
        if ($this->get('AUTH_MODE') === 'api_key' && strlen($this->get('AUTH_API_KEY')) < 32) {
            throw new InvalidArgumentException('AUTH_API_KEY must contain at least 32 characters.');
        }
        if ($this->get('PROJECT_RBAC_ENABLED') === 'true' && $this->get('AUTH_MODE') !== 'oidc') {
            throw new InvalidArgumentException('PROJECT_RBAC_ENABLED requires AUTH_MODE=oidc.');
        }
        if (!preg_match('/^[A-Za-z][A-Za-z0-9-]*$/D', $this->get('AUTH_API_KEY_HEADER')) || !preg_match('/^[A-Za-z][A-Za-z0-9-]*$/D', $this->get('TERMINOLOGY_API_KEY_HEADER'))) {
            throw new InvalidArgumentException('Invalid AUTH_API_KEY_HEADER.');
        }
        foreach (['SHAREPOINT_GRAPH_URL', 'SHAREPOINT_TOKEN_URL', 'MODEL_HOSTED_API_URL', 'CKM_API_BASE_URL', 'TERMINOLOGY_FHIR_BASE_URL', 'OIDC_ISSUER', 'OIDC_JWKS_URI',
            'GOVERNANCE_BROWSER_ORIGIN', 'GOVERNANCE_OIDC_ISSUER', 'GOVERNANCE_LOCAL_IDENTITY_ISSUER', 'PRODUCT_URL', 'PRODUCT_SUPPORT_URL', 'PRODUCT_DOCUMENTATION_URL', 'PRODUCT_LOGO_URL'] as $key) {
            if ($this->get($key) !== '') {
                self::validateUrl($this->get($key));
            }
        }
        if ($this->get('TERMINOLOGY_API_KEY') !== '' && $this->get('TERMINOLOGY_BEARER_TOKEN') !== '') {
            throw new InvalidArgumentException('Configure one terminology authentication method.');
        }
        if ($this->get('MODEL_REPOSITORY_PROVIDER') === 'sharepoint' && $this->get('SHAREPOINT_ACCESS_TOKEN') !== ''
            && ($this->get('SHAREPOINT_CLIENT_ID') !== '' || $this->get('SHAREPOINT_CLIENT_SECRET') !== '')) {
            throw new InvalidArgumentException('Configure one SharePoint authentication method.');
        }
        if (!ctype_digit($this->get('GOVERNANCE_SESSION_MAX_AGE')) || (int) $this->get('GOVERNANCE_SESSION_MAX_AGE') < 60 || (int) $this->get('GOVERNANCE_SESSION_MAX_AGE') > 3600) {
            throw new InvalidArgumentException('Governance session maximum age must be 60..3600 seconds.');
        }
        if (!ctype_digit($this->get('GOVERNANCE_BROWSER_SESSION_MAX_AGE')) || (int) $this->get('GOVERNANCE_BROWSER_SESSION_MAX_AGE') < (int) $this->get('GOVERNANCE_SESSION_MAX_AGE')
            || (int) $this->get('GOVERNANCE_BROWSER_SESSION_MAX_AGE') > 3600) {
            throw new InvalidArgumentException('Governance browsing session must cover the decision freshness period and cannot exceed 3600 seconds.');
        }
        StorageConfiguration::validate($this);
        $this->governanceRoleMap();
        if ($this->governanceBrowserKeys() !== [] && ($this->get('GOVERNANCE_BROWSER_ORIGIN') === ''
            || ($this->get('GOVERNANCE_OIDC_ISSUER') === '' && $this->get('GOVERNANCE_LOCAL_IDENTITY_ISSUER') === ''))) {
            throw new InvalidArgumentException('Governance browser keys require an explicit browser origin and identity issuer.');
        }
        $this->ckmSources();
        CkmAuthentication::profiles($this->get('CKM_AUTH'), $this->ckmSources());
        if ((int) $this->get('CKM_TIMEOUT') > 60) {
            throw new InvalidArgumentException('CKM_TIMEOUT must be 1..60 seconds.');
        }
        if (!ctype_digit($this->get('CKM_FEDERATION_TIMEOUT')) || (int) $this->get('CKM_FEDERATION_TIMEOUT') < 1 || (int) $this->get('CKM_FEDERATION_TIMEOUT') > 60) {
            throw new InvalidArgumentException('CKM_FEDERATION_TIMEOUT must be 1..60 seconds.');
        }
        $this->tenantGitRemotes();
        $this->tenantSharePointRepositories();
        if ($this->get('MCP_ALLOWED_HOSTS') === '' || str_contains($this->get('MCP_ALLOWED_HOSTS'), '*')) {
            throw new InvalidArgumentException('MCP_ALLOWED_HOSTS requires explicit hostnames.');
        }
        foreach ($this->csv('CORS_ALLOWED_ORIGINS') as $origin) {
            $localHttp = $this->get('APP_ENV') !== 'production'
                && preg_match('~^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$~D', $origin);
            // Local browser development is explicit; upstream URLs still require HTTPS.
            self::validateUrl($localHttp ? 'https' . substr($origin, 4) : $origin);
            if (rtrim($origin, '/') !== $origin || parse_url($origin, PHP_URL_PATH)) {
                throw new InvalidArgumentException('CORS_ALLOWED_ORIGINS must contain origins without paths.');
            }
        }
    }

    /** @return array<string, string> */
    public function governanceBrowserKeys(): array
    {
        $keys = json_decode($this->get('GOVERNANCE_BROWSER_KEYS'), true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($keys) || count($keys) > 3) {
            throw new InvalidArgumentException('INVALID_GOVERNANCE_BROWSER_KEYS');
        }
        foreach ($keys as $id => $key) {
            if (!is_string($id) || !preg_match('/^[A-Za-z][A-Za-z0-9_-]{0,63}$/D', $id) || !is_string($key) || !preg_match('/^[a-f0-9]{64,128}$/D', $key)) {
                throw new InvalidArgumentException('INVALID_GOVERNANCE_BROWSER_KEYS');
            }
        }
        return $keys;
    }

    /** @return array<string, list<string>> */
    public function governanceRoleMap(): array
    {
        $map = json_decode($this->get('GOVERNANCE_ROLE_MAP'), true, 8, JSON_THROW_ON_ERROR);
        if (!is_array($map) || array_diff(array_keys($map), ['modeller', 'reviewer', 'approver', 'publisher']) !== []) {
            throw new InvalidArgumentException('INVALID_GOVERNANCE_ROLE_MAP');
        }
        foreach ($map as $roles) {
            if (!is_array($roles) || !array_is_list($roles) || count($roles) > 20) {
                throw new InvalidArgumentException('INVALID_GOVERNANCE_ROLE_MAP');
            }
            foreach ($roles as $role) {
                if (!is_string($role) || $role === '' || strlen($role) > 200) {
                    throw new InvalidArgumentException('INVALID_GOVERNANCE_ROLE_MAP');
                }
            }
        }
        return $map;
    }

    public static function fromEnvironment(): self
    {
        $values = [];
        foreach (self::DEFAULTS as $key => $default) {
            $value = getenv($key);
            if ($value !== false) {
                $values[$key] = $value;
            }
        }
        // Legacy names remain accepted when the replacement is absent.
        if (!isset($values['CKM_TIMEOUT']) && isset($values['HTTP_TIMEOUT'])) {
            $values['CKM_TIMEOUT'] = (string) (int) ceil((float) $values['HTTP_TIMEOUT']);
        }
        if (isset($values['HTTP_TIMEOUT'])) {
            $values['HTTP_TIMEOUT'] = (string) (int) ceil((float) $values['HTTP_TIMEOUT']);
        }
        if (getenv('ALLOWED_HOSTS') !== false && !isset($values['MCP_ALLOWED_HOSTS'])) {
            $values['MCP_ALLOWED_HOSTS'] = (string) getenv('ALLOWED_HOSTS');
        }
        return new self($values);
    }

    /** @param array<string, string> $overrides */
    public function with(array $overrides): self
    {
        return new self(array_replace($this->values, $overrides));
    }

    public function get(string $key): string
    {
        return $this->values[$key] ?? throw new InvalidArgumentException('Unknown configuration key.');
    }

    /**
     * @return list<string> */
    public function csv(string $key): array
    {
        return array_values(array_filter(array_map('trim', explode(',', $this->get($key)))));
    }

    /** Each signed tenant namespace has a distinct remote, never a caller-supplied URL.
     * @return array<string, string> */
    public function tenantGitRemotes(): array
    {
        try {
            $remotes = json_decode($this->get('OIDC_TENANT_GIT_REMOTES'), true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new InvalidArgumentException('Invalid OIDC_TENANT_GIT_REMOTES JSON.');
        }
        if (!is_array($remotes) || ($remotes !== [] && array_is_list($remotes)) || count($remotes) > 1000) {
            throw new InvalidArgumentException('OIDC_TENANT_GIT_REMOTES must be an object.');
        }
        foreach ($remotes as $tenant => $remote) {
            if (!is_string($tenant) || !preg_match('/^[a-f0-9]{64}$/D', $tenant) || !is_string($remote)
                || $remote === '' || strlen($remote) > 2048 || preg_match('/[\x00-\x20\x7f]/', $remote)) {
                throw new InvalidArgumentException('Invalid tenant Git mapping.');
            }
        }
        $identities = array_map(static function (string $remote): string {
            $url = parse_url($remote);
            if (is_array($url) && isset($url['host'], $url['path'])) {
                // HTTPS and SSH forms of one hosted repository are the same tenant boundary.
                $host = strtolower($url['host']);
                $path = preg_replace('/\\.git$/D', '', rtrim($url['path'], '/')) ?? $url['path'];
                return $host . ':' . ($host === 'github.com' ? strtolower($path) : $path);
            }
            return realpath($remote) ?: rtrim($remote, '/');
        }, $remotes);
        if (count(array_unique($identities)) !== count($remotes)) {
            throw new InvalidArgumentException('Tenants require distinct Git remotes.');
        }
        return $remotes;
    }

    /** @return array<string, array{site_id:string, list_id:string, drive_id:string, folder_id:string}> */
    public function tenantSharePointRepositories(): array
    {
        try {
            $map = json_decode($this->get('OIDC_TENANT_SHAREPOINT_REPOSITORIES'), true, 8, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new InvalidArgumentException('Invalid OIDC_TENANT_SHAREPOINT_REPOSITORIES JSON.');
        }
        if (!is_array($map) || ($map !== [] && array_is_list($map)) || count($map) > 1000) {
            throw new InvalidArgumentException('Invalid SharePoint tenant map.');
        }
        $lists = [];
        $folders = [];
        foreach ($map as $tenant => $target) {
            if (!is_string($tenant) || !preg_match('/^[a-f0-9]{64}$/D', $tenant) || !is_array($target)
                || count($target) !== 4) {
                throw new InvalidArgumentException('Invalid SharePoint tenant mapping.');
            }
            foreach (['site_id', 'list_id', 'drive_id', 'folder_id'] as $field) {
                if (!is_string($target[$field] ?? null) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_.!,~-]{0,249}$/D', $target[$field])
                    || str_contains($target[$field], '..')) {
                    throw new InvalidArgumentException('Invalid SharePoint tenant target.');
                }
            }
            $list = strtolower($target['site_id'] . '/' . $target['list_id']);
            $folder = $target['drive_id'] . '/' . $target['folder_id'];
            if (isset($lists[$list]) || isset($folders[$folder])) {
                throw new InvalidArgumentException('Tenants require distinct SharePoint lists and folders.');
            }
            $lists[$list] = true;
            $folders[$folder] = true;
        }
        return $map;
    }

    /**
     * @return array<string, string> */
    public function ckmSources(): array
    {
        try {
            $sources = json_decode($this->get('CKM_SOURCES'), true, 16, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new InvalidArgumentException('CKM_SOURCES must be a JSON object of source names to base URLs.');
        }
        if (!is_array($sources) || ($sources !== [] && array_is_list($sources))) {
            throw new InvalidArgumentException('CKM_SOURCES must be an object.');
        }
        $sources = ['default' => $this->get('CKM_API_BASE_URL')] + $sources;
        if (count($sources) > 32) {
            throw new InvalidArgumentException('Configure at most 32 named CKM sources.');
        }
        foreach ($sources as $name => $url) {
            if (!is_string($name) || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/D', $name) || !is_string($url)) {
                throw new InvalidArgumentException('Invalid CKM source name or URL.');
            }
            self::validateUrl($url);
            $sources[$name] = rtrim($url, '/') . '/';
        }
        if (!isset($sources[$this->get('CKM_DEFAULT_SOURCE')])) {
            throw new InvalidArgumentException('CKM_DEFAULT_SOURCE is not configured.');
        }
        return $sources;
    }

    public static function validateUrl(string $url): void
    {
        $parts = parse_url($url);
        if ($parts === false || !isset($parts['host']) || ($parts['scheme'] ?? '') !== 'https'
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || preg_match('/[\x00-\x20\x7f]/', $url)) {
            throw new InvalidArgumentException('Configured URLs must use HTTPS without credentials, query or fragment.');
        }
    }
}
