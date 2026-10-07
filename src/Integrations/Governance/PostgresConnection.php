<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Configuration\StorageConfiguration;
use PDO;

final class PostgresConnection
{
    public static function connect(Settings $settings): PDO
    {
        try {
            $pdo = new PDO(
                $settings->get('GOVERNANCE_POSTGRES_DSN') . ';connect_timeout=3',
                $settings->get('GOVERNANCE_POSTGRES_USER'),
                StorageConfiguration::secret($settings->get('GOVERNANCE_POSTGRES_PASSWORD_FILE')),
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]
            );
            $pdo->exec("SET search_path = public; SET statement_timeout = '10s'; SET lock_timeout = '5s'; SET idle_in_transaction_session_timeout = '15s';");
            return $pdo;
        } catch (\PDOException) {
            // Connection diagnostics can contain hosts, usernames and SQL. Never expose them.
            throw new \RuntimeException('GOVERNANCE_DATABASE_UNAVAILABLE');
        }
    }
}
