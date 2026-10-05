<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Integrations\Cache\ModelReadCache;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class StorageConfigurationTest extends TestCase
{
    public function test_optional_cache_and_sqlite_remain_usable_without_services(): void
    {
        $settings = new Settings();
        self::assertSame('sqlite', $settings->get('GOVERNANCE_DATABASE_DRIVER'));
        self::assertSame(['value' => 'source'], (new ModelReadCache($settings, 'fixture'))->remember('revision', fn () => ['value' => 'source']));
    }

    public function test_unsafe_or_incomplete_storage_settings_are_rejected(): void
    {
        foreach ([['GOVERNANCE_DATABASE_DRIVER' => 'unknown'], ['GOVERNANCE_DATABASE_DRIVER' => 'postgres'],
            ['MODEL_CACHE_DRIVER' => 'redis'], ['MODEL_CACHE_TTL' => '0'], ['MODEL_CACHE_TTL' => '86401'],
            ['MODEL_CACHE_NAMESPACE' => 'other:*'], ['MODEL_CACHE_SIGNING_KEY_FILE' => '/tmp/../secret'],
            ['GOVERNANCE_DATABASE_DRIVER' => 'postgres', 'GOVERNANCE_POSTGRES_DSN' => 'pgsql:host=db;password=secret', 'GOVERNANCE_POSTGRES_PASSWORD_FILE' => '/secrets/password']] as $config) {
            try {
                new Settings($config);
                self::fail('Unsafe configuration accepted');
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function test_cache_failure_does_not_mask_authoritative_repository_error(): void
    {
        $cache = new ModelReadCache(new Settings(['MODEL_CACHE_DRIVER' => 'redis', 'MODEL_CACHE_PASSWORD_FILE' => '/not-present',
            'MODEL_CACHE_SIGNING_KEY_FILE' => '/not-present']), 'fixture');
        $this->expectExceptionMessage('PROJECT_NOT_FOUND');
        $cache->remember('revision', static fn () => throw new \RuntimeException('PROJECT_NOT_FOUND'));
    }
}
