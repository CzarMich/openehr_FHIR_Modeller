<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository\SharePoint;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\SnapshotStore;

/** Immutable files plus one conditionally updated SharePoint list row per project. */
final class SharePointSnapshotStore implements SnapshotStore
{
    private \OpenEHR\Assistant\Integrations\Cache\ModelReadCache $cache;
    private string $listPath;
    private string $drivePath;
    private string $folder;
    private int $limit;
    private bool $schemaChecked = false;

    public function __construct(private readonly GraphClient $graph, Settings $settings)
    {
        $site = self::identifier($settings->get('SHAREPOINT_SITE_ID'));
        $list = self::identifier($settings->get('SHAREPOINT_LIST_ID'));
        $drive = self::identifier($settings->get('SHAREPOINT_DRIVE_ID'));
        $this->folder = self::identifier($settings->get('SHAREPOINT_FOLDER_ID'));
        $this->cache = new \OpenEHR\Assistant\Integrations\Cache\ModelReadCache(
            $settings,
            'sharepoint:' . $settings->get('SHAREPOINT_GRAPH_URL') . ':' . $site . ':' . $list . ':' . $drive . ':' . $this->folder
        );
        $this->listPath = 'sites/' . rawurlencode($site) . '/lists/' . rawurlencode($list);
        $this->drivePath = 'drives/' . rawurlencode($drive) . '/items/';
        $this->limit = (int) $settings->get('SHAREPOINT_MAX_PROJECT_BYTES');
        if ($this->limit < 1048576 || $this->limit > 33554432 || $this->limit > (int) $settings->get('MAX_UPSTREAM_BYTES')) {
            throw new \InvalidArgumentException('SHAREPOINT_INVALID_SIZE_LIMIT');
        }
    }

    public function listIds(): array
    {
        $this->schema();
        $rows = $this->graph->collection($this->listPath . '/items', ['$expand' => 'fields', '$top' => 100]);
        $ids = [];
        foreach ($rows as $row) {
            $id = $row['fields']['ModelProjectId'] ?? null;
            if (!is_string($id)) {
                throw new \RuntimeException('SHAREPOINT_INVALID_INDEX');
            }
            self::projectId($id);
            if (isset($ids[$id])) {
                throw new \RuntimeException('SHAREPOINT_DUPLICATE_PROJECT');
            }
            $ids[$id] = true;
        }
        return array_keys($ids);
    }

    public function read(string $id): array
    {
        $head = $this->head($id) ?? throw new \RuntimeException('PROJECT_NOT_FOUND');
        return $this->snapshot($id, $head);
    }

