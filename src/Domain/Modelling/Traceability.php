<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Domain\Modelling;

final class Traceability
{
    /** Explicit links are modelling assertions, never inferred clinical or validation coverage.
     *
     * @param list<array<string, mixed>> $requirements
     *
     * @param list<array<string, mixed>> $links
     *
     * @param list<string> $existingArtifacts
     *
     * @return array<string, mixed>
     */
    public function coverage(array $requirements, array $links, array $existingArtifacts): array
    {
        $rows = [];
        $counts = ['fully_modelled' => 0, 'partially_modelled' => 0, 'unresolved' => 0, 'intentionally_excluded' => 0];
        $seen = [];
        foreach ($requirements as $requirement) {
            $id = $requirement['id'] ?? null;
            if (!is_string($id) || $id === '' || isset($seen[$id])) {
                throw new \InvalidArgumentException('Requirements need unique non-empty identifiers.');
            }
            $seen[$id] = true;
            $matches = array_values(array_filter($links, static fn (array $link): bool => ($link['requirement'] ?? null) === $id));
            $validLinks = array_values(array_filter($matches, static fn (array $link): bool =>
                in_array($link['artifact'] ?? '', $existingArtifacts, true) && is_string($link['node'] ?? null) && $link['node'] !== ''
                && is_string($link['rationale'] ?? null) && $link['rationale'] !== ''));
            $excluded = ($requirement['status'] ?? '') === 'excluded' && !empty($requirement['exclusion_reason']);
            $full = count($validLinks) > 0 && count($validLinks) === count($matches)
                && !in_array(false, array_map(static fn (array $link): bool => ($link['coverage'] ?? '') === 'full', $validLinks), true);
            $status = $excluded ? 'intentionally_excluded' : ($full ? 'fully_modelled' : ($validLinks !== [] ? 'partially_modelled' : 'unresolved'));
            ++$counts[$status];
            $rows[] = ['requirement' => $id, 'status' => $status, 'links' => $validLinks, 'invalid_links' => count($matches) - count($validLinks)];
        }
        $denominator = count($requirements) - $counts['intentionally_excluded'];
        return ['counts' => $counts, 'total' => count($requirements),
            'coverage_percent' => $denominator > 0 ? round(100 * $counts['fully_modelled'] / $denominator, 2) : null,
            'requirements' => $rows, 'basis' => 'explicit modeller traceability assertions with existing artefact references; node semantics and test execution not verified'];
    }
}
