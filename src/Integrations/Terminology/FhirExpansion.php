<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Integrations\Terminology;

/** Conservative coverage evidence. A page is not automatically an entire value set. */
final class FhirExpansion
{
    /** @param array<string, mixed> $resource
     * @return array<string, mixed> */
    public static function inspect(array $resource, int $requestedOffset, int $requestedCount): array
    {
        $expansion = $resource['expansion'] ?? null;
        if (!is_array($expansion)) {
            throw new \UnexpectedValueException('Missing expansion.');
        }
        $items = $expansion['contains'] ?? [];
        if (!is_array($items) || !array_is_list($items)) {
            throw new \UnexpectedValueException('Invalid expansion members.');
        }
        $total = $expansion['total'] ?? null;
        $offset = $expansion['offset'] ?? null;
        if (($total !== null && (!is_int($total) || $total < 0)) || ($offset !== null && (!is_int($offset) || $offset < 0))) {
            throw new \UnexpectedValueException('Invalid expansion pagination.');
        }
        $nested = false;
        $remaining = 50000;
        $count = self::members($items, $nested, $remaining);
        if (!$nested && $total !== null && ($offset ?? 0) + $count > $total && $count > 0) {
            throw new \UnexpectedValueException('Expansion exceeds its reported total.');
        }
        $unclosed = false;
        foreach ([$resource['extension'] ?? [], $expansion['extension'] ?? []] as $extensions) {
            if (!is_array($extensions)) {
                throw new \UnexpectedValueException('Invalid expansion extensions.');
            }
            foreach ($extensions as $extension) {
                if (is_array($extension) && ($extension['url'] ?? '') === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed'
                    && ($extension['valueBoolean'] ?? false) !== false) {
                    $unclosed = true;
                }
            }
        }
        // Missing offset does not confirm that a nonzero requested page was honoured.
        $pageConfirmed = !$nested && ($offset !== null ? $offset === $requestedOffset : $requestedOffset === 0);
        $whole = $pageConfirmed && ($offset ?? 0) === 0 && $total !== null && $count === $total && !$unclosed;
        return ['requested_offset' => $requestedOffset, 'requested_count' => $requestedCount,
            'returned_offset' => $offset, 'total' => $total, 'returned_codes' => $count,
            'hierarchical' => $nested, 'unclosed' => $unclosed, 'page_confirmed' => $pageConfirmed,
            'complete' => $whole, 'has_more' => $pageConfirmed && $total !== null ? ($offset ?? 0) + $count < $total : null];
    }

    /** @param list<mixed> $items */
    private static function members(array $items, bool &$nested, int &$remaining, int $depth = 0): int
    {
        if ($depth > 16) {
            throw new \UnexpectedValueException('Expansion nesting exceeded.');
        }
        $count = 0;
        foreach ($items as $item) {
            if (--$remaining < 0 || !is_array($item)) {
                throw new \UnexpectedValueException('Invalid expansion member.');
            }
            foreach (['system', 'version', 'code', 'display'] as $key) {
                if (isset($item[$key]) && !is_string($item[$key])) {
                    throw new \UnexpectedValueException('Invalid expansion coding.');
                }
            }
            if (isset($item['code'])) {
                $count++;
            }
            if (isset($item['contains'])) {
                $nested = true;
                if (!is_array($item['contains']) || !array_is_list($item['contains'])) {
                    throw new \UnexpectedValueException('Invalid nested expansion.');
                }
                $count += self::members($item['contains'], $nested, $remaining, $depth + 1);
            }
        }
        return $count;
    }
}
