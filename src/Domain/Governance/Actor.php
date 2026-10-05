<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Governance;

/** Supplied by the verified transport adapter, never deserialized from tool input. */
final readonly class Actor
{
    /** @var list<string> */
    public array $roles;
    /** @var list<string> */
    public array $projectScopes;

    /** @param array<mixed> $roles
     * @param array<mixed> $projectScopes */
    public function __construct(public string $id, public string $tenant, array $roles,
        public bool $human = false, public string $method = 'service', array $projectScopes = [])
    {
        if ($id === '' || strlen($id) > 200 || !preg_match('/^(?:shared|[a-f0-9]{64})$/D', $tenant)
            || ($human && !in_array($method, ['interactive_oidc', 'interactive_local'], true)) || !array_is_list($roles) || count($roles) > 100
            || !array_is_list($projectScopes) || count($projectScopes) > 100) {
            throw new \InvalidArgumentException('INVALID_GOVERNANCE_ACTOR');
        }
        foreach ($roles as $role) {
            if (!is_string($role) || !preg_match('/^[a-z][a-z0-9_-]{0,49}$/D', $role)) { throw new \InvalidArgumentException('INVALID_GOVERNANCE_ROLE'); }
        }
        foreach ($projectScopes as $scope) {
            if (!is_string($scope) || !preg_match('/^(?:projects:admin|projects:create|project:[A-Za-z0-9._-]{1,100}:(?:read|write))$/D', $scope)) {
                throw new \InvalidArgumentException('INVALID_GOVERNANCE_PROJECT_SCOPE');
            }
        }
        $this->roles = $roles;
        $this->projectScopes = $projectScopes;
    }

    /** @return array<string, mixed> */
    public function evidence(): array
    {
        return ['id' => $this->id, 'tenant' => $this->tenant, 'roles' => $this->roles, 'human' => $this->human, 'method' => $this->method];
    }
}
