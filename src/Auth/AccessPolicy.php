<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Auth;

use OpenEHR\Assistant\Configuration\Settings;

final readonly class AccessPolicy
{
    public function __construct(private Settings $settings, private ?Principal $principal = null)
    {
    }

    public function assertModelWrite(): void
    {
        if ($this->settings->get('MODEL_REPOSITORY_WRITE_ENABLED') !== 'true') { throw new \RuntimeException('WRITES_DISABLED'); }
        if ($this->settings->get('AUTH_MODE') === 'oidc'
            && ($this->principal === null || (!in_array('modelling.write', $this->principal->scopes, true)
                && !$this->principal->hasRole($this->settings->csv('OIDC_WRITE_ROLES'))))) {
            throw new \RuntimeException('WRITE_PERMISSION_REQUIRED');
        }
    }

    public function assertHumanGovernanceWrite(): void
    {
        if ($this->settings->get('MODEL_REPOSITORY_WRITE_ENABLED') !== 'true') { throw new \RuntimeException('WRITES_DISABLED'); }
        if ($this->principal === null || !$this->principal->human || $this->principal->method !== 'interactive_oidc'
            || !in_array('governance.write', $this->principal->scopes, true)) { throw new \RuntimeException('HUMAN_GOVERNANCE_PERMISSION_REQUIRED'); }
    }
}
