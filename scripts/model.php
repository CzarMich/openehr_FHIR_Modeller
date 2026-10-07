<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\RepositoryFactory;

try {
    $settings = Settings::fromEnvironment();
    if ($settings->get('AUTH_MODE') === 'oidc') {
        throw new RuntimeException('OIDC_REQUIRES_HTTP');
    }
    $repository = RepositoryFactory::create($settings);
    $arguments = array_slice($argv, 1);
    $command = array_shift($arguments) ?? '';
    if ($command === 'projects' && $arguments === []) {
        $result = ['projects' => $repository->listProjects(), 'capabilities' => $repository->capabilities()];
    } elseif ($command === 'create' && count($arguments) >= 2 && count($arguments) <= 3) {
        (new AccessPolicy($settings))->assertModelWrite();
        $result = $repository->createProject($arguments[0], $arguments[1], $arguments[2] ?? '');
    } elseif ($command === 'project' && count($arguments) === 1) {
        $project = $arguments[0];
        $result = ['project' => $repository->getProject($project), 'artifacts' => $repository->listArtifacts($project)];
    } elseif ($command === 'artifact' && count($arguments) >= 2 && count($arguments) <= 3) {
        $result = $repository->getArtifact($arguments[0], $arguments[1], $arguments[2] ?? null);
    } elseif ($command === 'history' && count($arguments) === 2) {
        $result = ['versions' => $repository->history($arguments[0], $arguments[1])];
    } elseif ($command === 'save' && count($arguments) >= 3 && count($arguments) <= 4) {
        (new AccessPolicy($settings))->assertModelWrite();
        $content = file_get_contents($arguments[2]);
        if ($content === false || strlen($content) > 2097152) {
            throw new RuntimeException('INPUT_FILE_UNAVAILABLE_OR_TOO_LARGE');
        }
        $result = $repository->saveArtifact($arguments[0], $arguments[1], $content, [], $arguments[3] ?? null);
    } else {
        throw new InvalidArgumentException('USAGE: model.php projects|create <id> <name> [description]|project <id>|artifact <project> <path> [revision]|history <project> <path>|save <project> <path> <local-file> [expected-revision]');
    }
    echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, json_encode(['error' => ['code' => preg_match('/^[A-Z][A-Z0-9_]{0,100}$/D', $error->getMessage()) ? $error->getMessage() : 'MODEL_COMMAND_FAILED']], JSON_THROW_ON_ERROR) . PHP_EOL);
    exit(1);
}