<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\AuditStore;

/** Opening persistent storage is deferred until an enabled governance operation executes. */
final class ConfiguredAuditStore implements AuditStore
{
    private ?AuditStore $store = null;
    public function __construct(private readonly Settings $settings)
    {
    }
    private function store(): AuditStore
    {
        if ($this->settings->get('GOVERNANCE_ENABLED') !== 'true') {
            throw new \RuntimeException('GOVERNANCE_NOT_CONFIGURED');
        }
        return $this->store ??= $this->settings->get('GOVERNANCE_DATABASE_DRIVER') === 'postgres'
            ? new PostgresAuditStore(PostgresConnection::connect($this->settings))
            : new SqliteAuditStore($this->settings->get('GOVERNANCE_DATABASE_PATH'));
    }
    public function subjects(string $tenant, string $project, int $limit = 100, int $offset = 0, ?string $firstType = null): array
    {
        return $this->store()->subjects($tenant, $project, $limit, $offset, $firstType);
    }
    public function events(string $tenant, string $subject): array
    {
        return $this->store()->events($tenant, $subject);
    }
    public function append(string $tenant, string $subject, int $expectedSequence, array $event): array
    {
        return $this->store()->append($tenant, $subject, $expectedSequence, $event);
    }
    public function consumeNonce(string $nonce, int $expires): void
    {
        if ($this->settings->get('GOVERNANCE_ENABLED') !== 'true' && $this->settings->get('CDR_ENABLED') === 'true') {
            $directory = $this->settings->get('CDR_DATA_DIR');
            if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) { throw new \RuntimeException('CDR_STORAGE_UNAVAILABLE'); }
            (new SqliteAuditStore($directory . '/browser-nonces.sqlite'))->consumeNonce($nonce, $expires);
            return;
        }
        $this->store()->consumeNonce($nonce, $expires);
    }
}
