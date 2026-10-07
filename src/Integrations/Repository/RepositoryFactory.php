<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Auth\Principal;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;

final class RepositoryFactory
{
    public static function create(Settings $settings, ?Principal $principal = null): ModelRepository
    {
        if ($settings->get('AUTH_MODE') === 'oidc') {
            // Readiness may construct the registry without credentials. Only authenticated
            // requests execute tools; their tenant selects an isolated repository namespace.
            $tenant = $principal === null ? 'unauthenticated' : $principal->tenant;
            if (!preg_match('/^(?:[a-f0-9]{64}|unauthenticated)$/D', $tenant)) {
                throw new \InvalidArgumentException('INVALID_TENANT');
            }
            $settings = $settings->with(['MODEL_REPOSITORY_PATH' => rtrim($settings->get('MODEL_REPOSITORY_PATH'), '/') . '/tenants/' . $tenant]);
        }
        if (in_array($settings->get('MODEL_REPOSITORY_PROVIDER'), ['git', 'github', 'gitlab'], true)) {
            if ($settings->get('AUTH_MODE') === 'oidc') {
                $remotes = $settings->tenantGitRemotes();
                if ($settings->get('MODEL_GIT_REMOTE_URL') !== '' && $remotes === []) {
                    throw new \InvalidArgumentException('OIDC_TENANT_GIT_REMOTES_REQUIRED');
                }
                if ($principal !== null && $remotes !== [] && !isset($remotes[$principal->tenant])) {
                    throw new \InvalidArgumentException('TENANT_REPOSITORY_NOT_CONFIGURED');
                }
                if ($principal !== null && $settings->get('MODEL_REPOSITORY_PROVIDER') !== 'git' && !isset($remotes[$principal->tenant])) {
                    throw new \InvalidArgumentException('TENANT_REPOSITORY_NOT_CONFIGURED');
                }
                $settings = $settings->with(['MODEL_GIT_REMOTE_URL' => $principal === null ? '' : ($remotes[$principal->tenant] ?? '')]);
            }
            return self::scope(new GitModelRepository($settings, Hosted\HostedProviderFactory::create($settings)), $settings, $principal);
        }
        if ($settings->get('MODEL_REPOSITORY_PROVIDER') === 'sharepoint') {
            if ($settings->get('AUTH_MODE') === 'oidc') {
                $map = $settings->tenantSharePointRepositories();
                $target = $principal === null ? array_fill_keys(['site_id', 'list_id', 'drive_id', 'folder_id'], 'unauthenticated')
                    : ($map[$principal->tenant] ?? throw new \InvalidArgumentException('TENANT_REPOSITORY_NOT_CONFIGURED'));
                $settings = $settings->with(['SHAREPOINT_SITE_ID' => $target['site_id'], 'SHAREPOINT_LIST_ID' => $target['list_id'],
                    'SHAREPOINT_DRIVE_ID' => $target['drive_id'], 'SHAREPOINT_FOLDER_ID' => $target['folder_id']]);
            }
            return self::scope(new SharePointRepository($settings), $settings, $principal);
        }
        return self::scope(new FileSystemRepository(
            $settings->get('MODEL_REPOSITORY_PATH'),
            new \OpenEHR\Assistant\Integrations\Cache\ModelReadCache($settings, 'filesystem:' . $settings->get('MODEL_REPOSITORY_PATH'))
        ), $settings, $principal);
    }

    private static function scope(ModelRepository $repository, Settings $settings, ?Principal $principal): ModelRepository
    {
        if ($settings->get('PROJECT_RBAC_ENABLED') !== 'true') {
            return $repository;
        }
        if ($principal === null) {
            throw new \RuntimeException('PROJECT_RBAC_IDENTITY_REQUIRED');
        }
        return new ProjectScopedRepository($repository, $principal);
    }
}