    public function transaction(string $id, callable $operation, bool $create = false): array
    {
        $head = $this->head($id);
        if ($head === null && !$create) {
            throw new \RuntimeException('PROJECT_NOT_FOUND');
        }
        $state = $head === null ? [] : $this->snapshot($id, $head);
        [$next, $result] = $operation($state);
        $next['project']['updated_at'] = gmdate(DATE_ATOM);
        $content = json_encode($next, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
        if (strlen($content) > $this->limit) {
            throw new \RuntimeException('PROJECT_SIZE_LIMIT');
        }
        $hash = hash('sha256', $content);
        // A unique candidate cannot overwrite an accepted revision. Failed CAS candidates
        // remain unreferenced for a separate, audited retention process; never delete on timeout.
        $name = 'snapshot-' . bin2hex(random_bytes(24)) . '.json';
        $uploaded = $this->graph->json('PUT', $this->drivePath . rawurlencode($this->folder) . ':/' . $name . ':/content', [], $content);
        $item = self::field($uploaded, 'id');
        self::identifier($item);
        $fields = ['Title' => $id, 'ModelProjectId' => $id, 'SnapshotItemId' => $item, 'SnapshotHash' => $hash];
        if ($head === null) {
            // The unique indexed ModelProjectId column makes creation atomic across instances.
            try {
                $this->graph->json('POST', $this->listPath . '/items', [], ['fields' => $fields]);
            } catch (\RuntimeException $error) {
                if (in_array($error->getMessage(), ['SHAREPOINT_REJECTED', 'REVISION_CONFLICT'], true) && $this->head($id) !== null) {
                    throw new \RuntimeException('REVISION_CONFLICT');
                }
                throw $error;
            }
        } else {
            $this->graph->json(
                'PATCH',
                $this->listPath . '/items/' . rawurlencode($head['id']) . '/fields',
                [],
                ['SnapshotItemId' => $item, 'SnapshotHash' => $hash],
                ['If-Match' => $head['etag']]
            );
        }
        return $result;
    }

    /** @return array{id:string, etag:string, item:string, hash:string}|null */
    private function head(string $id): ?array
    {
        self::projectId($id);
        $this->schema();
        $rows = $this->graph->collection($this->listPath . '/items', ['$filter' => "fields/ModelProjectId eq '" . $id . "'", '$expand' => 'fields']);
        if ($rows === []) {
            return null;
        }
        if (count($rows) !== 1 || ($rows[0]['fields']['ModelProjectId'] ?? null) !== $id || !is_array($rows[0]['fields'] ?? null)) {
            throw new \RuntimeException('SHAREPOINT_INVALID_INDEX');
        }
        $row = $rows[0];
        $fields = $row['fields'];
        $rowId = self::identifier(self::field($row, 'id'));
        $item = self::identifier(self::field($fields, 'SnapshotItemId'));
        $hash = self::field($fields, 'SnapshotHash');
        $etag = self::field($row, 'eTag');
        if (!preg_match('/^[a-f0-9]{64}$/D', $hash) || $etag === '' || $etag === '*' || strlen($etag) > 256 || preg_match('/[\x00-\x1f\x7f]/', $etag)) {
            throw new \RuntimeException('SHAREPOINT_INVALID_INDEX');
        }
        return ['id' => $rowId, 'etag' => $etag, 'item' => $item, 'hash' => $hash];
    }

    /** @param array{id:string, etag:string, item:string, hash:string} $head
     * @return array<string, mixed> */
    private function snapshot(string $id, array $head): array
    {
        // Recheck current drive permissions and containment even on a cache hit.
        $path = $this->drivePath . rawurlencode($head['item']);
        $metadata = $this->graph->json('GET', $path);
        if (($metadata['parentReference']['id'] ?? null) !== $this->folder || isset($metadata['remoteItem'])
            || !is_int($metadata['size'] ?? null) || $metadata['size'] > $this->limit || !is_array($metadata['file'] ?? null)) {
            throw new \RuntimeException('SHAREPOINT_INVALID_SNAPSHOT');
        }
        return $this->cache->remember($id . ':' . $head['item'] . ':' . $head['hash'], fn (): array => $this->uncachedSnapshot($id, $head));
    }

    /** @param array{id:string, etag:string, item:string, hash:string} $head
     * @return array<string, mixed> */
    private function uncachedSnapshot(string $id, array $head): array
    {
        $path = $this->drivePath . rawurlencode($head['item']);
        $raw = $this->graph->content($path . '/content');
        if (strlen($raw) > $this->limit || !hash_equals($head['hash'], hash('sha256', $raw))) {
            throw new \RuntimeException('SHAREPOINT_SNAPSHOT_INTEGRITY_FAILED');
        }
        try {
            $state = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \RuntimeException('SHAREPOINT_INVALID_SNAPSHOT');
        }
        if (!is_array($state) || !is_array($state['project'] ?? null) || ($state['project']['id'] ?? null) !== $id
            || !is_array($state['artifacts'] ?? null) || !is_array($state['history'] ?? null)) {
            throw new \RuntimeException('SHAREPOINT_INVALID_SNAPSHOT');
        }
        return $state;
    }

    private function schema(): void
    {
        if ($this->schemaChecked) {
            return;
        }
        $columns = $this->graph->collection($this->listPath . '/columns');
        $byName = [];
        foreach ($columns as $column) {
            if (is_string($column['name'] ?? null)) {
                $byName[$column['name']] = $column;
            }
        }
        foreach (['ModelProjectId', 'SnapshotItemId', 'SnapshotHash'] as $name) {
            if (!isset($byName[$name]) || !is_array($byName[$name]['text'] ?? null) || ($byName[$name]['readOnly'] ?? false) !== false) {
                throw new \RuntimeException('SHAREPOINT_SCHEMA_REQUIRED');
            }
        }
        if (($byName['ModelProjectId']['enforceUniqueValues'] ?? false) !== true || ($byName['ModelProjectId']['indexed'] ?? false) !== true) {
            throw new \RuntimeException('SHAREPOINT_UNIQUE_PROJECT_INDEX_REQUIRED');
        }
        $this->schemaChecked = true;
    }

    private static function projectId(string $id): void
    {
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/D', $id)) {
            throw new \InvalidArgumentException('INVALID_PROJECT_ID');
        }
    }

    public static function identifier(string $id): string
    {
        if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.!,~-]{0,249}$/D', $id) || str_contains($id, '..')) {
            throw new \InvalidArgumentException('INVALID_SHAREPOINT_IDENTIFIER');
        }
        return $id;
    }

    /** @param array<string, mixed> $data */
    private static function field(array $data, string $key): string
    {
        if (!is_string($data[$key] ?? null)) {
            throw new \RuntimeException('SHAREPOINT_INVALID_RESPONSE');
        }
        return $data[$key];
    }
}
