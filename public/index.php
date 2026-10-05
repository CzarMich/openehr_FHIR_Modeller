<?php

declare(strict_types=1);


use OpenEHR\Assistant\Apis\CkmClient;
use OpenEHR\Assistant\Apis\CkmArchetypeSource;
use OpenEHR\Assistant\Auth\HttpGuard;
use OpenEHR\Assistant\Auth\OidcAuthenticator;
use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Modelling\ArchetypeSource;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Terminology\TerminologyProvider;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;
use OpenEHR\Assistant\Integrations\Terminology\FhirTerminologyProvider;
use OpenEHR\Assistant\Tools\CkmService;
use Monolog\Formatter\JsonFormatter;
use Monolog\LogRecord;
use OpenEHR\Assistant\Helpers\CliOptions;
use OpenEHR\Assistant\Resources\Examples;
use OpenEHR\Assistant\Resources\Guides;
use OpenEHR\Assistant\Resources\Terminologies;
use Mcp\Capability\Registry\Container;
use Mcp\Schema\Enum\ProtocolVersion;
use Mcp\Schema\Icon;
use Mcp\Schema\Implementation;
use OpenEHR\Assistant\Mcp\ProtocolProfile;
use Mcp\Server;
use Mcp\Server\Session\FileSessionStore;
use Mcp\Server\Transport\Http\Middleware\CorsMiddleware;
use Mcp\Server\Transport\Http\Middleware\DnsRebindingProtectionMiddleware;
use Mcp\Server\Transport\Http\Middleware\ProtocolVersionMiddleware;
use OpenEHR\Assistant\Mcp\StdioTransport;
use OpenEHR\Assistant\Mcp\StreamableHttpTransport;
use Monolog\Handler\StreamHandler;
use Monolog\Level as LogLevel;
use Monolog\Logger;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7\Response;
use Nyholm\Psr7Server\ServerRequestCreator;
use Psr\Log\LoggerInterface;
use Symfony\Component\Cache\Adapter\PhpFilesAdapter;
use Symfony\Component\Cache\Psr16Cache;


