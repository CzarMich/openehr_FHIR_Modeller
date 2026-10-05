<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Validation;

/** Bounded diagnostic collection; never retains complete submitted model content. */
final class Findings
{
    /** @var list<array<string, mixed>> */
    private array $items = [];
    private int $omitted = 0;
    private bool $failed = false;

    /** @param array<string, mixed> $evidence */
    public function add(string $severity, string $code, string $location, string $message, array $evidence, string $remediation): void
    {
        $this->failed = $this->failed || $severity === 'error';
        if (count($this->items) >= 500) {
            ++$this->omitted;
            return;
        }
        if (strlen($location) > 2000) {
            $evidence['full_location_sha256'] = hash('sha256', $location);
            $location = mb_strcut($location, 0, 1900, 'UTF-8') . '...[truncated]';
        }
        $this->items[] = compact('severity', 'code', 'location', 'message', 'evidence', 'remediation');
    }

    public function failed(): bool
    {
        return $this->failed;
    }

    /** @return list<array<string, mixed>> */
    public function all(): array
    {
        $items = $this->items;
        if ($this->omitted > 0) {
            $items[] = ['severity' => 'warning', 'code' => 'FINDINGS_TRUNCATED', 'location' => '/',
                'message' => 'Additional diagnostics were omitted from this bounded response.',
                'evidence' => ['omitted' => $this->omitted], 'remediation' => 'Resolve the reported findings and rerun the check.'];
        }
        return $items;
    }
}
