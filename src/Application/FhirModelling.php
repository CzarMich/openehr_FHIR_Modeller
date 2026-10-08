<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Fhir\ProjectConfiguration;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Standards\StandardsProvider;
use OpenEHR\Assistant\Integrations\Fhir\FhirConnections;

/** FHIR authoring client. Publication/distribution belongs to the connected existing IG server. */
final readonly class FhirModelling
{
    public const string CONFIG = 'documentation/fhir-project.json';

    public function __construct(private ModelRepository $repository, private AccessPolicy $access,
        private StandardsProvider $provider, private AuditStore $audit, private Actor $actor,
        private FhirConnections $connections) {}

    /** @return array<string, mixed> */
    public function project(string $action, ?string $projectId = null, ?string $document = null, ?string $expectedRevision = null): array
    {
        if ($action === 'capabilities') { return $this->provider->execute('capabilities.get', []); }
        if ($action === 'list') {
            $items = [];
            foreach ($this->repository->listProjects() as $project) {
                try { $items[] = $this->project('get', $project['id'])['project']; }
                catch (\RuntimeException $error) { if ($error->getMessage() !== 'ARTIFACT_NOT_FOUND') { throw $error; } }
            }
            return ['items' => $items, 'total' => count($items), 'providers' => ['openEHR', 'FHIR']];
        }
        $id = self::identifier($projectId);
        if (in_array($action, ['create', 'update'], true)) {
            $this->access->assertProjectWrite($id);
            $configuration = ProjectConfiguration::validate(self::arguments($document ?? '{}'));
            if ($action === 'create') { $this->repository->createProject($id, $configuration['name'], 'FHIR authoring workspace'); }
            else {
                $current = $this->project('get', $id);
                $hasModels = $current['artifacts'] !== [] || array_filter($this->repository->listArtifacts($id),
                    static fn (array $artifact): bool => str_starts_with($artifact['path'], 'mappings/')) !== [];
                if ($current['project']['fhirVersion'] !== $configuration['fhirVersion'] && $hasModels) {
                    throw new \DomainException('FHIR_RELEASE_CHANGE_REQUIRES_NEW_PROJECT');
                }
            }
            $saved = $this->repository->saveArtifact($id, self::CONFIG, json_encode($configuration, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT),
                ['standard' => 'FHIR'], $expectedRevision);
            $this->record($id, 'project.' . $action, ['revision' => $saved['revision']]);
        } elseif ($action !== 'get') { throw new \InvalidArgumentException('FHIR_PROJECT_OPERATION_UNSUPPORTED'); }
        $saved = $this->repository->getArtifact($id, self::CONFIG);
        $configuration = self::arguments($saved['content']);
        return ['project' => ['id' => $id] + $configuration, 'revision' => $saved['revision'],
            'artifacts' => array_values(array_filter($this->repository->listArtifacts($id), static fn (array $a): bool => str_starts_with($a['path'], 'fhir/')))];
    }

    /** @return array<string, mixed> */
    public function operation(string $category, string $action, string $projectId, string $arguments = '{}'): array
    {
        $args = self::arguments($arguments);
        $project = $this->project('get', $projectId)['project'];
        $allowed = [
            'package' => ['search', 'get', 'install', 'dependencies', 'artifacts', 'resolve'],
            'source' => ['inspect', 'import'],
            'artifact' => ['inspect', 'get', 'search', 'save', 'validate', 'diff', 'history'],
            'profile' => ['discover', 'generate', 'validate'], 'examples' => ['generate'], 'fsh' => ['compile'], 'fhirpath' => ['validate', 'evaluate'],
            'mapping' => ['list', 'get', 'save', 'analyse'], 'connection' => ['list', 'get', 'test', 'metadata', 'search', 'read', 'validate'],
            'ig' => ['test', 'projects', 'status', 'submit', 'sync', 'build', 'publish'],
        ];
        if (!in_array($action, $allowed[$category] ?? [], true)) { throw new \InvalidArgumentException('FHIR_OPERATION_UNSUPPORTED'); }
        if (in_array($action, ['save', 'install', 'import', 'submit', 'sync', 'build', 'publish'], true)) { $this->access->assertProjectWrite($projectId); }
        if ($category === 'source') { return $this->source($action, $projectId, $args, $project); }
        if ($category === 'artifact' && in_array($action, ['get', 'search', 'save', 'history'], true)) {
            return $this->artifacts($action, $projectId, $args, $project);
        }
        if ($category === 'mapping' && $action !== 'analyse') { return $this->mappings($action, $projectId, $args); }
        if ($category === 'connection') { return $this->connection($action, $args); }
        if ($category === 'ig') { return $this->ig($action, $projectId, $project, $args); }
        if (in_array($category, ['profile', 'mapping'], true)) {
            $args['projectArtifacts'] = $this->resources($projectId);
        }
        if ($category === 'artifact' && isset($args['path']) && $action === 'validate') {
            $artifact = $this->repository->getArtifact($projectId, self::artifactPath($args['path']), $args['revision'] ?? null);
            $args['content'] = $artifact['content'];
            $args['sourceRevision'] = $artifact['revision'];
        }
        if ($category === 'profile' && $action === 'validate') { $category = 'artifact'; }
        $args['project'] = $project;
        $result = $this->provider->execute($category . '.' . $action, $args);
        $evidence = $this->record($projectId, $category . '.' . $action, ['inputHash' => hash('sha256', json_encode($args, JSON_THROW_ON_ERROR)),
            'resultHash' => hash('sha256', json_encode($result, JSON_THROW_ON_ERROR)), 'fhirVersion' => $project['fhirVersion'],
            'sourceRevision' => $args['sourceRevision'] ?? null, 'status' => $result['status'] ?? null,
            'valid' => $result['valid'] ?? null, 'dependencies' => $project['dependencies']]);
        $result['platformProvenance'] = ['event' => $evidence['subject'], 'hash' => $evidence['hash'], 'timestamp' => $evidence['timestamp'],
            'actor' => $this->actor->id, 'project' => $projectId, 'clinicalApproval' => false];
        return $result;
    }

    /** @param array<string, mixed> $args
     * @param array<string, mixed> $project
     * @return array<string, mixed> */
    private function artifacts(string $action, string $projectId, array $args, array $project): array
    {
        if ($action === 'search') {
            $items = array_values(array_filter($this->repository->listArtifacts($projectId), static fn (array $a): bool =>
                str_starts_with($a['path'], 'fhir/') && (!isset($args['query']) || stripos($a['path'] . ' ' . json_encode($a['metadata']), (string) $args['query']) !== false)));
            return ['items' => $items, 'total' => count($items)];
        }
        $path = self::artifactPath($args['path'] ?? null);
        if ($action === 'get') { return $this->repository->getArtifact($projectId, $path, $args['revision'] ?? null); }
        if ($action === 'history') { return ['items' => $this->repository->history($projectId, $path)]; }
        $content = $args['content'] ?? null;
        if (!is_string($content) || $content === '' || strlen($content) > 2097152) { throw new \InvalidArgumentException('FHIR_CONTENT_INVALID'); }
        $representation = $args['representation'] ?? 'authored';
        if (!in_array($representation, ['authored', 'imported', 'generated', 'example'], true)) { throw new \InvalidArgumentException('FHIR_REPRESENTATION_INVALID'); }
        $format = $args['format'] ?? pathinfo($path, PATHINFO_EXTENSION);
        if (!in_array($format, ['json', 'xml', 'fsh', 'yaml', 'md'], true)) { throw new \InvalidArgumentException('FHIR_FORMAT_UNSUPPORTED'); }
        if ($format === 'xml' && $representation !== 'imported') { throw new \DomainException('FHIR_XML_ORIGINAL_IMPORT_ONLY'); }
        $inspection = $format === 'json' ? $this->provider->execute('artifact.inspect', ['content' => $content, 'project' => $project]) : [];
        $resource = is_array($inspection['resource'] ?? null) ? $inspection['resource'] : [];
        $identity = is_array($inspection['identity'] ?? null) ? $inspection['identity'] : [];
        $compact = array_intersect_key($resource, array_flip(['resourceType', 'id', 'url', 'version', 'name', 'title', 'fhirVersion', 'baseDefinition', 'type', 'kind']));
        foreach (['resourceType', 'id', 'version', 'fhirVersion'] as $field) {
            if (!isset($compact[$field]) && isset($identity[$field])) { $compact[$field] = $identity[$field]; }
        }
        if (!isset($compact['url']) && isset($identity['canonical'])) { $compact['url'] = $identity['canonical']; }
        if (isset($inspection['kind'])) { $compact['artifactKind'] = $inspection['kind']; }
        $source = $args['provenance'] ?? [];
        if (!is_array($source)) { throw new \InvalidArgumentException('FHIR_PROVENANCE_INVALID'); }
        ProjectConfiguration::noSecrets($source);
        $metadata = ['standard' => 'FHIR', 'representation' => $representation, 'format' => $format,
            'fhirVersion' => $project['fhirVersion'], 'sourceClaims' => $source, 'actor' => $this->actor->id,
            'inspection' => $compact,
            'inspectionStatus' => $format === 'xml' ? 'unsupported-original-preserved' : ($format === 'json' ? 'inspected-not-validated' : 'not-run'),
            'inspectionHash' => hash('sha256', json_encode($inspection, JSON_THROW_ON_ERROR)), 'clinicalApproval' => false];
        // Imported originals are immutable; subsequent edits must use an authored path.
        if ($representation === 'imported' && ($args['expectedRevision'] ?? null) !== null) { throw new \DomainException('FHIR_ORIGINAL_IMMUTABLE'); }
        try {
            $current = $this->repository->getArtifact($projectId, $path);
            if (($current['metadata']['representation'] ?? '') === 'imported') { throw new \DomainException('FHIR_ORIGINAL_IMMUTABLE'); }
        } catch (\RuntimeException $error) { if ($error->getMessage() !== 'ARTIFACT_NOT_FOUND') { throw $error; } }
        $saved = $this->repository->saveArtifact($projectId, $path, $content, $metadata, $args['expectedRevision'] ?? null);
        $this->record($projectId, 'artifact.save', ['path' => $path, 'revision' => $saved['revision'], 'sha256' => $saved['sha256'], 'representation' => $representation]);
        return $saved;
    }

    /** @param array<string, mixed> $args
     * @return array<string, mixed> */
    private function mappings(string $action, string $projectId, array $args): array
    {
        if ($action === 'list') {
            $items = array_values(array_filter($this->repository->listArtifacts($projectId), static fn (array $a): bool => str_starts_with($a['path'], 'mappings/')));
            return ['items' => $items, 'total' => count($items)];
        }
        $path = 'mappings/' . self::identifier($args['id'] ?? null) . '.json';
        if ($action === 'get') { return $this->repository->getArtifact($projectId, $path, $args['revision'] ?? null); }
        foreach (['source', 'target'] as $end) {
            if (!is_array($args[$end] ?? null) || !in_array($args[$end]['standard'] ?? null, ['openEHR', 'FHIR'], true)) { throw new \InvalidArgumentException('FHIR_MAPPING_ENDPOINT_INVALID'); }
            foreach (['artifact', 'version', 'path'] as $field) {
                if (!is_string($args[$end][$field] ?? null) || $args[$end][$field] === '') { throw new \InvalidArgumentException('FHIR_MAPPING_VERSION_REQUIRED'); }
            }
        }
        if (!in_array($args['relationship'] ?? null, ['equivalent', 'narrower', 'broader', 'transformed', 'conditional', 'no-direct-equivalent'], true)) {
            throw new \InvalidArgumentException('FHIR_MAPPING_RELATIONSHIP_INVALID');
        }
        ProjectConfiguration::noSecrets($args);
        $revision = $args['expectedRevision'] ?? null;
        unset($args['expectedRevision']);
        $args['status'] = 'proposed'; $args['validated'] = false; $args['author'] = $this->actor->id;
        $args['equivalenceAssurance'] = 'CALLER_PROPOSAL_REQUIRES_REVIEW';
        $saved = $this->repository->saveArtifact($projectId, $path, json_encode($args, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT), ['kind' => 'cross-standard-mapping'], $revision);
        $this->record($projectId, 'mapping.save', ['path' => $path, 'revision' => $saved['revision']]);
        return $saved;
    }

    /** @param array<string, mixed> $args
     * @return array<string, mixed> */
    private function connection(string $action, array $args): array
    {
        if ($action === 'list') { $items = $this->connections->summaries(); return ['items' => $items, 'total' => count($items)]; }
        $id = self::identifier($args['id'] ?? null);
        if ($action === 'get') {
            foreach ($this->connections->summaries() as $summary) { if ($summary['id'] === $id) { return $summary; } }
            throw new \RuntimeException('FHIR_CONNECTION_NOT_FOUND');
        }
        if (in_array($action, ['test', 'metadata'], true)) { return $this->connections->test($id); }
        if (in_array($action, ['search', 'read'], true)) { return $this->connections->definitions($id, $action, $args); }
        $metadata = $this->connections->test($id)['capabilities'];
        $supported = false;
        foreach ($metadata['rest'] ?? [] as $rest) {
            foreach ($rest['operation'] ?? [] as $operation) { $supported = $supported || ($operation['name'] ?? '') === 'validate'; }
        }
        if (!$supported) { throw new \DomainException('FHIR_RUNTIME_VALIDATE_NOT_ADVERTISED'); }
        $content = $args['content'] ?? null;
        if (!is_array($content)) { throw new \InvalidArgumentException('FHIR_RESOURCE_REQUIRED'); }
        return $this->connections->request($id, 'runtime', 'POST', '/$validate', $content);
    }

    /** @param array<string, mixed> $args
     * @param array<string, mixed> $project
     * @return array<string, mixed> */
    private function source(string $action, string $projectId, array $args, array $project): array
    {
        $current = $this->project('get', $projectId);
        if ($action === 'import' && (!is_string($args['projectRevision'] ?? null) || $args['projectRevision'] !== $current['revision'])) {
            throw new \DomainException('REVISION_CONFLICT');
        }
        if (isset($args['connectionId'])) {
            $source = $this->connections->definitions(self::identifier($args['connectionId']), 'read', $args);
            $this->provider->execute('artifact.inspect', ['content' => $source['content'], 'project' => $project]);
            if ($action === 'import' && (!is_string($args['expectedSha256'] ?? null) || !hash_equals($source['sha256'], $args['expectedSha256']))) {
                throw new \DomainException('SOURCE_CHANGED');
            }
        } else {
            $source = $this->provider->execute('source.' . $action, array_merge($args, ['project' => $project]));
        }
        if ($action === 'inspect') { return $source; }
        if (($source['kind'] ?? '') === 'resource') {
            $saved = $this->artifacts('save', $projectId, ['path' => $args['path'] ?? null, 'content' => $source['content'],
                'representation' => 'imported', 'format' => 'json', 'provenance' => $source['provenance']], $project);
            $source['saved'] = $saved;
        } elseif (($source['kind'] ?? '') === 'package') {
            $dependency = $source['dependency'];
            $dependencies = $project['dependencies'];
            foreach ($dependencies as $existing) {
                if ($existing['id'] === $dependency['id'] && $existing !== $dependency) { throw new \DomainException('FHIR_DEPENDENCY_CONFLICT'); }
            }
            if (!in_array($dependency, $dependencies, true)) { $dependencies[] = $dependency; }
            unset($project['id']);
            $project['dependencies'] = $dependencies;
            $source['configuration'] = $this->project('update', $projectId, json_encode($project, JSON_THROW_ON_ERROR), $args['projectRevision']);
        } else { throw new \DomainException('SOURCE_RELEASE'); }
        $evidence = $this->record($projectId, 'source.import', ['source' => $source['provenance'], 'kind' => $source['kind']]);
        $source['platformProvenance'] = ['event' => $evidence['subject'], 'hash' => $evidence['hash'], 'actor' => $this->actor->id, 'clinicalApproval' => false];
        return $source;
    }

    /** @param array<string, mixed> $project
     * @param array<string, mixed> $args
     * @return array<string, mixed> */
    private function ig(string $action, string $projectId, array $project, array $args): array
    {
        $id = $project['connections']['ig'] ?? throw new \RuntimeException('FHIR_IG_NOT_CONFIGURED');
        $connection = $this->connections->get($id, 'ig');
        if ($action === 'test') { return $this->connections->test($id); }
        if ($action === 'projects') { return $this->connections->request($id, 'ig', 'GET', '/api/v1/projects'); }
        $target = self::remoteIdentifier($connection['projectId'] ?? null);
        if ($action === 'status') { return $this->connections->request($id, 'ig', 'GET', '/api/v1/projects/' . $target . '/ig'); }
        if (in_array($action, ['build', 'publish'], true)) { throw new \DomainException('FHIR_IG_REVIEW_ON_EXISTING_SERVER_REQUIRED'); }
        if ($action === 'sync') {
            $sha = $args['commitSha'] ?? '';
            if (!is_string($sha) || !preg_match('/^[a-f0-9]{40}$/D', $sha)) { throw new \InvalidArgumentException('FHIR_GIT_EXACT_COMMIT_REQUIRED'); }
            $link = self::remoteIdentifier($connection['linkId'] ?? null);
            $result = $this->connections->request($id, 'ig', 'POST', '/api/v1/projects/' . $target . '/git/' . $link . '/pull', ['commitSha' => $sha]);
            $this->record($projectId, 'ig.sync', ['commitSha' => $sha, 'destination' => $id, 'jobId' => $result['jobId'] ?? null]);
            return $result + ['publication' => 'NOT_REQUESTED', 'distributionAuthority' => $connection['baseUrl']];
        }
        $paths = $args['paths'] ?? [];
        if (!is_array($paths) || $paths === [] || count($paths) > 100) { throw new \InvalidArgumentException('FHIR_SUBMISSION_PATHS_REQUIRED'); }
        $profiles = array_values(array_filter($this->resources($projectId), static fn (array $r): bool => ($r['resourceType'] ?? '') === 'StructureDefinition'));
        $prepared = [];
        foreach ($paths as $path) {
            $artifact = $this->repository->getArtifact($projectId, self::artifactPath($path));
            $validation = $this->provider->execute('artifact.validate', ['project' => $project, 'content' => $artifact['content'], 'profiles' => $profiles]);
            if (($validation['valid'] ?? false) !== true) { throw new \DomainException('FHIR_SUBMISSION_VALIDATION_REQUIRED'); }
            $prepared[] = $artifact;
        }
        $receipts = [];
        foreach ($prepared as $artifact) {
            $receipt = $this->connections->request($id, 'ig', 'POST', '/api/v1/projects/' . $target . '/artifacts/upload',
                ['fileName' => basename($artifact['path']), 'contentType' => str_ends_with($artifact['path'], '.xml') ? 'application/fhir+xml' : 'application/fhir+json', 'content' => $artifact['content']]);
            $receipts[] = ['path' => $artifact['path'], 'revision' => $artifact['revision'], 'sha256' => $artifact['sha256'], 'receipt' => $receipt];
            $this->record($projectId, 'ig.submit', ['destination' => $id, 'sourceRevision' => $artifact['revision'], 'sha256' => $artifact['sha256'], 'artifactVersionId' => $receipt['id'] ?? null]);
        }
        return ['receipts' => $receipts, 'publication' => 'NOT_REQUESTED', 'distributionAuthority' => $connection['baseUrl']];
    }

    /** @return list<array<string, mixed>> */
    private function resources(string $projectId): array
    {
        $result = [];
        foreach ($this->repository->listArtifacts($projectId) as $artifact) {
            if (!str_starts_with($artifact['path'], 'fhir/') || !str_ends_with($artifact['path'], '.json')) { continue; }
            $resource = json_decode($artifact['content'], true);
            if (is_array($resource) && is_string($resource['resourceType'] ?? null)) { $result[] = $resource; }
        }
        return $result;
    }

    /** @param array<string, mixed> $evidence
     * @return array<string, mixed> */
    private function record(string $project, string $action, array $evidence): array
    {
        return $this->audit->append($this->actor->tenant, bin2hex(random_bytes(32)), 0,
            ['project' => $project, 'type' => 'FHIR_OPERATION', 'action' => $action, 'actor' => $this->actor->evidence(), 'evidence' => $evidence]);
    }

    /** @return array<string, mixed> */
    public static function arguments(string $json): array
    {
        if (strlen($json) > 8388608 || !str_starts_with(ltrim($json), '{')) { throw new \InvalidArgumentException('FHIR_ARGUMENTS_OBJECT_REQUIRED'); }
        $data = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($data)) { throw new \InvalidArgumentException('FHIR_ARGUMENTS_OBJECT_REQUIRED'); }
        return $data;
    }

    private static function identifier(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/D', $value)) { throw new \InvalidArgumentException('FHIR_IDENTIFIER_INVALID'); }
        return $value;
    }

    private static function remoteIdentifier(mixed $value): string
    {
        if (!is_string($value) || !preg_match('/^[a-fA-F0-9-]{36}$/D', $value)) { throw new \InvalidArgumentException('FHIR_REMOTE_PROJECT_REQUIRED'); }
        return $value;
    }

    private static function artifactPath(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 220 || !preg_match('~^[A-Za-z0-9][A-Za-z0-9_./-]*$~D', $value)
            || str_contains($value, '..') || str_contains($value, '//') || !preg_match('/\.(json|xml|fsh|yaml|md)$/D', $value)) {
            throw new \InvalidArgumentException('FHIR_ARTIFACT_PATH_INVALID');
        }
        return str_starts_with($value, 'fhir/') ? $value : 'fhir/' . $value;
    }
}
