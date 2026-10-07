<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Apis;

use OpenEHR\Assistant\Domain\Modelling\ArchetypeSource;
use OpenEHR\Assistant\Tools\CkmService;
use OpenEHR\Assistant\Validation\ModelValidator;

final readonly class CkmArchetypeSource implements ArchetypeSource
{
    public function __construct(private CkmService $service, private CkmClient $client)
    {
    }

    public function fetch(string $identifier, ?string $source = null): array
    {
        $text = (string) $this->service->archetypeGet($identifier, 'adl', $source)->text;
        $content = preg_replace('/^```[^\n]*\n|\n```$/', '', $text) ?? '';
        if (!preg_match('/\barchetype\b[\s\S]*?\b(openEHR-([^\s]+))\s/', $content, $match)
            || !preg_match(ModelValidator::ARCHETYPE_ID, $match[1])
            || !preg_match('/^openEHR-[A-Z_]+-([A-Z_]+)\./', $match[1], $class)) {
            throw new \RuntimeException('CKM_INVALID_RESPONSE: retrieved content has no supported archetype declaration.');
        }
        $name = $source ?? $this->client->defaultSource();
        return ['id' => $match[1], 'rm_class' => $class[1], 'content' => $content,
            'provenance' => ['kind' => 'live_ckm', 'ckm' => $name, 'source' => $this->client->sources()[$name],
                'requested_identifier' => $identifier, 'retrieved_at' => gmdate(DATE_ATOM), 'sha256' => hash('sha256', $content)]];
    }
}
