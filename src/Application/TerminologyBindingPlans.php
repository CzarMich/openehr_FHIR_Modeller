<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Terminology\BindingPlanner;
use OpenEHR\Assistant\Domain\Terminology\Catalogue\Resource;
use OpenEHR\Assistant\Domain\Terminology\ModelTerminologyInspector;

/** Plans are revision-bound draft evidence; the source model is never written by this service. */
final readonly class TerminologyBindingPlans
{
    public function __construct(private ModelRepository $repository, private AccessPolicy $access,
        private ModelTerminologyInspector $inspector, private BindingPlanner $planner) {}

    /** @return array<string, mixed> */
    public function inspect(string $project, string $path, ?string $revision = null): array
    {
        $artifact = $this->repository->getArtifact($project, $path, $revision);
        if (!is_string($artifact['content'] ?? null)) { throw new \RuntimeException('MODEL_TEXT_FORMAT_REQUIRED'); }
        return ['source' => $this->evidence($artifact), 'inspection' => $this->inspector->inspect($artifact['content'], strtolower(pathinfo($path, PATHINFO_EXTENSION))),
            'clinical_approval' => false, 'model_changed' => false];
    }

    /** @param list<array<string, mixed>> $aliases
     * @return array<string, mixed> */
    public function plan(string $project, string $path, ?string $revision = null, array $aliases = []): array
    {
        $aliases = $this->planner->aliases($aliases);
        $source = $this->inspect($project, $path, $revision); $catalogue = []; $manifest = []; $findings = []; $bytes = 0; $concepts = 0;
        foreach ($this->repository->listArtifacts($project) as $artifact) {
            if (!str_starts_with($artifact['path'], 'terminology/catalogue/')) { continue; }
            $bytes += strlen($artifact['content']); $manifest[] = $this->evidence($artifact);
            if (count($manifest) > 100 || $bytes > 10485760) { throw new \RuntimeException('BINDING_CATALOGUE_LIMIT_EXCEEDED'); }
            try { $resource = Resource::fromArtifact($artifact); }
            catch (\InvalidArgumentException|\JsonException) {
                $findings[] = ['severity' => 'error', 'code' => 'INVALID_TERMINOLOGY_RECORD', 'location' => $artifact['path'],
                    'message' => 'A catalogue record is invalid; candidate coverage is incomplete.', 'evidence' => $this->evidence($artifact),
                    'remediation' => 'Repair the record through a conditional draft save and regenerate the plan.'];
                continue;
            }
            $concepts += count($resource->data['concepts'] ?? []);
            if ($concepts > 50000) { throw new \RuntimeException('BINDING_PLAN_CONCEPT_LIMIT_EXCEEDED'); }
            $catalogue[] = ['resource' => $resource, 'evidence' => $this->evidence($artifact)
                + array_intersect_key($resource->data, array_flip(['kind', 'canonical', 'version', 'source']))];
        }
        usort($manifest, static fn (array $a, array $b): int => $a['path'] <=> $b['path']);
        usort($catalogue, static fn (array $a, array $b): int => $a['evidence']['path'] <=> $b['evidence']['path']);
        usort($findings, static fn (array $a, array $b): int => $a['location'] <=> $b['location']);
        $analysis = $this->planner->plan($source['inspection'], $catalogue, $aliases);
        $analysis['findings'] = array_merge($analysis['findings'], $findings);
        $analysis['catalogue_complete'] = $findings === [];
        $plan = ['schema' => 1, 'algorithm' => 'explicit-membership-v1', 'source' => $source['source'],
            'catalogue_snapshot' => $manifest, 'catalogue_fingerprint' => $this->hash($manifest), 'analysis' => $analysis];
        $this->encode($plan);
        return $plan;
    }

    /** Recompute server-side; clients cannot submit a pre-approved or fabricated plan.
     * @param list<array<string, mixed>> $aliases
     * @return array<string, mixed> */
    public function save(string $project, string $path, string $modelRevision, array $aliases = [], ?string $expectedRevision = null): array
    {
        $this->access->assertModelWrite();
        $current = $this->repository->getArtifact($project, $path);
        if ($current['revision'] !== $modelRevision) { throw new \RuntimeException('MODEL_REVISION_CONFLICT'); }
        $plan = $this->plan($project, $path, $modelRevision, $aliases);
        // A concurrent later model/catalogue edit cannot rewrite this evidence; readers recompute freshness.
        $artifact = $this->repository->saveArtifact($project, self::path($path), $this->encode($plan),
            ['kind' => 'terminology_binding_plan', 'schema' => 1, 'source_path' => $path, 'source_revision' => $modelRevision], $expectedRevision);
        return ['artifact' => $this->evidence($artifact), 'plan' => $plan, 'clinical_approval' => false, 'model_changed' => false];
    }

    /** Compare stored evidence to the current deterministic analysis, including newly added catalogue editions.
     * @return array<string, mixed> */
    public function get(string $project, string $path, ?string $revision = null): array
    {
        $artifact = $this->repository->getArtifact($project, self::path($path), $revision);
        if (strlen($artifact['content']) > 2097152) { throw new \RuntimeException('INVALID_BINDING_PLAN'); }
        $plan = json_decode($artifact['content'], true, 64, JSON_THROW_ON_ERROR);
        if (!is_array($plan) || ($plan['schema'] ?? null) !== 1 || ($plan['source']['path'] ?? null) !== $path
            || !is_array($plan['analysis']['aliases'] ?? null)) { throw new \RuntimeException('INVALID_BINDING_PLAN'); }
        $aliases = $this->planner->aliases($plan['analysis']['aliases']);
        $freshness = ['status' => 'NOT_EXECUTED', 'matches_current_analysis' => null];
        try {
            $current = $this->plan($project, $path, null, $aliases);
            $matches = hash_equals($this->hash($plan), $this->hash($current));
            $freshness = ['status' => $matches ? 'CURRENT' : 'STALE_OR_MODIFIED', 'matches_current_analysis' => $matches,
                'source_matches' => ($plan['source'] ?? null) === $current['source'],
                'catalogue_matches' => ($plan['catalogue_snapshot'] ?? null) === $current['catalogue_snapshot']];
        } catch (\RuntimeException|\InvalidArgumentException) {
            $freshness['reason'] = 'The current model or catalogue cannot be evaluated. Regenerate after resolving the repository or inspection finding.';
        }
        return ['artifact' => $this->evidence($artifact), 'plan' => $plan, 'freshness' => $freshness,
            'clinical_approval' => false, 'model_changed' => false, 'release_ready' => false,
            'evidence_trust' => 'Repository content is not a signed attestation or a human approval.'];
    }

    public static function path(string $modelPath): string { return 'terminology/binding-plans/' . hash('sha256', $modelPath) . '.json'; }

    /** @param array<string, mixed> $artifact
     * @return array<string, mixed> */
    private function evidence(array $artifact): array
    {
        return array_intersect_key($artifact, array_flip(['path', 'revision', 'sha256', 'status']));
    }

    /** @param array<mixed> $value */
    private function hash(array $value): string { return hash('sha256', json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); }

    /** @param array<string, mixed> $plan */
    private function encode(array $plan): string
    {
        $encoded = json_encode($plan, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
        if (strlen($encoded) > 2097152) { throw new \RuntimeException('BINDING_PLAN_TOO_LARGE'); }
        return $encoded;
    }
}
