<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Application;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Knowledge\CkmSearchProvider;

/** Bounded deterministic aggregation. Source identities and revisions never collapse. */
final readonly class FederatedCkmSearch
{
    public function __construct(private CkmSearchProvider $provider, private Settings $settings)
    {
    }

    /** @param array<mixed> $sources
     * @return array<string, mixed> */
    public function search(string $kind, string $keyword, array $sources = [], int $maxResults = 20): array
    {
        if (!in_array($kind, ['archetype', 'template'], true) || trim($keyword) === '' || strlen($keyword) > 2000
            || !mb_check_encoding($keyword, 'UTF-8') || mb_strlen($keyword, 'UTF-8') > 500 || preg_match('/[\x00-\x1f\x7f]/', $keyword) || $maxResults < 1 || $maxResults > 50
            || !array_is_list($sources) || count($sources) > 8 || count(array_unique($sources, SORT_REGULAR)) !== count($sources)) {
            throw new \InvalidArgumentException('INVALID_CKM_FEDERATED_QUERY');
        }
        $configured = $this->provider->sources();
        $sources = $sources === [] ? array_keys($configured) : $sources;
        if (count($sources) > 8 || $sources === []) {
            throw new \InvalidArgumentException('SELECT_ONE_TO_EIGHT_CKM_SOURCES');
        }
        foreach ($sources as $source) {
            if (!is_string($source) || !isset($configured[$source])) {
                throw new \InvalidArgumentException('CKM_SOURCE_UNKNOWN');
            }
        }
        // Caller order determines which source is attempted first within the shared budget.
        $deadline = hrtime(true) / 1e9 + (int) $this->settings->get('CKM_FEDERATION_TIMEOUT');
        $items = [];
        $results = [];
        $truncated = false;
        foreach ($sources as $source) {
            $remaining = $deadline - hrtime(true) / 1e9;
            $result = ['source' => $source, 'status' => 'NOT_EXECUTED', 'reported_total' => null, 'returned' => 0, 'error' => 'FEDERATION_TIME_BUDGET'];
            if ($remaining > 0.01) {
                try {
                    $found = $this->provider->search($source, $kind, $keyword, $maxResults, $remaining);
                    $result = ['source' => $source, 'status' => 'PASS', 'reported_total' => $found['total'], 'returned' => count($found['items']), 'error' => null];
                    $truncated = $truncated || $found['total'] > count($found['items']);
                    foreach ($found['items'] as $item) {
                        $items[] = ['source' => $source, 'source_url' => $configured[$source], 'kind' => $kind] + $item;
                    }
                } catch (\Throwable) {
                    // Exception bodies may contain upstream or credential details. Never expose them.
                    $result['status'] = 'FAILED';
                    $result['error'] = 'CKM_SOURCE_UNAVAILABLE';
                }
            }
            $results[] = $result;
        }
        usort($items, static fn (array $a, array $b): int => ($b['score'] <=> $a['score'])
            ?: ([$a['source'], $a['cid'], $a['revision'] ?? $a['version'] ?? '', $a['archetypeId'] ?? '', $a['name'] ?? '']
                <=> [$b['source'], $b['cid'], $b['revision'] ?? $b['version'] ?? '', $b['archetypeId'] ?? '', $b['name'] ?? '']));
        $total = count($items);
        $truncated = $truncated || $total > $maxResults;
        $passed = count(array_filter($results, static fn (array $r): bool => $r['status'] === 'PASS'));
        return ['items' => array_slice($items, 0, $maxResults), 'total' => $total,
            'total_scope' => 'Retrieved per-source candidates before the final limit; not a global CKM match count.',
            'status' => $passed === count($results) ? 'COMPLETE' : ($passed === 0 ? 'UNAVAILABLE' : 'PARTIAL'),
            'all_sources_responded' => $passed === count($results), 'truncated' => $truncated,
            'source_results' => $results, 'ranking' => 'Existing lexical/status score, then source name, CID, revision and model/name identity.',
            'scope' => 'Configured-source discovery windows; duplicate identifiers from different sources retain separate provenance. Retrieval never substitutes another source.' ];
    }
}
