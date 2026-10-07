<?php

declare(strict_types=1);

/** Run inside the PHP container. Credentials are environment-only; output excludes tokens and model content. */
require dirname(__DIR__) . '/vendor/autoload.php';

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Repository\Hosted\HostedProviderFactory;

$options = getopt('', ['review-branch:', 'review-target:', 'allow-test-review']);
try {
    $provider = HostedProviderFactory::create(Settings::fromEnvironment()) ?? throw new RuntimeException('HOSTED_PROVIDER_REQUIRED');
    $metadata = $provider->metadata();
    $branches = $provider->branches();
    $checks = ['repository_metadata', 'branch_metadata'];
    $review = null;
    if (isset($options['review-branch'])) {
        if (!array_key_exists('allow-test-review', $options) || !is_string($options['review-branch'])
            || !str_starts_with($options['review-branch'], 'acceptance/')) { throw new RuntimeException('EXPLICIT_TEST_REVIEW_REQUIRED'); }
        $target = is_string($options['review-target'] ?? null) ? $options['review-target'] : 'main';
        $review = $provider->requestReview($options['review-branch'], $target, 'Synthetic repository acceptance',
            'Synthetic test data only. This draft is not a clinical model or clinical approval. Close after acceptance.');
        if ($review['draft'] !== true || $review['clinical_approval'] !== false) { throw new RuntimeException('DRAFT_REVIEW_REQUIRED'); }
        $again = $provider->requestReview($options['review-branch'], $target, 'Synthetic repository acceptance', '');
        if ($again['number'] !== $review['number'] || $again['created'] !== false) { throw new RuntimeException('REVIEW_REUSE_FAILED'); }
        $read = $provider->review($review['number']);
        if ($read['number'] !== $review['number'] || $read['source_revision'] !== $review['source_revision']) { throw new RuntimeException('REVIEW_READ_FAILED'); }
        $checks = [...$checks, 'draft_review_creation', 'existing_review_reuse', 'review_revision_read'];
    }
    echo json_encode(['status' => 'PASS', 'provider' => $metadata['provider'], 'repository' => $metadata['repository'],
        'branch_count_first_page' => count($branches['branches']), 'checks' => $checks,
        'review_number' => $review['number'] ?? null, 'review_url' => $review['url'] ?? null,
        'timestamp' => gmdate(DATE_ATOM)], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable $error) {
    // SDK/network messages may contain credential-bearing request details.
    fwrite(STDERR, "Hosted repository acceptance failed; inspect configuration and provider access.\n");
    exit(1);
}
