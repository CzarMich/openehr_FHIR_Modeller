<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use OpenEHR\Assistant\Domain\Governance\AuditStore;
use PDO;

/** Shared canonical audit encoding, integrity checks and optimistic concurrency. */
abstract class PdoAuditStore implements AuditStore
{
    protected PDO $database;

    abstract protected function begin(string $scope): void;

    public function subjects(string $tenant, string $project, int $limit = 100, int $offset = 0, ?string $firstType = null): array
    {
        $this->tenant($tenant);
        $this->project($project);
        if ($limit < 1 || $limit > 100 || $offset < 0 || $offset > 10000) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_PAGE');
        }
        if ($firstType !== null && !preg_match('/^[A-Z][A-Z0-9_]{0,79}$/D', $firstType)) {
            throw new \InvalidArgumentException('INVALID_AUDIT_STREAM_TYPE');
        }
        // Filter by the first event before pagination, preserving existing immutable ledgers.
        $type = $this->database->getAttribute(PDO::ATTR_DRIVER_NAME) === 'pgsql'
            ? "CAST(first.event AS jsonb)->>'type'" : "json_extract(first.event, '$.type')";
        $filter = $firstType === null ? '' : ' AND ' . $type . ' = :first_type';
        $query = $this->database->prepare('SELECT e.subject, MAX(e.sequence) AS sequence FROM governance_events e
            JOIN governance_events first ON first.tenant = e.tenant AND first.subject = e.subject AND first.sequence = 1
            WHERE e.tenant = :tenant AND e.project = :project' . $filter . '
            GROUP BY e.subject ORDER BY e.subject LIMIT :limit OFFSET :offset');
        if ($firstType !== null) { $query->bindValue(':first_type', $firstType); }
        $query->bindValue(':tenant', $tenant);
        $query->bindValue(':project', $project);
        $query->bindValue(':limit', $limit, PDO::PARAM_INT);
        $query->bindValue(':offset', $offset, PDO::PARAM_INT);
        $query->execute();
        $result = [];
        foreach ($query->fetchAll() as $row) {
            $events = $this->events($tenant, $row['subject']);
            $result[] = ['subject' => $row['subject'], 'sequence' => count($events), 'first' => $events[0], 'latest' => $events[count($events) - 1]];
        }
        return $result;
    }

    public function events(string $tenant, string $subject): array
    {
        $this->tenant($tenant);
        $this->subject($subject);
        $query = $this->database->prepare('SELECT sequence, project, event, hash FROM governance_events WHERE tenant = ? AND subject = ? ORDER BY sequence');
        $query->execute([$tenant, $subject]);
        $events = [];
        $previous = str_repeat('0', 64);
        $sequence = 0;
        while ($row = $query->fetch()) {
            if (++$sequence > 256) {
                throw new \RuntimeException('GOVERNANCE_HISTORY_LIMIT_EXCEEDED');
            }
            $event = json_decode($row['event'], true, 64, JSON_THROW_ON_ERROR);
            if (!is_array($event) || ($event['sequence'] ?? null) !== $sequence || (int) $row['sequence'] !== $sequence
                || ($event['project'] ?? null) !== $row['project']
                || ($event['tenant'] ?? null) !== $tenant || ($event['subject'] ?? null) !== $subject
                || ($event['previous_hash'] ?? null) !== $previous || !hash_equals(hash('sha256', $row['event']), $row['hash'])) {
                throw new \RuntimeException('GOVERNANCE_AUDIT_INTEGRITY_FAILED');
            }
            $events[] = $event + ['hash' => $row['hash']];
            $previous = $row['hash'];
        }
        return $events;
    }

    public function append(string $tenant, string $subject, int $expectedSequence, array $event): array
    {
        $this->tenant($tenant);
        $this->subject($subject);
        $this->project($event['project'] ?? '');
        if ($expectedSequence < 0 || $expectedSequence >= 256 || array_intersect(array_keys($event), ['tenant', 'subject', 'sequence', 'timestamp', 'hash', 'previous_hash']) !== []) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_EVENT');
        }
        $this->begin($tenant . ':' . $subject);
        try {
            $history = $this->events($tenant, $subject);
            if (count($history) !== $expectedSequence) {
                throw new \RuntimeException('GOVERNANCE_REVISION_CONFLICT');
            }
            if ($history !== [] && $history[0]['project'] !== $event['project']) {
                throw new \RuntimeException('GOVERNANCE_SUBJECT_IDENTITY_CONFLICT');
            }
            $event = ['tenant' => $tenant, 'subject' => $subject, 'sequence' => $expectedSequence + 1, 'timestamp' => gmdate(DATE_ATOM),
                'previous_hash' => $expectedSequence === 0 ? str_repeat('0', 64) : $history[$expectedSequence - 1]['hash']] + $event;
            $encoded = json_encode($event, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE, 64);
            if (strlen($encoded) > 65536) {
                throw new \InvalidArgumentException('GOVERNANCE_EVENT_TOO_LARGE');
            }
            $hash = hash('sha256', $encoded);
            $query = $this->database->prepare('INSERT INTO governance_events (tenant,subject,sequence,project,event,hash) VALUES (?,?,?,?,?,?)');
            $query->execute([$tenant, $subject, $event['sequence'], $event['project'], $encoded, $hash]);
            $this->database->exec('COMMIT');
            return $event + ['hash' => $hash];
        } catch (\Throwable $error) {
            $this->database->exec('ROLLBACK');
            throw $error;
        }
    }

    public function consumeNonce(string $nonce, int $expires): void
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $nonce) || $expires < time() || $expires > time() + 120) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_ASSERTION');
        }
        $this->begin('governance-nonces');
        try {
            $delete = $this->database->prepare('DELETE FROM governance_nonces WHERE expires < ?');
            $delete->execute([time() - 120]);
            $count = $this->database->prepare('SELECT COUNT(*) FROM governance_nonces');
            $count->execute();
            if ((int) $count->fetchColumn() >= 10000) {
                throw new \RuntimeException('GOVERNANCE_ASSERTION_LIMIT_EXCEEDED');
            }
            $insert = $this->database->prepare('INSERT INTO governance_nonces (nonce,expires) VALUES (?,?) ON CONFLICT (nonce) DO NOTHING');
            $insert->execute([$nonce, $expires]);
            if ($insert->rowCount() !== 1) {
                throw new \RuntimeException('GOVERNANCE_ASSERTION_REPLAYED');
            }
            $this->database->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->database->exec('ROLLBACK');
            throw $error;
        }
    }

    protected function tenant(string $tenant): void
    {
        if (!preg_match('/^(?:shared|[a-f0-9]{64})$/D', $tenant)) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_TENANT');
        }
    }
    protected function subject(string $subject): void
    {
        if (!preg_match('/^[a-f0-9]{64}$/D', $subject)) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_SUBJECT');
        }
    }
    protected function project(string $project): void
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/D', $project)) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_PROJECT');
        }
    }
}
