<?php

declare(strict_types=1);

require '/app/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Configuration\StorageConfiguration;
use OpenEHR\Assistant\Integrations\Governance\PostgresConnection;
use OpenEHR\Assistant\Integrations\Governance\PostgresAuditStore;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use OpenEHR\Assistant\Integrations\Governance\SqlitePostgresMigration;
use OpenEHR\Assistant\Integrations\Cache\ModelReadCache;
use OpenEHR\Assistant\Integrations\Repository\GitModelRepository;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
function rejects(callable $call, string $message): void
{
    try {
        $call();
    } catch (Throwable $error) {
        check(str_contains($error->getMessage(), $message), 'Unexpected error: ' . $error->getMessage());
        return;
    }
    throw new RuntimeException('Expected rejection: ' . $message);
}
$settings = Settings::fromEnvironment();
$connection = PostgresConnection::connect($settings);
$store = new PostgresAuditStore($connection);
$subject = hash('sha256', 'storage-fixture');
if (($argv[1] ?? '') === 'race') {
    try {
        $store->append('shared', hash('sha256', 'race'), 0, ['project' => 'fixture', 'new_state' => 'DRAFT']);
        exit(0);
    } catch (RuntimeException $error) {
        exit($error->getMessage() === 'GOVERNANCE_REVISION_CONFLICT' ? 2 : 3);
    }
}
if (($argv[1] ?? '') === 'outage') {
    $cache = new ModelReadCache($settings, 'outage');
    $started = microtime(true);
    check($cache->remember('revision', fn () => ['source' => true]) === ['source' => true], 'Outage fallback');
    check(microtime(true) - $started < 2, 'Bounded cache outage deadline');
    echo "PASS cache outage fallback\n";
    exit;
}
if (($argv[1] ?? '') === 'resume') {
    check(count($store->events('shared', $subject)) === 2, 'PostgreSQL restart durability');
    rejects(fn () => $store->consumeNonce(hash('sha256', 'restart-nonce'), time() + 90), 'GOVERNANCE_ASSERTION_REPLAYED');
    echo "PASS PostgreSQL restart and nonce durability\n";
    exit;
}
$owner = PostgresConnection::connect($settings->with(['GOVERNANCE_POSTGRES_USER' => 'modelling_owner', 'GOVERNANCE_POSTGRES_PASSWORD_FILE' => '/run/secrets/governance-owner-password']));
$corrupt = new SqliteAuditStore('/tmp/corrupt.sqlite');
$corrupt->append('shared', hash('sha256', 'corrupt'), 0, ['project' => 'fixture']);
(new PDO('sqlite:/tmp/corrupt.sqlite'))->exec("DROP TRIGGER immutable_governance_update; UPDATE governance_events SET event = '{}' ");
rejects(fn () => SqlitePostgresMigration::migrate('/tmp/corrupt.sqlite', $owner), 'GOVERNANCE_AUDIT_INTEGRITY_FAILED');
check((int) $owner->query('SELECT COUNT(*) FROM governance_events')->fetchColumn() === 0, 'Corrupt migration leaves destination empty');
$sqlite = new SqliteAuditStore('/tmp/migration.sqlite');
$first = $sqlite->append('shared', $subject, 0, ['project' => 'fixture', 'new_state' => 'DRAFT', 'comment' => 'Synthetic ünicode / bytes']);
$second = $sqlite->append('shared', $subject, 1, ['project' => 'fixture', 'new_state' => 'REVIEW_REQUESTED']);
$sqlite->consumeNonce(hash('sha256', 'restart-nonce'), time() + 90);
$migrationProcess = proc_open(
    [PHP_BINARY, '/app/scripts/governance-storage.php', 'cutover'],
    [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
    $migrationPipes,
    null,
    array_replace(getenv(), ['GOVERNANCE_DATABASE_PATH' => '/tmp/migration.sqlite',
        'GOVERNANCE_POSTGRES_USER' => 'modelling_owner', 'GOVERNANCE_POSTGRES_PASSWORD_FILE' => '/run/secrets/governance-owner-password'])
);
$migrationJson = stream_get_contents($migrationPipes[1]);
fclose($migrationPipes[1]);
$migrationError = stream_get_contents($migrationPipes[2]);
fclose($migrationPipes[2]);
check(proc_close($migrationProcess) === 0, 'Cutover CLI failed: ' . $migrationError);
$migration = json_decode($migrationJson, true, 16, JSON_THROW_ON_ERROR);
check((new SqliteAuditStore('/tmp/' . $migration['backup']))->events('shared', $subject) === [$first, $second], 'Consistent cutover backup');
check($migration['events'] === 2 && $store->events('shared', $subject) === [$first, $second], 'Lossless migration');
rejects(fn () => SqlitePostgresMigration::migrate('/tmp/migration.sqlite', $owner), 'MIGRATION_TARGET_MUST_BE_EMPTY');
check($store->subjects('shared', 'fixture')[0]['latest']['hash'] === $second['hash'], 'Indexed subject lookup');
check($store->events(hash('sha256', 'tenant-b'), $subject) === [], 'Tenant isolation');
foreach (['a' => 'MODEL_IMPORT_REQUESTED', 'b' => 'REGISTER', 'c' => 'MODEL_IMPORT_REQUESTED', 'd' => 'REGISTER'] as $id => $type) {
    $store->append('shared', str_repeat($id, 64), 0, ['type' => $type, 'project' => 'streamfilter']);
}
check($store->subjects('shared', 'streamfilter', 1, 0, 'REGISTER')[0]['subject'] === str_repeat('b', 64), 'Stream filter before pagination');
check($store->subjects('shared', 'streamfilter', 1, 1, 'REGISTER')[0]['subject'] === str_repeat('d', 64), 'Filtered second page');

rejects(fn () => $store->append('shared', $subject, 1, ['project' => 'fixture']), 'GOVERNANCE_REVISION_CONFLICT');
rejects(fn () => $store->append('shared', $subject, 2, ['project' => 'other']), 'GOVERNANCE_SUBJECT_IDENTITY_CONFLICT');
foreach (['UPDATE governance_events SET project=project', 'DELETE FROM governance_events', 'TRUNCATE governance_events', 'ALTER TABLE governance_events ADD COLUMN injected text'] as $sql) {
    rejects(fn () => $connection->exec($sql), 'SQLSTATE[42501]');
}
foreach (['UPDATE governance_events SET project=project', 'DELETE FROM governance_events', 'TRUNCATE governance_events'] as $sql) {
    rejects(fn () => $owner->exec($sql), 'GOVERNANCE_EVENTS_IMMUTABLE');
}
$processes = [];
for ($i = 0; $i < 4; $i++) {
    $processes[] = proc_open([PHP_BINARY, '/storage-probe.php', 'race'], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
}
$exits = array_map('proc_close', $processes);
sort($exits);
check($exits === [0, 2, 2, 2], 'Concurrent compare-and-append');
$nonce = hash('sha256', 'nonce');
$store->consumeNonce($nonce, time() + 60);
rejects(fn () => (new PostgresAuditStore(PostgresConnection::connect($settings)))->consumeNonce($nonce, time() + 60), 'GOVERNANCE_ASSERTION_REPLAYED');
$cache = new ModelReadCache($settings, 'tenant-a');
$loads = 0;
$load = function () use (&$loads): array {
    ++$loads;
    return ['source' => 'trusted'];
};
$cache->remember('revision', $load);
$cache->remember('revision', $load);
check($loads === 1, 'Cache hit');
(new ModelReadCache($settings, 'tenant-b'))->remember('revision', $load);
check($loads === 2, 'Cache tenant isolation');
$redis = new Redis();
$redis->connect('cache', 6379);
$redis->auth(StorageConfiguration::secret($settings->get('MODEL_CACHE_PASSWORD_FILE')));
$key = $settings->get('MODEL_CACHE_NAMESPACE') . ':' . hash('sha256', "tenant-a\0revision");
$redis->set($key, '{"payload":"{\"source\":\"forged\"}","expires":9999999999,"mac":"forged"}');
check($cache->remember('revision', $load) === ['source' => 'trusted'] && $loads === 3, 'Poisoned cache rejected');
$redis->expire($key, 0);
$cache->remember('revision', $load);
check($loads === 4, 'Evicted cache rebuilt');
$cache->remember('revision-b', $load);
check($loads === 5, 'Revision change invalidates cache');
$gitSettings = $settings->with(['MODEL_REPOSITORY_PATH' => '/tmp/cache-git', 'MODEL_GIT_REMOTE_URL' => '', 'MODEL_GIT_SSH_KEY_FILE' => '', 'MODEL_GIT_KNOWN_HOSTS_FILE' => '']);
$repository = new GitModelRepository($gitSettings);
$repository->createProject('fixture', 'Synthetic cache fixture', 'No clinical data');
$artifact = $repository->saveArtifact('fixture', 'templates/synthetic.oet', '<template>first</template>', [], null);
$repository->getArtifact('fixture', 'templates/synthetic.oet');
$uncached = new GitModelRepository($gitSettings->with(['MODEL_CACHE_DRIVER' => 'none']));
$iterations = 15;
$latencies = [];
foreach (['uncached' => $uncached, 'cached' => $repository] as $name => $repo) {
    $times = [];
    for ($i = 0; $i < $iterations; $i++) {
        $at = microtime(true);
        $repo->getArtifact('fixture', 'templates/synthetic.oet');
        $times[] = (microtime(true) - $at) * 1000;
    }
    sort($times);
    $latencies[$name] = ['median_ms' => round($times[7], 2), 'p95_ms' => round($times[14], 2)];
}
$next = $uncached->saveArtifact('fixture', 'templates/synthetic.oet', '<template>changed</template>', [], $artifact['revision']);
check($repository->getArtifact('fixture', 'templates/synthetic.oet')['revision'] === $next['revision'], 'External writer invalidation');
$uncached->deleteArtifact('fixture', 'templates/synthetic.oet', $next['revision']);
rejects(fn () => $repository->getArtifact('fixture', 'templates/synthetic.oet'), 'ARTIFACT_NOT_FOUND');
check($repository->getArtifact('fixture', 'templates/synthetic.oet', $artifact['revision'])['content'] === '<template>first</template>', 'Immutable historic revision');
echo json_encode(['status' => 'PASS', 'recorded_at' => gmdate(DATE_ATOM), 'migration' => $migration,
    'checks' => ['exact event migration', 'immutable rows and restricted application role', 'concurrent append conflict', 'tenant isolation', 'audit stream filtering before pagination', 'durable replay prevention', 'cache hit, poison, eviction and revision isolation', 'external Git write and deletion invalidation'],
    'synthetic_git_retrieval' => ['iterations' => $iterations, 'timings' => $latencies, 'scope' => 'Single small synthetic template in local Git; not a production throughput claim']], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
