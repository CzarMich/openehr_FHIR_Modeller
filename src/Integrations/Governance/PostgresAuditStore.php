<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use PDO;

/** Authoritative append-only ledger. Schema installation uses a separate migration role. */
final class PostgresAuditStore extends PdoAuditStore
{
    public function __construct(PDO $database)
    {
        if ($database->getAttribute(PDO::ATTR_DRIVER_NAME) !== 'pgsql') {
            throw new \InvalidArgumentException('POSTGRES_CONNECTION_REQUIRED');
        }
        $this->database = $database;
        try {
            if (($database->query('SELECT version FROM governance_schema WHERE version = 1') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED'))->fetchColumn() !== 1) {
                throw new \RuntimeException('GOVERNANCE_SCHEMA_REQUIRED');
            }
        } catch (\PDOException) {
            throw new \RuntimeException('GOVERNANCE_SCHEMA_REQUIRED');
        }
    }

    protected function begin(string $scope): void
    {
        $this->database->exec('BEGIN');
        try {
            // Subject-scoped transaction locks also protect the first event, before a row exists.
            $lock = $this->database->prepare('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
            $lock->execute(['openehr-governance:' . $scope]);
        } catch (\Throwable $error) {
            $this->database->exec('ROLLBACK');
            throw $error;
        }
    }
}
