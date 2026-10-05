<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Auth\AccessPolicy;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Governance\AuditStore;
use OpenEHR\Assistant\Domain\Repository\ModelRepository;
use OpenEHR\Assistant\Domain\Repository\OriginalContent;
use OpenEHR\Assistant\Domain\Repository\OriginalRepository;
use OpenEHR\Assistant\Validation\ArtifactTypeInspector;

/** Resumable import: protected intent, immutable native bytes, then protected storage receipt. */
final readonly class ModelImports
{
    public function __construct(
        private ModelRepository $repository,
        private AuditStore $audit,
        private Actor $actor,
        private AccessPolicy $access,
        private ArtifactTypeInspector $inspector
    ) {
    }

    /** Inspection never writes, fetches URLs, extracts archives or certifies clinical meaning.
     * @return array<string, mixed> */
    public function inspect(string $filename, string $contentBase64, string $declaredType = 'UNKNOWN'): array
    {
        OriginalContent::path(str_repeat('0', 64), $filename);
        return $this->inspector->inspect(self::decode($contentBase64), $filename, $declaredType);
    }

    /** Caller claims remain unverified, distinct from the transport actor and ledger timestamp.
     * @param array<string, mixed> $sourceClaims
     * @return array<string, mixed> */
    public function import(string $project, string $filename, string $contentBase64, string $declaredType = 'UNKNOWN', array $sourceClaims = []): array
    {
        $this->access->assertModelWrite();
        if (!$this->repository instanceof OriginalRepository) {
            throw new \RuntimeException('IMPORT_STORAGE_UNSUPPORTED');
        }
        if (($this->repository->getProject($project)['status'] ?? null) !== 'ACTIVE') {
            throw new \RuntimeException('PROJECT_ARCHIVED');
        }
        $inspection = $this->inspect($filename, $contentBase64, $declaredType);
        $claims = self::claims($sourceClaims);
        $identity = ['schema_version' => 1, 'project' => $project, 'filename' => $filename,
            'sha256' => $inspection['source_sha256'], 'declared_type' => $declaredType, 'claims' => $claims,
            'requester' => ['id' => $this->actor->id, 'tenant' => $this->actor->tenant]];
        $id = hash('sha256', "model-import/1\n" . json_encode($identity, JSON_THROW_ON_ERROR));
        $path = OriginalContent::path($id, $filename);
        $events = $this->audit->events($this->actor->tenant, $id);
        if ($events === []) {
            try {
                $this->audit->append($this->actor->tenant, $id, 0, ['type' => 'MODEL_IMPORT_REQUESTED', 'project' => $project,
                    'identity' => $identity, 'actor' => $this->actor->evidence(), 'path' => $path, 'inspection' => $inspection,
                    'claim_assurance' => 'CALLER_DECLARED', 'source_system_verified' => false]);
            } catch (\RuntimeException $error) {
                if ($error->getMessage() !== 'GOVERNANCE_REVISION_CONFLICT') {
                    throw $error;
                }
            }
            $events = $this->audit->events($this->actor->tenant, $id);
        }
        if (($events[0]['identity'] ?? null) !== $identity || ($events[0]['type'] ?? null) !== 'MODEL_IMPORT_REQUESTED') {
            throw new \RuntimeException('IMPORT_IDENTITY_CONFLICT');
        }
        if (count($events) === 1) {
            try {
                $stored = $this->repository->storeOriginal(
                    $project,
                    $path,
                    self::decode($contentBase64),
                    ['kind' => 'original_source', 'import_subject' => $id]
                );
            } catch (\RuntimeException $error) {
                if ($error->getMessage() !== 'IMPORT_ORIGINAL_EXISTS') {
                    throw $error;
                }
                // Recovery after a storage success/receipt failure. Never trust repository actor metadata.
                $stored = $this->repository->getArtifact($project, $path);
            }
            if (!hash_equals($identity['sha256'], hash('sha256', OriginalContent::bytes($stored)))) {
                throw new \RuntimeException('IMPORT_ORIGINAL_INTEGRITY_FAILED');
            }
            try {
                $this->audit->append($this->actor->tenant, $id, 1, ['type' => 'MODEL_IMPORT_STORED', 'project' => $project,
                    'actor' => $this->actor->evidence(), 'source' => ['project' => $project, 'path' => $path,
                        'revision' => $stored['revision'], 'sha256' => $identity['sha256']],
                    'size_bytes' => $stored['size_bytes'], 'clinical_approval' => false]);
            } catch (\RuntimeException $error) {
                if ($error->getMessage() !== 'GOVERNANCE_REVISION_CONFLICT') {
                    throw $error;
                }
            }
        }
        return $this->provenance($project, $id);
    }

    /** Only the protected ledger establishes platform provenance. External Git mutations are detected.
     * @return array<string, mixed> */
    public function provenance(string $project, string $importId): array
    {
        $this->repository->getProject($project);
        $events = $this->audit->events($this->actor->tenant, $importId);
        $intent = $events[0] ?? [];
        if (($intent['type'] ?? null) !== 'MODEL_IMPORT_REQUESTED' || ($intent['project'] ?? null) !== $project) {
            throw new \RuntimeException('IMPORT_NOT_FOUND');
        }
        $receipt = $events[1] ?? null;
        if (count($events) > 2 || ($receipt !== null && $receipt['type'] !== 'MODEL_IMPORT_STORED')) {
            throw new \RuntimeException('IMPORT_AUDIT_INTEGRITY_FAILED');
        }
        $integrity = 'NOT_STORED';
        if ($receipt !== null) {
            $source = $receipt['source'];
            $pinned = $this->repository->getArtifact($project, $source['path'], $source['revision']);
            $current = $this->repository->getArtifact($project, $source['path']);
            foreach ([$pinned, $current] as $artifact) {
                if (($artifact['status'] ?? '') === 'DELETED' || !hash_equals($source['sha256'], hash('sha256', OriginalContent::bytes($artifact)))
                    || $artifact['revision'] !== $source['revision']) {
                    throw new \RuntimeException('IMPORT_ORIGINAL_INTEGRITY_FAILED');
                }
            }
            $integrity = 'VERIFIED';
        }
        return ['schema_version' => 1, 'import_id' => $importId, 'status' => $receipt === null ? 'STORAGE_PENDING' : 'STORED_UNREVIEWED',
            'original' => $receipt['source'] ?? ['project' => $project, 'path' => $intent['path'], 'sha256' => $intent['identity']['sha256']],
            'source_claims' => $intent['identity']['claims'], 'claim_assurance' => 'CALLER_DECLARED', 'source_system_verified' => false,
            'importing_actor' => $intent['actor'], 'requested_at' => $intent['timestamp'], 'stored_at' => $receipt['timestamp'] ?? null,
            'inspection' => $intent['inspection'], 'original_integrity' => $integrity, 'clinical_approval' => false,
            'validation' => 'NOT_EXECUTED', 'events' => $events];
    }

    public static function decode(string $encoded): string
    {
        if (strlen($encoded) > 2796204) {
            throw new \InvalidArgumentException('ARTIFACT_TOO_LARGE');
        }
        $bytes = base64_decode($encoded, true);
        if ($bytes === false || $bytes === '' || strlen($bytes) > OriginalContent::MAX_BYTES || base64_encode($bytes) !== $encoded) {
            throw new \InvalidArgumentException('IMPORT_BASE64_INVALID');
        }
        return $bytes;
    }

    /** @param array<string, mixed> $claims
     * @return array<string, string> */
    private static function claims(array $claims): array
    {
        $allowed = ['source_system', 'tool_version', 'external_identifier', 'external_revision', 'external_status', 'exported_at', 'licence', 'copyright'];
        if (array_diff(array_keys($claims), $allowed) !== []) {
            throw new \InvalidArgumentException('IMPORT_SOURCE_CLAIMS_INVALID');
        }
        foreach ($claims as $key => $value) {
            if (!is_string($value) || $value === '' || strlen($value) > 1000 || preg_match('//u', $value) !== 1
                || preg_match('/[\x00-\x1f\x7f]/', $value)) {
                throw new \InvalidArgumentException('IMPORT_SOURCE_CLAIMS_INVALID');
            }
            if ($key === 'exported_at' && (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/D', $value)
                || date_create_immutable($value) === false || date_get_last_errors() !== false)) {
                throw new \InvalidArgumentException('IMPORT_SOURCE_CLAIMS_INVALID');
            }
        }
        $claims += ['source_system' => 'UNKNOWN'];
        ksort($claims);
        return $claims;
    }
}
