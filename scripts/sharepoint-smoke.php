<?php

declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\SharePointRepository;

$options = getopt('', ['allow-test-writes']);
try {
    $settings = Settings::fromEnvironment(); $repository = new SharePointRepository($settings);
    $checks = ['configured_list_schema', 'project_listing']; $repository->listProjects(); $project = null;
    if (array_key_exists('allow-test-writes', $options)) {
        if ($settings->get('MODEL_REPOSITORY_WRITE_ENABLED') !== 'true') { throw new RuntimeException('WRITES_DISABLED'); }
        $id = 'acceptance-' . bin2hex(random_bytes(8));
        $project = $repository->createProject($id, 'Synthetic acceptance', 'No clinical or patient content');
        try {
            $first = $repository->saveArtifact($id, 'requirements/synthetic.md', 'Synthetic revision one', ['source' => 'acceptance'], null);
            $second = $repository->saveArtifact($id, 'requirements/synthetic.md', 'Synthetic revision two', [], $first['revision']);
            if ($repository->getArtifact($id, 'requirements/synthetic.md')['revision'] !== $second['revision']
                || $repository->getArtifact($id, 'requirements/synthetic.md', $first['revision'])['content'] !== 'Synthetic revision one') {
                throw new RuntimeException('ROUND_TRIP_FAILED');
            }
            try { $repository->saveArtifact($id, 'requirements/synthetic.md', 'Rejected stale data', [], $first['revision']); throw new LogicException('STALE_ACCEPTED'); }
            catch (RuntimeException $error) { if ($error->getMessage() !== 'REVISION_CONFLICT') { throw $error; } }
            $repository->deleteArtifact($id, 'requirements/synthetic.md', $second['revision']);
            if (count($repository->history($id, 'requirements/synthetic.md')) !== 3 || $repository->listArtifacts($id) !== []) { throw new RuntimeException('HISTORY_FAILED'); }
            $checks = [...$checks, 'create_project', 'artifact_round_trip', 'historical_revision', 'stale_write_rejected', 'deletion_tombstone'];
        } finally { $repository->archiveProject($id, $project['revision']); }
        $checks[] = 'synthetic_project_archived';
    }
    echo json_encode(['status' => 'PASS', 'checks' => $checks, 'project' => $project['id'] ?? null,
        'timestamp' => gmdate(DATE_ATOM)], JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable) {
    fwrite(STDERR, "SharePoint acceptance failed. Inspect credentials, storage schema and configured download hosts; no secrets are included in this report.\n"); exit(1);
}
