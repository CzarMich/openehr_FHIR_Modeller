<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Cdr\CdrAdapter;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Integrations\Cdr\CdrConnection;
use OpenEHR\Assistant\Integrations\Cdr\CdrErrors;
use OpenEHR\Assistant\Integrations\Cdr\EncryptedCdrStore;

/** Actor-scoped connection configuration and read-only query orchestration. Never persists result rows. */
final class CdrWorkspace
{
    private ?EncryptedCdrStore $storage = null;

    public function __construct(private readonly Settings $settings, private readonly Actor $actor,
        private readonly CdrAdapter $adapter, private readonly CdrConnection $schema, private readonly NativeModels $models) {}

    private function store(): EncryptedCdrStore
    {
        if ($this->settings->get('CDR_ENABLED') !== 'true') { throw new \RuntimeException('CDR_NOT_CONFIGURED'); }
        return $this->storage ??= new EncryptedCdrStore($this->settings, $this->actor);
    }

    /**
     * @return array<string, mixed> */
    public function connections(): array
    {
        return ['items' => array_map(CdrConnection::summary(...), array_values($this->catalogue()))];
    }

    /**
     * @return array<string, array<string, mixed>> */
    private function catalogue(): array
    {
        $items = $this->store()->read()['connections'];
        $file = $this->settings->get('CDR_CONNECTIONS_FILE');
        if ($file !== '') {
            try { $configured = json_decode((string) file_get_contents($file), true, 32, JSON_THROW_ON_ERROR); }
            catch (\Throwable) { throw new \RuntimeException('CDR_ADMIN_CONFIGURATION_INVALID'); }
            if (!is_array($configured) || !is_array($configured['connections'] ?? null) || count($configured['connections']) > 100) { throw new \RuntimeException('CDR_ADMIN_CONFIGURATION_INVALID'); }
            foreach ($configured['connections'] as $entry) {
                if (!is_array($entry) || !is_array($entry['allowedActors'] ?? null) || !in_array($this->actor->id, $entry['allowedActors'], true)) { continue; }
                if (!is_array($entry['connection'] ?? null)) { throw new \RuntimeException('CDR_ADMIN_CONFIGURATION_INVALID'); }
                $connection = $this->schema->validate($entry['connection'], [], true);
                $connection['source'] = 'administrator';
                if (isset($items[$connection['id']])) { throw new \RuntimeException('CDR_CONNECTION_ID_CONFLICT'); }
                $items[$connection['id']] = $connection;
            }
        }
        return $items;
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed> */
    public function saveConnection(array $input): array
    {
        if (!$this->actor->human) { throw new \DomainException('CDR_INTERACTIVE_SETTINGS_REQUIRED'); }
        $id = $input['id'] ?? null;
        if ($id !== null && (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/D', $id))) { throw new \InvalidArgumentException('CDR_INVALID_CONNECTION'); }
        $saved = [];
        $this->store()->update(function (array $state) use ($input, $id, &$saved): array {
            if ($id !== null && !isset($state['connections'][$id])) { throw new \RuntimeException('CDR_CONNECTION_NOT_FOUND'); }
            if ($id === null && count($state['connections']) >= 20) { throw new \RuntimeException('CDR_CONNECTION_LIMIT'); }
            $saved = $this->schema->validate($input, $id === null ? [] : $state['connections'][$id]);
            $state['connections'][$saved['id']] = $saved;
            return $state;
        });
        return CdrConnection::summary($saved);
    }

    /**
     * @return array<string, mixed> */
    public function deleteConnection(string $id): array
    {
        if (!$this->actor->human) { throw new \DomainException('CDR_INTERACTIVE_SETTINGS_REQUIRED'); }
        $this->store()->update(static function (array $state) use ($id): array {
            if (!isset($state['connections'][$id])) { throw new \RuntimeException('CDR_CONNECTION_NOT_FOUND'); }
            unset($state['connections'][$id]); return $state;
        });
        return ['deleted' => true];
    }

    /**
     * @return array<string, mixed> */
    private function connection(string $id): array
    {
        $connection = $this->catalogue()[$id] ?? null;
        if ($connection === null) { throw new \RuntimeException('CDR_CONNECTION_NOT_FOUND'); }
        if (!$connection['enabled']) { throw new \RuntimeException('CDR_CONNECTION_DISABLED'); }
        return $connection;
    }

    /**
     * @return array<string, mixed> */
    public function test(string $id): array { return $this->adapter->test($this->connection($id)); }

    /**
     * @return array<string, mixed> */
    public function capabilities(string $id): array
    {
        $this->connection($id);
        return ['connection_id' => $id, 'adapter' => 'openehr_rest', 'query' => 'POST Query API with parameters, fetch and offset',
            'templates' => 'Definition API ADL 1.4 (availability is checked on request)', 'read_only' => true,
            'max_rows' => 1000, 'max_response_bytes' => 8388608, 'max_timeout_seconds' => 120,
            'cancellation' => 'Stops this client request; remote server cancellation depends on the CDR.', 'results_sent_to_ai' => false];
    }

    /**
     * @return array<string, mixed> */
    public function templates(string $id, ?string $identifier = null): array { return $this->adapter->templates($this->connection($id), $identifier); }

    /**
     * @param array<mixed> $parameters
     * @return array<string, mixed> */
    public function execute(string $id, string $query, array $parameters = [], int $fetch = 100, int $offset = 0, ?string $job = null, bool $includeResults = false): array
    {
        if ($includeResults && !$this->actor->human) { throw new \DomainException('CDR_INTERACTIVE_RESULTS_REQUIRED'); }
        if (strlen($query) > 65536 || $fetch < 1 || $fetch > 1000 || $offset < 0 || $offset > 1000000 || count($parameters) > 100) { throw new \InvalidArgumentException('CDR_INVALID_QUERY'); }
        foreach ($parameters as $key => $value) {
            if (!is_string($key) || !preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,99}$/D', $key) || (!is_scalar($value) && $value !== null)
                || (is_string($value) && strlen($value) > 8192)) { throw new \InvalidArgumentException('CDR_INVALID_PARAMETERS'); }
        }
        $connection = $this->connection($id);
        $validation = $this->models->validate($query, 'aql');
        if (($validation['valid'] ?? false) !== true || !is_array($validation['ast'] ?? null) || !isset($validation['ast']['select'])) { throw new \InvalidArgumentException('CDR_AQL_INVALID'); }
        $ast = $validation['ast'];
        $limit = $ast['limit'] ?? null;
        $aqlOffset = $ast['offset'] ?? null;
        if ($aqlOffset !== null && $limit === null) { throw new \InvalidArgumentException('CDR_QUERY_LIMIT_REQUIRED'); }
        if (($limit !== null && (!is_int($limit) || $limit < 1 || $limit > 1000)) || ($aqlOffset !== null && (!is_int($aqlOffset) || $aqlOffset < 0 || $aqlOffset > 1000000))) { throw new \InvalidArgumentException('CDR_QUERY_LIMIT_REQUIRED'); }
        if ($limit !== null && $offset !== 0) { throw new \InvalidArgumentException('CDR_PAGINATION_CONFLICT'); }
        $job ??= bin2hex(random_bytes(16));
        $path = $this->store()->jobPath($job);
        $reservation = fopen($path, 'x');
        if ($reservation === false) { throw new \RuntimeException('CDR_JOB_ALREADY_USED'); }
        fclose($reservation); chmod($path, 0600);
        $ownerLock = fopen($this->store()->jobPath(str_repeat('0', 32)) . '.running', 'c');
        if ($ownerLock === false || !flock($ownerLock, LOCK_EX | LOCK_NB)) { if (is_resource($ownerLock)) { fclose($ownerLock); } throw new \RuntimeException('CDR_QUERY_ALREADY_RUNNING'); }
        $cancelled = static function () use ($path): bool { clearstatcache(true, $path . '.cancel'); return is_file($path . '.cancel') || connection_aborted() !== 0; };
        $started = microtime(true); $count = null; $status = 'FAILED'; $code = null;
        try {
            if ($cancelled()) { throw new \RuntimeException('CDR_CANCELLED'); }
            $result = $this->adapter->execute($connection, $query, $parameters, $limit === null ? $fetch : null, $limit === null ? $offset : null, $cancelled);
            if ($cancelled()) { throw new \RuntimeException('CDR_CANCELLED'); }
            $count = $result['count']; $status = 'SUCCEEDED';
            $metadata = ['job_id' => $job, 'connection_id' => $id, 'duration_ms' => (int) round((microtime(true) - $started) * 1000), 'count' => $count,
                'fetch' => $limit ?? $fetch, 'offset' => $aqlOffset ?? $offset, 'has_more' => $limit === null && $count === $fetch,
                'results_persisted' => false, 'results_sent_to_ai' => false];
            return $includeResults ? array_merge($result, $metadata) : $metadata + ['message' => 'Execution metadata only. Result rows are available exclusively through an explicit Run in the browser workspace.'];
        } catch (\Throwable $error) {
            $code = CdrErrors::safe($error->getMessage());
            $status = $code === 'CDR_CANCELLED' ? 'CANCELLED' : 'FAILED';
            throw new \RuntimeException($code);
        } finally {
            flock($ownerLock, LOCK_UN); fclose($ownerLock);
            $entry = ['id' => $job, 'connection_id' => $id, 'query' => $query, 'parameter_names' => array_keys($parameters), 'at' => gmdate('c'),
                'duration_ms' => (int) round((microtime(true) - $started) * 1000), 'count' => $count, 'status' => $status, 'error_code' => $code];
            $this->store()->update(static function (array $state) use ($entry): array { array_unshift($state['history'], $entry); $state['history'] = array_slice($state['history'], 0, 100); return $state; });
            foreach (glob(dirname($path) . '/' . substr(basename($path), 0, 69) . '*') ?: [] as $old) {
                if (is_file($old) && filemtime($old) < time() - 600 && !str_ends_with($old, '.running')) { unlink($old); }
            }
        }
    }

    /**
     * @return array<string, mixed> */
    public function cancel(string $job): array
    {
        $path = $this->store()->jobPath($job) . '.cancel';
        $markers = glob(dirname($path) . '/' . substr(basename($path), 0, 69) . '*.cancel') ?: [];
        foreach ($markers as $marker) { if (is_file($marker) && filemtime($marker) < time() - 600) { unlink($marker); } }
        if (!is_file($path) && count(glob(dirname($path) . '/' . substr(basename($path), 0, 69) . '*.cancel') ?: []) >= 100) {
            throw new \RuntimeException('CDR_CANCELLATION_LIMIT');
        }
        if (file_put_contents($path, 'cancel', LOCK_EX) === false) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
        chmod($path, 0600);
        return ['cancel_requested' => true, 'job_id' => $job];
    }

    /**
     * @return array<string, mixed> */
    public function history(?string $connectionId = null): array
    {
        return ['items' => array_values(array_filter($this->store()->read()['history'],
            static fn (array $item): bool => $connectionId === null || ($item['connection_id'] ?? '') === $connectionId))];
    }

    /**
     * @return array<string, mixed> */
    public function clearHistory(?string $connectionId = null): array
    {
        $this->store()->update(static function (array $state) use ($connectionId): array {
            $state['history'] = $connectionId === null ? [] : array_values(array_filter($state['history'],
                static fn (array $item): bool => ($item['connection_id'] ?? '') !== $connectionId));
            return $state;
        });
        return ['deleted' => true];
    }

    /**
     * @return array<string, mixed> */
    public function saved(?string $id = null, ?string $connectionId = null): array
    {
        $items = $this->store()->read()['saved'];
        if ($connectionId !== null) {
            $items = array_filter($items, static fn (array $item): bool => ($item['connection_id'] ?? '') === $connectionId);
        }
        if ($id === null) { return ['items' => array_values($items)]; }
        return $items[$id] ?? throw new \RuntimeException('CDR_SAVED_QUERY_NOT_FOUND');
    }

    /**
     * @return array<string, mixed> */
    public function saveQuery(string $name, string $query, ?string $id = null, ?string $connectionId = null): array
    {
        if (trim($name) === '' || strlen($name) > 100 || strlen($query) > 65536 || trim($query) === ''
            || ($id !== null && !preg_match('/^[a-f0-9]{32}$/D', $id))) { throw new \InvalidArgumentException('CDR_INVALID_SAVED_QUERY'); }
        if ($connectionId !== null && $connectionId !== '') { $this->connection($connectionId); }
        $item = ['id' => $id ?? bin2hex(random_bytes(16)), 'name' => trim($name), 'query' => $query, 'updated_at' => gmdate('c')];
        $this->store()->update(static function (array $state) use (&$item, $id, $connectionId): array {
            if ($id !== null && !isset($state['saved'][$id])) { throw new \RuntimeException('CDR_SAVED_QUERY_NOT_FOUND'); }
            if ($id === null && count($state['saved']) >= 100) { throw new \RuntimeException('CDR_SAVED_QUERY_LIMIT'); }
            // Old queries remain private and unassigned; do not silently attach them
            // to whichever centrally configured server happens to be selected next.
            $item['connection_id'] = $connectionId ?? ($state['saved'][$id]['connection_id'] ?? '');
            $state['saved'][$item['id']] = $item; return $state;
        });
        return $item;
    }

    /**
     * @return array<string, mixed> */
    public function deleteQuery(string $id, ?string $connectionId = null): array
    {
        $this->store()->update(static function (array $state) use ($id, $connectionId): array {
            if ($connectionId !== null && ($state['saved'][$id]['connection_id'] ?? '') !== $connectionId) {
                throw new \RuntimeException('CDR_SAVED_QUERY_NOT_FOUND');
            }
            unset($state['saved'][$id]); return $state;
        });
        return ['deleted' => true];
    }
}
