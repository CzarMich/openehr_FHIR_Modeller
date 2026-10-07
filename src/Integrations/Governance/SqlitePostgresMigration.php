<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use PDO;

/** Offline migration preserves canonical event bytes, hashes, timestamps and outstanding nonces. */
final class SqlitePostgresMigration
{
    /** @return array{events:int, subjects:int, nonces:int, sha256:string} */
    public static function migrate(string $source, PDO $target): array
    {
        if (!is_file($source) || is_link($source)) {
            throw new \RuntimeException('MIGRATION_SOURCE_REQUIRED');
        }
        $reader = new SqliteAuditStore($source);
        $sqlite = new PDO('sqlite:' . $source, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $postgres = new PostgresAuditStore($target);
        $sqlite->exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        $target->beginTransaction();
        try {
            $target->exec('LOCK TABLE governance_events, governance_nonces IN ACCESS EXCLUSIVE MODE');
            if ((int) ($target->query('SELECT COUNT(*) FROM governance_events') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED'))->fetchColumn() !== 0
                || (int) ($target->query('SELECT COUNT(*) FROM governance_nonces') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED'))->fetchColumn() !== 0) {
                throw new \RuntimeException('MIGRATION_TARGET_MUST_BE_EMPTY');
            }
            $subjects = ($sqlite->query('SELECT DISTINCT tenant, subject FROM governance_events ORDER BY tenant, subject') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED'))->fetchAll();
            foreach ($subjects as $item) {
                $reader->events($item['tenant'], $item['subject']);
            }
            $events = 0;
            $nonces = 0;
            $digest = hash_init('sha256');
            $insert = $target->prepare('INSERT INTO governance_events (tenant,subject,sequence,project,event,hash) VALUES (?,?,?,?,?,?)');
            $rows = ($sqlite->query('SELECT tenant,subject,sequence,project,event,hash FROM governance_events ORDER BY tenant,subject,sequence') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED'));
            while ($row = $rows->fetch()) {
                $insert->execute(array_values($row));
                hash_update($digest, $row['tenant'] . ':' . $row['subject'] . ':' . $row['sequence'] . ':' . $row['hash'] . "\n");
                ++$events;
            }
            $insertNonce = $target->prepare('INSERT INTO governance_nonces (nonce,expires) VALUES (?,?)');
            foreach (($sqlite->query('SELECT nonce,expires FROM governance_nonces ORDER BY nonce') ?: throw new \RuntimeException('GOVERNANCE_QUERY_FAILED')) as $row) {
                $insertNonce->execute([$row['nonce'], $row['expires']]);
                ++$nonces;
            }
            foreach ($subjects as $item) {
                if ($reader->events($item['tenant'], $item['subject']) !== $postgres->events($item['tenant'], $item['subject'])) {
                    throw new \RuntimeException('MIGRATION_VERIFICATION_FAILED');
                }
            }
            $target->commit();
            $sqlite->exec('COMMIT');
            return ['events' => $events, 'subjects' => count($subjects), 'nonces' => $nonces, 'sha256' => hash_final($digest)];
        } catch (\Throwable $error) {
            if ($target->inTransaction()) {
                $target->rollBack();
            }
            $sqlite->exec('ROLLBACK');
            throw $error;
        }
    }
}
