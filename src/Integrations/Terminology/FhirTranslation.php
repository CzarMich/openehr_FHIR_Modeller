<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Terminology;

final class FhirTranslation
{
    /** @param array<string, string|int|null> $request
     * @return array<string, mixed> */
    public static function inspect(FhirParameters $parameters, bool $found, array $request): array
    {
        $matches = []; $candidates = [];
        $relations = ['relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact', 'unmatched', 'disjoint'];
        foreach ($parameters->named('match') as $match) {
            if (!is_array($match['part'] ?? null)) {
                throw new \UnexpectedValueException('Invalid translation match.');
            }
            $parts = new FhirParameters(['parameter' => $match['part']]);
            $relation = $parts->one('equivalence', 'Code');
            $coding = $parts->one('concept', 'Coding');
            if (!in_array($relation, $relations, true)) {
                throw new \UnexpectedValueException('Unsupported translation equivalence.');
            }
            $positive = !in_array($relation, ['unmatched', 'disjoint'], true);
            if ($coding !== null && (!is_array($coding) || !is_string($coding['system'] ?? null) || $coding['system'] === ''
                || !is_string($coding['code'] ?? null) || $coding['code'] === '')) {
                throw new \UnexpectedValueException('Invalid translation coding.');
            }
            foreach (['version', 'display'] as $field) {
                if (is_array($coding) && isset($coding[$field]) && !is_string($coding[$field])) {
                    throw new \UnexpectedValueException('Invalid translation coding field.');
                }
            }
            if ($positive && $coding === null) {
                throw new \UnexpectedValueException('Translation lacks target coding.');
            }
            if ($positive && isset($request['targetsystem']) && $coding['system'] !== $request['targetsystem']) {
                throw new \UnexpectedValueException('Translation target system mismatch.');
            }
            $item = ['equivalence' => $relation, 'concept' => $coding, 'source' => $parts->one('source', 'Uri'),
                'parts' => $match['part'], 'requires_review' => true];
            $matches[] = $item;
            if ($positive) {
                $candidates[] = $item;
            }
        }
        if ($found !== ($candidates !== [])) {
            throw new \UnexpectedValueException('Inconsistent translation result.');
        }
        return ['mapping_found' => $found, 'matches' => $matches, 'candidates' => $candidates,
            'requires_review' => true, 'applied' => false];
    }
}
