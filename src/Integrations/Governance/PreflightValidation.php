<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Governance;

use OpenEHR\Assistant\Domain\Governance\ValidationProvider;
use OpenEHR\Assistant\Domain\Modelling\QualityPipeline;

/** Until a qualified full pipeline is configured, missing stages prevent release. */
final readonly class PreflightValidation implements ValidationProvider
{
    public function __construct(private QualityPipeline $pipeline) {}
    public function evaluate(string $content, string $format): array { return $this->pipeline->run($content, $format); }
}
