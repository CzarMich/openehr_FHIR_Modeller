<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Knowledge;

use OpenEHR\Assistant\Apis\CkmClient;
use OpenEHR\Assistant\Domain\Knowledge\CkmSearchProvider;
use OpenEHR\Assistant\Tools\CkmService;
use Psr\Log\LoggerInterface;

/** Reuses the existing CKM mapping/ranking implementation behind the domain port. */
final readonly class ConfiguredCkmSearch implements CkmSearchProvider
{
    public function __construct(private CkmClient $client, private LoggerInterface $logger)
    {
    }

    public function sources(): array
    {
        return $this->client->sources();
    }

    public function search(string $source, string $kind, string $keyword, int $limit, float $timeout): array
    {
        $service = new CkmService($this->client->forSource($source)->withTimeout($timeout), $this->logger);
        return $kind === 'archetype' ? $service->archetypeSearch($keyword, $limit) : $service->templateSearch($keyword, $limit);
    }
}
