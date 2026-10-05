<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Terminology;

/** Preserve repeated parameters and nested parts; reject ambiguous singleton results. */
final readonly class FhirParameters
{
    /** @var list<array<string, mixed>> */
    public array $parameters;

    /** @param array<string, mixed> $resource */
    public function __construct(array $resource)
    {
        $parameters = $resource['parameter'] ?? [];
        if (!is_array($parameters) || !array_is_list($parameters)) {
            throw new \UnexpectedValueException('Invalid FHIR Parameters.');
        }
        $remaining = 20000;
        self::validate($parameters, 0, $remaining);
        $this->parameters = $parameters;
    }

    /** @param list<mixed> $parameters */
    private static function validate(array $parameters, int $depth, int &$remaining): void
    {
        if ($depth > 16) {
            throw new \UnexpectedValueException('FHIR parameter depth exceeded.');
        }
        foreach ($parameters as $parameter) {
            if (--$remaining < 0 || !is_array($parameter) || !is_string($parameter['name'] ?? null) || $parameter['name'] === '') {
                throw new \UnexpectedValueException('Invalid FHIR parameter.');
            }
            $values = array_filter(array_keys($parameter), static fn ($key): bool => is_string($key) && str_starts_with($key, 'value'));
            $choices = count($values) + (array_key_exists('part', $parameter) ? 1 : 0) + (array_key_exists('resource', $parameter) ? 1 : 0);
            if ($choices !== 1) {
                throw new \UnexpectedValueException('Ambiguous FHIR parameter value.');
            }
            if (array_key_exists('part', $parameter)) {
                if (!is_array($parameter['part']) || !array_is_list($parameter['part']) || $parameter['part'] === []) {
                    throw new \UnexpectedValueException('Invalid FHIR parameter parts.');
                }
                self::validate($parameter['part'], $depth + 1, $remaining);
            }
        }
    }

    /** @return list<array<string, mixed>> */
    public function named(string $name): array
    {
        return array_values(array_filter($this->parameters, static fn (array $parameter): bool => $parameter['name'] === $name));
    }

    public function one(string $name, string $type): mixed
    {
        $items = $this->named($name);
        if (count($items) > 1 || ($items !== [] && !array_key_exists('value' . $type, $items[0]))) {
            throw new \UnexpectedValueException('Ambiguous or incorrectly typed FHIR singleton.');
        }
        return $items[0]['value' . $type] ?? null;
    }

    /** Legacy singleton keys remain scalar; repeated values and parts remain lists.
     * @return array<string, mixed> */
    public function values(): array
    {
        $values = [];
        foreach ($this->parameters as $parameter) {
            $value = $parameter['part'] ?? $parameter['resource'] ?? null;
            foreach ($parameter as $key => $item) {
                if (str_starts_with((string) $key, 'value')) {
                    $value = $item;
                }
            }
            $values[$parameter['name']][] = $value;
        }
        foreach ($values as $name => $items) {
            if (count($items) === 1 && !in_array($name, ['designation', 'property', 'match'], true)) {
                $values[$name] = $items[0];
            }
        }
        return $values;
    }
}
