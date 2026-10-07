<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Fhir;

use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Domain\Standards\StandardsProvider;
use OpenEHR\Assistant\Validation\ModelValidator;

/** An adapter around the unchanged openEHR implementation. */
final readonly class OpenEhrStandardsProvider implements StandardsProvider
{
    public function __construct(private OpenEhrEngine $engine, private ModelValidator $validator) {}
    public function standard(): string { return 'openEHR'; }
    public function execute(string $operation, array $parameters): array
    {
        return match ($operation) {
            'artifact.inspect' => $this->engine->inspect($parameters['content'], $parameters['format'], $parameters['dependencies'] ?? []),
            'artifact.validate' => $this->engine->validate($parameters['content'], $parameters['format'], $parameters['dependencies'] ?? []),
            'artifact.diff' => $this->validator->diff($parameters['before'], $parameters['after']),
            default => throw new \InvalidArgumentException('OPENEHR_OPERATION_UNSUPPORTED'),
        };
    }
}
