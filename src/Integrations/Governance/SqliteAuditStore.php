<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use PDO;

/** Append-only, transactional governance ledger; never exposed as a ModelRepository path. */
final class SqliteAuditStore extends PdoAuditStore
{
    public function __construct(string $path)
    {
        if ($path !== ':memory:') {
            if (!str_starts_with($path, '/') || str_contains($path, "\0") || str_contains($path, '/../') || is_link($path)) {
                throw new \InvalidArgumentException('INVALID_GOVERNANCE_DATABASE_PATH');
            }
            $parent = dirname($path);
            if (!is_dir($parent) && !mkdir($parent, 0700, true) && !is_dir($parent)) {
                throw new \RuntimeException('GOVERNANCE_STORAGE_UNAVAILABLE');
            }
            for ($dir = $parent; $dir !== '/'; $dir = dirname($dir)) {
                if (is_link($dir)) {
                    throw new \InvalidArgumentException('GOVERNANCE_STORAGE_SYMLINK_FORBIDDEN');
                }
            }
        }
        $this->database = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        if ($path !== ':memory:' && !chmod($path, 0600)) {
            throw new \RuntimeException('GOVERNANCE_STORAGE_PERMISSIONS_FAILED');
        }
        $this->database->exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        $this->database->exec('CREATE TABLE IF NOT EXISTS governance_events (
            tenant TEXT NOT NULL, subject TEXT NOT NULL, sequence INTEGER NOT NULL,
            project TEXT NOT NULL, event TEXT NOT NULL, hash TEXT NOT NULL,
            PRIMARY KEY (tenant, subject, sequence));
            CREATE INDEX IF NOT EXISTS governance_projects ON governance_events (tenant, project, subject, sequence);
            CREATE TRIGGER IF NOT EXISTS immutable_governance_update BEFORE UPDATE ON governance_events BEGIN SELECT RAISE(ABORT, "GOVERNANCE_EVENTS_IMMUTABLE"); END;
            CREATE TRIGGER IF NOT EXISTS immutable_governance_delete BEFORE DELETE ON governance_events BEGIN SELECT RAISE(ABORT, "GOVERNANCE_EVENTS_IMMUTABLE"); END;
            CREATE TABLE IF NOT EXISTS governance_nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);');
    }

    protected function begin(string $scope): void
    {
        $this->database->exec('BEGIN IMMEDIATE');
    }
}