$requestId = bin2hex(random_bytes(16));
$started = microtime(true);
try {
    require_once dirname(__DIR__) . '/vendor/autoload.php';
    $settings = Settings::fromEnvironment();
    // CLI option parsing (supports: --transport=stdio | --transport stdio)
    $transportOption = CliOptions::transportOption() ?: $settings->get('MCP_TRANSPORT');
    if ($transportOption !== 'stdio' && APP_ENV === 'production' && $settings->get('AUTH_MODE') === 'none') {
        throw new InvalidArgumentException('Production HTTP requires authentication.');
    }
    if ($transportOption === 'stdio' && $settings->get('AUTH_MODE') === 'oidc') {
        throw new InvalidArgumentException('OIDC_REQUIRES_HTTP: use local authentication for a trusted stdio process.');
    }
    $oidc = $settings->get('AUTH_MODE') === 'oidc' ? new OidcAuthenticator($settings) : null;
    $identity = null;
    $request = null;
    $principal = 'local-stdio';
    $psr17Factory = new Psr17Factory();
    if ($transportOption !== 'stdio') {
        // Nyholm seeds Host from the URI, then appends the same SAPI header.
        // Use the raw SAPI Host once; comma-separated/malformed hosts still fail HttpGuard.
        $request = (new ServerRequestCreator($psr17Factory, $psr17Factory, $psr17Factory, $psr17Factory))->fromGlobals()
            ->withHeader('Host', (string) ($_SERVER['HTTP_HOST'] ?? ''));
        $path = $request->getUri()->getPath();
        $modelApiPath = str_starts_with($path, '/api/v1/projects') || in_array($path, ['/api/v1/artifacts', '/api/v1/artifact-history'], true);
        if (!in_array($path, ['/mcp', '/health', '/ready'], true) && !str_starts_with($path, '/api/v1/reviews') && !str_starts_with($path, '/api/v1/cdr/') && !$modelApiPath) {
            http_response_code(404);
            exit;
        }
        if ($path === '/health' && $request->getMethod() === 'GET') {
            header('Content-Type: application/json');
            echo '{"status":"alive"}';
            exit;
        }
        if (str_starts_with($path, '/api/v1/reviews')) {
            $audit = new \OpenEHR\Assistant\Integrations\Governance\ConfiguredAuditStore($settings);
            $validator = new \OpenEHR\Assistant\Integrations\Governance\PreflightValidation(new \OpenEHR\Assistant\Domain\Modelling\QualityPipeline(new \OpenEHR\Assistant\Validation\ModelValidator()));
            $response = (new \OpenEHR\Assistant\Rest\ReviewApi($settings, $audit, $validator))->handle($request);
            http_response_code($response->getStatusCode());
            foreach ($response->getHeaders() as $name => $values) { foreach ($values as $value) { header($name . ': ' . $value, false); } }
            echo $response->getBody();
            exit;
        }
        if (str_starts_with($path, '/api/v1/cdr/')) {
            $audit = new \OpenEHR\Assistant\Integrations\Governance\ConfiguredAuditStore($settings);
            $models = new \OpenEHR\Assistant\Application\NativeModels(new \OpenEHR\Assistant\Integrations\Engine\HttpOpenEhrEngine($settings));
            $response = (new \OpenEHR\Assistant\Rest\CdrApi($settings, $audit, $models))->handle($request);
            http_response_code($response->getStatusCode());
            foreach ($response->getHeaders() as $name => $values) { foreach ($values as $value) { header($name . ': ' . $value, false); } }
            echo $response->getBody();
            exit;
        }
        if ($path !== '/ready') {
            $guard = new HttpGuard($settings, $oidc);
            if (($rejection = $guard->check($request)) !== null) {
                http_response_code($rejection->getStatusCode());
                foreach ($rejection->getHeaders() as $name => $values) {
                    foreach ($values as $value) {
                        header($name . ': ' . $value, false);
                    }
                }
                echo $rejection->getBody();
                exit;
            }
            $principal = $guard->principal($request) ?? throw new RuntimeException('AUTHENTICATION_REQUIRED');
            $identity = $oidc?->identity($request);
        }
        if ($modelApiPath) {
            $response = (new \OpenEHR\Assistant\Rest\ModelApi($settings, RepositoryFactory::create($settings, $identity), new AccessPolicy($settings, $identity)))->handle($request);
            http_response_code($response->getStatusCode());
            foreach ($response->getHeaders() as $name => $values) { foreach ($values as $value) { header($name . ': ' . $value, false); } }
            echo $response->getBody();
            exit;
        }
    }

    // Initialize the DI container
    $container = new Container();

    // Initialize logger
    $logger = new Logger(APP_NAME);
    $handler = new StreamHandler('php://stderr', LogLevel::fromName(LOG_LEVEL));
    $handler->setFormatter(new JsonFormatter());
    $logger->pushHandler($handler);
    $logger->pushProcessor(static function (LogRecord $record) use ($requestId): LogRecord {
        $safe = array_intersect_key($record->context, array_flip(['version', 'status', 'code', 'duration_ms', 'method', 'tool', 'dependency', 'validation_status']));
        $safe['request_id'] = $requestId;
        return $record->with(context: $safe);
    });
    $logger->info('Starting ...', [
        'version' => APP_VERSION,
        'env' => APP_ENV,
        'log' => LOG_LEVEL,
    ]);
    $container->set(LoggerInterface::class, $logger);

    // Initialize API clients, resources, etc.
    $container->set(Settings::class, $settings);
    $container->set(\OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine::class, new \OpenEHR\Assistant\Integrations\Engine\HttpOpenEhrEngine($settings));
    $access = new AccessPolicy($settings, $identity);
    $container->set(AccessPolicy::class, $access);
    $governanceRoles = [];
    try { $access->assertModelWrite(); $governanceRoles = ['modeller']; } catch (RuntimeException) { /* Read-only callers cannot prepare or promote models. */ }
    $container->set(\OpenEHR\Assistant\Domain\Governance\Actor::class, new \OpenEHR\Assistant\Domain\Governance\Actor(
        $identity->id ?? $principal, $identity->tenant ?? 'shared', $governanceRoles));
    $nativeModels = new \OpenEHR\Assistant\Application\NativeModels(new \OpenEHR\Assistant\Integrations\Engine\HttpOpenEhrEngine($settings));
    $container->set(\OpenEHR\Assistant\Application\CdrWorkspace::class, \OpenEHR\Assistant\Integrations\Cdr\CdrFactory::workspace(
        $settings, new \OpenEHR\Assistant\Domain\Governance\Actor($identity->id ?? $principal, $identity->tenant ?? 'shared', $governanceRoles), $nativeModels));
    $container->set(\OpenEHR\Assistant\Domain\Governance\AuditStore::class, new \OpenEHR\Assistant\Integrations\Governance\ConfiguredAuditStore($settings));
    $container->set(\OpenEHR\Assistant\Domain\Governance\ValidationProvider::class,
        new \OpenEHR\Assistant\Integrations\Governance\PreflightValidation(new \OpenEHR\Assistant\Domain\Modelling\QualityPipeline(new \OpenEHR\Assistant\Validation\ModelValidator())));
    $container->set(\OpenEHR\Assistant\Domain\Traceability\AnchorInspector::class, new \OpenEHR\Assistant\Integrations\Traceability\ModelAnchorInspector());
    $ckmClient = new CkmClient($logger, settings: $settings);
    $container->set(CkmClient::class, $ckmClient);
    $container->set(\OpenEHR\Assistant\Domain\Knowledge\CkmSearchProvider::class, new \OpenEHR\Assistant\Integrations\Knowledge\ConfiguredCkmSearch($ckmClient, $logger));
    $container->set(ArchetypeSource::class, new CkmArchetypeSource(new CkmService($ckmClient, $logger), $ckmClient));
    $container->set(ModelRepository::class, RepositoryFactory::create($settings, $identity));
    $terminology = new FhirTerminologyProvider($settings);
    $container->set(FhirTerminologyProvider::class, $terminology);
    $container->set(TerminologyProvider::class, $terminology);
    $container->set(\OpenEHR\Assistant\Domain\Terminology\ModelTerminologyInspector::class, new \OpenEHR\Assistant\Integrations\Terminology\XmlTerminologyInspector());
    $container->set(\OpenEHR\Assistant\Domain\Terminology\MappingProvider::class, $terminology);
    $container->set(Guides::class, new Guides());
    $container->set(Terminologies::class, new Terminologies());

    // Initialize cache (ensure directory exists)
    $cacheDir = APP_DATA_DIR . '/cache';
    if (!is_dir($cacheDir)) {
        mkdir($cacheDir, 0775, true);
    }
    // Namespace by APP_VERSION and explicit schema epoch so capability additions
    // also invalidate persisted discovery between unreleased deployments. A version bump (which may change discovery schema,
    // attribute signatures, or tool/prompt/resource sets) invalidates stale caches
    // rather than silently serving a mismatched, previously-cached capability set.
    // The namespace becomes a subdirectory under $cacheDir and old ones are never pruned
    // (no TTL), so releases accumulate directories there — see docs/development.md.
    $cache = new Psr16Cache(new PhpFilesAdapter('mcp-server-' . APP_VERSION . '-model-capabilities-4', 0, $cacheDir));

    // Load server instructions. Optional at the protocol level, but this server
    // ships a canonical resources/server-instructions.md — a missing/unreadable
    // file is a packaging error, so warn rather than silently advertise none.
    $instructionsPath = APP_DIR . '/resources/server-instructions.md';
    $instructions = is_readable($instructionsPath) ? file_get_contents($instructionsPath) : false;
    if ($instructions === false) {
        $logger->warning('Server instructions unavailable; starting without them.', ['path' => $instructionsPath]);
        $instructions = null;
    }

    // Build the server
    $builder = Server::builder()
        ->setServerInfo(APP_NAME, APP_VERSION, APP_DESCRIPTION, APP_ICON === '' ? null : [new Icon(APP_ICON)], $settings->get('PRODUCT_URL') ?: null)
        ->setCapabilities(ProtocolProfile::capabilities())
        // Keep the catalogue in one page for clients that stop after the first tools/list.
        ->setPaginationLimit(100)
        ->addRequestHandler(new \OpenEHR\Assistant\Mcp\InitializeHandler(
            new Implementation(APP_NAME, APP_VERSION, APP_DESCRIPTION, APP_ICON === '' ? null : [new Icon(APP_ICON)], $settings->get('PRODUCT_URL') ?: null),
            APP_TITLE . "\n" . $instructions))
        ->setDiscovery(APP_DIR, ['src/Prompts', 'src/Tools', 'src/Resources'], cache: $cache)
        // mcp/sdk 0.7.0 makes element loading lazy by default. Force eager
        // loading so a broken capability fails at build() (on every request
        // under php-fpm, and at startup under stdio) rather than on first use —
        // and so the advertised capability set always matches what the registry
        // can actually load (lazy mode can advertise tools it then fails to list).
        ->setLazyLoading(false)
        ->setSession(new FileSessionStore(APP_DATA_DIR . '/sessions/' . hash('sha256', $principal), ttl: 10 * 60))
        ->setProtocolVersion(ProtocolVersion::V2025_11_25)
        ->setContainer($container)
        ->setInstructions(APP_TITLE . "\n" . $instructions)
        ->setLogger($logger);
    // add resources
    Guides::addResources($builder, $logger);
    Examples::addResources($builder, $logger);

    $server = $builder->build();

    // Determine transport: default to streamable-http; allow CLI override to stdio
    if ($transportOption === 'stdio') {
        // Run using stdio transport (blocking loop)
        $logger->info('Using stdio transport as requested by --transport=stdio');
        $transport = new StdioTransport();
        $status = $server->run($transport);
        $logger->info('Server listener stopped gracefully (stdio).', ['status' => $status]);
        exit($status);
    }

    if ($request === null) {
        throw new RuntimeException('HTTP request unavailable.');
    }
    if ($request->getUri()->getPath() === '/ready') {
        (new Terminologies())->readAll();
        header('Content-Type: application/json');
        echo '{"status":"ready","external_dependencies":"not_probed"}';
        exit;
    }

    // Create the Streamable HTTP transport. SDK >= 0.6 enables CORS, DNS-rebinding,
    // and protocol-version middleware by default; we keep those but configure the
    // DNS-rebinding allow-list from MCP_ALLOWED_HOSTS (the server runs behind a reverse proxy).
    $allowedHosts = array_values(array_filter(array_map('trim', explode(',', MCP_ALLOWED_HOSTS))));

    $transport = new StreamableHttpTransport(
        $request,
        $psr17Factory,
        $psr17Factory,
        $logger,
        [
            new CorsMiddleware(allowedOrigins: $settings->csv('CORS_ALLOWED_ORIGINS'), allowedHeaders: ['Accept', 'Content-Type', 'Authorization', $settings->get('AUTH_API_KEY_HEADER'), 'Mcp-Session-Id', 'MCP-Protocol-Version']),
            new DnsRebindingProtectionMiddleware(array_values(array_unique(array_merge($allowedHosts, array_map(static fn (string $origin): string => (string) parse_url($origin, PHP_URL_HOST), $settings->csv('CORS_ALLOWED_ORIGINS')))))),
            new ProtocolVersionMiddleware(ProtocolProfile::versions()),
        ],
        maxBodyBytes: (int) $settings->get('MAX_REQUEST_BYTES')
    );

    // Run the server and get the response
    /** @var Response $response */
    $response = $server->run($transport);
    $response = $response->withHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')->withHeader('X-Request-ID', $requestId);
    // Emit the response
    http_response_code($response->getStatusCode());
    foreach ($response->getHeaders() as $name => $values) {
        foreach ($values as $value) {
            header(sprintf('%s: %s', $name, $value), false);
        }
    }
    $content = $response->getBody()->getContents();
    $envelope = json_decode((string) $request->getBody(), true);
    $audit = ['status' => $response->getStatusCode(), 'duration_ms' => round(1000 * (microtime(true) - $started), 2)];
    if (is_array($envelope)) {
        foreach (['method' => $envelope['method'] ?? null, 'tool' => $envelope['params']['name'] ?? null] as $key => $value) {
            if (is_string($value) && preg_match('~^[A-Za-z0-9_/.-]{1,100}$~D', $value)) {
                $audit[$key] = $value;
            }
        }
    }
    $logger->info('MCP request completed', $audit);
    echo $content;

    // finalize
    $logger->info('Server listener stopped gracefully (HTTP).');
    exit(0);

} catch (\Throwable $e) {
    $reason = $e instanceof InvalidArgumentException ? $e->getMessage() : 'Service initialization failed: ' . $e::class;
    error_log(json_encode(['level' => 'error', 'event' => 'service_failure', 'request_id' => $requestId, 'reason' => $reason], JSON_THROW_ON_ERROR));
    if (PHP_SAPI !== 'cli') {
        http_response_code(503);
        header('Content-Type: application/json');
        echo json_encode(['error' => ['code' => 'SERVICE_UNAVAILABLE'], 'request_id' => $requestId]);
    }
    exit(1);
}
