<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Repository;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Repository\SnapshotRepository;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\GraphClient;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\SharePointSnapshotStore;

final class SharePointRepository extends SnapshotRepository
{
    public function __construct(Settings $settings, ?GraphClient $graph = null)
    {
        $graph ??= \OpenEHR\Assistant\Integrations\Repository\SharePoint\SharePointGraphFactory::create($settings);
        parent::__construct(new SharePointSnapshotStore($graph, $settings), 'sharepoint', false);
    }
}
