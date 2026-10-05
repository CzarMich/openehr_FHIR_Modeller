<?php

declare(strict_types=1);

/** Create new dedicated storage only; never modify or reuse an existing list/folder by name. */
require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\SharePointGraphFactory;
use OpenEHR\Assistant\Integrations\Repository\SharePoint\SharePointSnapshotStore;

$options = getopt('', ['create', 'name:']);
if (!array_key_exists('create', $options) || !is_string($options['name'] ?? null)
    || !preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/D', $options['name'])) {
    fwrite(STDERR, "Usage inside PHP container: php scripts/sharepoint-provision.php --create --name=modelling-test\n"); exit(2);
}
$created = [];
try {
    $settings = Settings::fromEnvironment(); $graph = SharePointGraphFactory::create($settings);
    $site = rawurlencode(SharePointSnapshotStore::identifier($settings->get('SHAREPOINT_SITE_ID')));
    $drive = rawurlencode(SharePointSnapshotStore::identifier($settings->get('SHAREPOINT_DRIVE_ID')));
    $name = $options['name'];
    $list = $graph->json('POST', 'sites/' . $site . '/lists', [], ['displayName' => $name . '-index',
        'list' => ['template' => 'genericList'], 'columns' => [
            ['name' => 'ModelProjectId', 'text' => ['maxLength' => 64], 'indexed' => true, 'enforceUniqueValues' => true, 'required' => true],
            ['name' => 'SnapshotItemId', 'text' => ['maxLength' => 250], 'required' => true],
            ['name' => 'SnapshotHash', 'text' => ['maxLength' => 64], 'required' => true],
        ]]);
    $created['SHAREPOINT_LIST_ID'] = $list['id'];
    $folder = $graph->json('POST', 'drives/' . $drive . '/root/children', [], ['name' => $name . '-snapshots',
        'folder' => new stdClass(), '@microsoft.graph.conflictBehavior' => 'fail']);
    $created['SHAREPOINT_FOLDER_ID'] = $folder['id'];
    echo json_encode(['status' => 'CREATED', 'configuration' => $created,
        'next' => 'Set these identifiers with the same site/drive and run the read-only acceptance harness.'], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable) {
    // Retain only IDs of resources created by this invocation; never delete potentially adopted resources on failure.
    echo json_encode(['status' => 'FAILED', 'created_resources' => $created,
        'next' => 'Inspect the dedicated resources and permissions before retrying; no existing resource was deleted.'], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
    exit(1);
}
