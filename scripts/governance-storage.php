#!/usr/bin/env php
<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Governance\PostgresConnection;
use OpenEHR\Assistant\Integrations\Governance\PostgresAuditStore;
use OpenEHR\Assistant\Integrations\Governance\SqlitePostgresMigration;

try {
    $connection = PostgresConnection::connect(Settings::fromEnvironment());
    $command = $argv[1] ?? '';
    $result = match ($command) {
        'check' => (static function () use ($connection): array {
            new PostgresAuditStore($connection);
            return ['status' => 'ready', 'driver' => 'postgres', 'schema_version' => 1];
        })(),
        'verify' => (static function () use ($connection): array {
            $store = new PostgresAuditStore($connection);
            $rows = $connection->query('SELECT DISTINCT tenant,subject FROM governance_events ORDER BY tenant,subject');
            if ($rows === false) {
                throw new RuntimeException('GOVERNANCE_QUERY_FAILED');
            }
            $subjects = 0;
            $events = 0;
            $digest = hash_init('sha256');
            foreach ($rows as $row) {
                ++$subjects;
                foreach ($store->events($row['tenant'], $row['subject']) as $event) {
                    ++$events;
                    hash_update($digest, $row['tenant'] . ':' . $row['subject'] . ':' . $event['sequence'] . ':' . $event['hash'] . "\n");
                }
            }
            return ['status' => 'verified', 'subjects' => $subjects, 'events' => $events, 'sha256' => hash_final($digest)];
        })(),
        'import-sqlite' => SqlitePostgresMigration::migrate($argv[2] ?? '', $connection),
        'cutover' => (static function () use ($connection): array {
            $source = Settings::fromEnvironment()->get('GOVERNANCE_DATABASE_PATH');
            if (!is_file($source)) {
                new PostgresAuditStore($connection);
                $count = $connection->query('SELECT COUNT(*) FROM governance_events');
                if ($count === false || (int) $count->fetchColumn() !== 0) {
                    throw new RuntimeException('MIGRATION_TARGET_MUST_BE_EMPTY');
                }
                return ['status' => 'new-ledger', 'events' => 0];
            }
            $backup = dirname($source) . '/pre-postgres-' . gmdate('YmdHis') . '-' . bin2hex(random_bytes(4)) . '.sqlite';
            $sqlite = new PDO('sqlite:' . $source, options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $copy = $sqlite->prepare('VACUUM INTO ?');
            $copy->execute([$backup]);
            chmod($backup, 0600);
            return SqlitePostgresMigration::migrate($source, $connection) + ['status' => 'migrated', 'backup' => basename($backup)];
        })(),
        default => throw new InvalidArgumentException('Usage: governance-storage.php check|verify|cutover|import-sqlite /absolute/backup.sqlite'),
    };
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    $code = preg_match('/^[A-Z_]+$/D', $error->getMessage()) ? $error->getMessage() : 'GOVERNANCE_STORAGE_COMMAND_FAILED';
    fwrite(STDERR, $code . "\n");
    exit(1);
}
