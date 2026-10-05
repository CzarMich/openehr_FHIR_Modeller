<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\LocalOperations;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;
use OpenEHR\Assistant\Domain\Terminology\MappingProvider;
use OpenEHR\Assistant\Domain\Terminology\TerminologyProvider;

/** Project-scoped catalogue shared by protocol adapters. Repository revisions remain authoritative. */
final readonly class TerminologyCatalogue
{
    public function __construct(private ModelRepository $repository, private AccessPolicy $access,
        private TerminologyProvider $external, private MappingProvider $mappings, private LocalOperations $local) {}

    /** @param array<string, mixed> $record
     * @return array<string, mixed> */
    public function save(string $project, array $record, ?string $expectedRevision = null): array
    {
        $this->access->assertModelWrite(); $resource = new Resource($record);
        $artifact = $this->repository->saveArtifact($project, $resource->path(),
            json_encode($resource->data, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n",
            ['kind' => 'terminology_catalogue', 'schema' => 1, 'resource_kind' => $record['kind'], 'canonical' => $record['canonical'], 'version' => $record['version']], $expectedRevision);
        return $this->entry($resource, $artifact);
    }

    /** @return array<string, mixed> */
    public function get(string $project, string $kind, string $canonical, ?string $version = null, ?string $revision = null): array
    {
        $this->kind($kind); Resource::canonical($canonical);
        if ($revision !== null && $version === null) { throw new \InvalidArgumentException('HISTORICAL_RESOURCE_VERSION_REQUIRED'); }
        if ($version !== null) {
            Resource::text($version, 200);
            $path = 'terminology/catalogue/' . $kind . '/' . Resource::identity($kind, $canonical, $version) . '.json';
            $artifact = $this->repository->getArtifact($project, $path, $revision);
            return $this->entry(Resource::fromArtifact($artifact), $artifact);
        }
        $scan = $this->search($project, $kind, $canonical, null, 100);
        if ($scan['findings'] !== []) { throw new \RuntimeException('CATALOGUE_HAS_INVALID_RECORDS'); }
        if ($scan['total'] !== 1) { throw new \RuntimeException($scan['total'] === 0 ? 'TERMINOLOGY_RESOURCE_NOT_FOUND' : 'AMBIGUOUS_TERMINOLOGY_VERSION'); }
        $match = $scan['items'][0];
        return $this->get($project, $kind, $canonical, $match['resource']['version'], $match['revision']);
    }

    /** @return array<string, mixed> */
    public function search(string $project, ?string $kind = null, ?string $canonical = null, ?string $query = null,
        int $count = 50, int $offset = 0): array
    {
        if ($kind !== null) { $this->kind($kind); }
        if ($canonical !== null) { Resource::canonical($canonical); }
        if ($query !== null) { Resource::text($query, 500); }
        if ($count < 1 || $count > 100 || $offset < 0 || $offset > 10000) { throw new \InvalidArgumentException('INVALID_CATALOGUE_PAGE'); }
        $items = []; $findings = []; $examined = 0;
        foreach ($this->repository->listArtifacts($project) as $artifact) {
            if (!str_starts_with($artifact['path'], 'terminology/catalogue/')) { continue; }
            if (++$examined > 1000) { throw new \RuntimeException('CATALOGUE_SCAN_LIMIT_EXCEEDED'); }
            try { $resource = Resource::fromArtifact($artifact); }
            catch (\InvalidArgumentException|\JsonException) {
                $findings[] = ['severity' => 'error', 'code' => 'INVALID_TERMINOLOGY_RECORD', 'location' => $artifact['path'],
                    'message' => 'The stored terminology record does not satisfy the catalogue schema or identity.',
                    'evidence' => ['revision' => $artifact['revision']], 'remediation' => 'Read the recorded revision and repair it through a conditional draft save.'];
                continue;
            }
            $data = $resource->data;
            if (($kind !== null && $kind !== $data['kind']) || ($canonical !== null && $canonical !== $data['canonical'])) { continue; }
            if ($query !== null && !str_contains(mb_convert_case($data['name'] . '\n' . ($data['description'] ?? ''), MB_CASE_FOLD, 'UTF-8'), mb_convert_case($query, MB_CASE_FOLD, 'UTF-8'))) { continue; }
            $entry = $this->entry($resource, $artifact);
            $entry['resource'] = array_intersect_key($data, array_flip(['kind', 'canonical', 'version', 'name', 'source', 'language']));
            $entry['concept_count'] = count($data['concepts'] ?? []); $entry['mapping_count'] = count($data['mappings'] ?? []);
            $items[] = $entry;
        }
        usort($items, static fn (array $a, array $b): int => [$a['resource']['kind'], $a['resource']['canonical'], $a['resource']['version']]
            <=> [$b['resource']['kind'], $b['resource']['canonical'], $b['resource']['version']]);
        return ['items' => array_slice($items, $offset, $count), 'total' => count($items), 'offset' => $offset,
            'complete' => $findings === [] && $offset === 0 && $count >= count($items), 'findings' => $findings];
    }

    /** @return array<string, mixed> */
    public function lookup(string $project, string $system, string $code, ?string $version = null, ?string $language = null): array
    {
        $entry = $this->get($project, 'code_system', $system, $version); $resource = new Resource($entry['resource']);
        $result = $resource->data['source'] === 'local' ? $this->local->lookup($resource, $code, $language)
            : $this->external->lookup($system, $code, $resource->data['version'], $language);
        return $this->evidence($result, $entry);
    }

    /** @return array<string, mixed> */
    public function validate(string $project, string $system, string $code, ?string $valueSet = null,
        ?string $version = null, ?string $codeSystemVersion = null, ?string $display = null, ?string $language = null): array
    {
        if ($valueSet === null && $version !== null && $codeSystemVersion !== null && $version !== $codeSystemVersion) {
            throw new \InvalidArgumentException('CONFLICTING_CODE_SYSTEM_VERSIONS');
        }
        $entry = $this->get($project, $valueSet === null ? 'code_system' : 'value_set', $valueSet ?? $system,
            $valueSet === null ? ($version ?? $codeSystemVersion) : $version);
        $resource = new Resource($entry['resource']);
        $result = $resource->data['source'] === 'local' ? $this->local->validate($resource, $system, $code, $codeSystemVersion, $display, $language)
            : $this->external->validateCode($system, $code, $valueSet, $resource->data['version'], $codeSystemVersion, $display, $language);
        return $this->evidence($result, $entry);
    }

    /** @return array<string, mixed> */
    public function expand(string $project, string $valueSet, ?string $version = null, int $count = 50,
        int $offset = 0, ?string $language = null, ?string $filter = null): array
    {
        $entry = $this->get($project, 'value_set', $valueSet, $version); $resource = new Resource($entry['resource']);
        $result = $resource->data['source'] === 'local' ? $this->local->expand($resource, $count, $offset, $language, $filter)
            : $this->external->expand($valueSet, $resource->data['version'], $count, $offset, $language, $filter);
        return $this->evidence($result, $entry);
    }

    /** @return array<string, mixed> */
    public function translate(string $project, string $conceptMap, string $system, string $code, ?string $version = null,
        ?string $codeSystemVersion = null, ?string $targetSystem = null): array
    {
        $entry = $this->get($project, 'concept_map', $conceptMap, $version); $resource = new Resource($entry['resource']);
        $result = $resource->data['source'] === 'local' ? $this->local->translate($resource, $system, $code, $codeSystemVersion, $targetSystem)
            : $this->mappings->translate($conceptMap, $system, $code, $resource->data['version'], $codeSystemVersion, null, null, $targetSystem);
        return $this->evidence($result, $entry);
    }

    /** @param array<string, mixed> $artifact
     * @return array<string, mixed> */
    private function entry(Resource $resource, array $artifact): array
    {
        return ['resource' => $resource->data, 'path' => $artifact['path'], 'revision' => $artifact['revision'],
            'sha256' => $artifact['sha256'], 'status' => $artifact['status'], 'updated_at' => $artifact['updated_at'], 'clinical_approval' => false];
    }

    /** @param array<string, mixed> $result
     * @param array<string, mixed> $entry
     * @return array<string, mixed> */
    private function evidence(array $result, array $entry): array
    {
        $result['catalogue_evidence'] = ['path' => $entry['path'], 'revision' => $entry['revision'], 'sha256' => $entry['sha256'],
            'canonical' => $entry['resource']['canonical'], 'version' => $entry['resource']['version'], 'status' => $entry['status']];
        $result['clinical_approval'] = false;
        return $result;
    }

    private function kind(string $kind): void
    {
        if (!in_array($kind, Resource::KINDS, true)) { throw new \InvalidArgumentException('INVALID_TERMINOLOGY_KIND'); }
    }
}
