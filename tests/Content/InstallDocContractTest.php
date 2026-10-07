<?php

declare(strict_types=1);
namespace OpenEHR\Assistant\Tests\Content;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;
#[CoversNothing]
final class InstallDocContractTest extends TestCase
{
    public function test_independent_installation_is_documented(): void
    {
        $doc = (string) file_get_contents(__DIR__ . '/../../docs/install.md');
        self::assertStringContainsString('github.com/CzarMich/openehr-modelling-assistant', $doc);
        self::assertStringContainsString('docker compose up -d --build', $doc);
        self::assertStringContainsString('DEPLOYMENT.md', $doc);
        self::assertStringNotContainsString('apps.cadasto.com', $doc);
        self::assertSame(0, preg_match_all('/^(```|~~~)/m', $doc) % 2);
        preg_match_all('/\]\((?!https?:|mailto:|#|\/)([^)\s#]+)/', $doc, $matches);
        foreach ($matches[1] as $target) {
            $resolved = realpath(__DIR__ . '/../../docs/' . $target);
            self::assertNotFalse($resolved);
            self::assertStringStartsWith((string) realpath(__DIR__ . '/../..') . '/', $resolved);
        }
    }
    public function test_product_terms_preserve_the_complete_upstream_mit_notice(): void
    {
        $root = __DIR__ . '/../..';
        $terms = (string) file_get_contents($root . '/LICENSE');
        $notices = (string) file_get_contents($root . '/THIRD_PARTY_NOTICES.md');
        self::assertStringContainsString("Copyright © 2026 Michael Anywar.\n", $terms);
        self::assertSame(1, preg_match('/```text\n(.*?)```/s', $notices, $match));
        // Exact upstream LICENSE bytes at the inherited baseline, including all MIT conditions.
        self::assertSame('4b0d2a1d19b17fe92b1e68a85a6e538f0207bc9047af5301738f1040c3049607', hash('sha256', $match[1]));
        self::assertSame($match[1], str_replace("Copyright © 2026 Michael Anywar.\n", '', $terms));
        $package = json_decode((string) file_get_contents($root . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
        self::assertSame('MIT', $package['license']);
        self::assertSame(['Michael Anywar'], array_column($package['authors'], 'name'));
        $chat = json_decode((string) file_get_contents($root . '/chat/package.json'), true, 512, JSON_THROW_ON_ERROR);
        $lock = json_decode((string) file_get_contents($root . '/chat/package-lock.json'), true, 512, JSON_THROW_ON_ERROR);
        self::assertSame('MIT', $chat['license']);
        self::assertSame($chat['license'], $lock['packages']['']['license']);
    }

}
