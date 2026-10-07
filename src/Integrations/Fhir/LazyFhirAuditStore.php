<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Fhir;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;

/** Keep discovery read-only; initialize the private ledger only for FHIR operations. */
final class LazyFhirAuditStore implements AuditStore
{
    private ?AuditStore $store = null;
    public function __construct(private readonly Settings $settings) {}
    private function store(): AuditStore
    { return $this->store ??= new SqliteAuditStore($this->settings->get('FHIR_AUDIT_PATH')); }
    public function subjects(string $tenant, string $project, int $limit = 100, int $offset = 0, ?string $firstType = null): array
    { return $this->store()->subjects($tenant, $project, $limit, $offset, $firstType); }
    public function events(string $tenant, string $subject): array
    { return $this->store()->events($tenant, $subject); }
    public function append(string $tenant, string $subject, int $expectedSequence, array $event): array
    { return $this->store()->append($tenant, $subject, $expectedSequence, $event); }
    public function consumeNonce(string $nonce, int $expires): void
    { $this->store()->consumeNonce($nonce, $expires); }
}
