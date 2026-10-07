<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Integrations\Governance\SqliteAuditStore;
use PDO;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class GovernanceAuditStoreTest extends TestCase
{
    private string $directory;
    private string $path;
    private const string SUBJECT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/governance-ledger-' . bin2hex(random_bytes(8));
        $this->path = $this->directory . '/audit.sqlite';
    }
    protected function tearDown(): void
    {
        foreach (glob($this->directory . '/*') ?: [] as $file) { unlink($file); }
        if (is_dir($this->directory)) { rmdir($this->directory); }
    }
    private function event(string $state = 'DRAFT'): array
    {
        return ['project' => 'project', 'actor' => ['id' => 'agent-fixture', 'human' => false], 'new_state' => $state, 'comment' => 'Synthetic test'];
    }

    public function test_events_are_append_only_hash_linked_and_durable_across_connections(): void
    {
        $store = new SqliteAuditStore($this->path); $first = $store->append('shared', self::SUBJECT, 0, $this->event());
        self::assertSame(1, $first['sequence']); self::assertSame(str_repeat('0', 64), $first['previous_hash']);
        $second = (new SqliteAuditStore($this->path))->append('shared', self::SUBJECT, 1, $this->event('REVIEW_REQUESTED'));
        self::assertSame($first['hash'], $second['previous_hash']); self::assertSame([$first, $second], $store->events('shared', self::SUBJECT));
        self::assertSame('REVIEW_REQUESTED', $store->subjects('shared', 'project')[0]['latest']['new_state']);
        self::assertSame(0600, fileperms($this->path) & 0777);
        $database = new PDO('sqlite:' . $this->path, options: [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        foreach (['UPDATE governance_events SET hash = "forged"', 'DELETE FROM governance_events'] as $sql) {
            try { $database->exec($sql); self::fail('Ledger must reject mutation'); }
            catch (\PDOException $error) { self::assertStringContainsString('GOVERNANCE_EVENTS_IMMUTABLE', $error->getMessage()); }
        }
        self::assertSame([$first, $second], $store->events('shared', self::SUBJECT));
    }

    public function test_stale_sequence_and_subject_project_changes_fail_without_partial_writes(): void
    {
        $store = new SqliteAuditStore($this->path); $first = $store->append('shared', self::SUBJECT, 0, $this->event());
        foreach ([[0, $this->event(), 'GOVERNANCE_REVISION_CONFLICT'], [1, array_replace($this->event(), ['project' => 'other']), 'GOVERNANCE_SUBJECT_IDENTITY_CONFLICT']] as [$sequence, $event, $code]) {
            try { $store->append('shared', self::SUBJECT, $sequence, $event); self::fail('Expected conflict'); }
            catch (\RuntimeException $error) { self::assertSame($code, $error->getMessage()); }
        }
        self::assertSame([$first], $store->events('shared', self::SUBJECT));
        self::assertSame(2, $store->append('shared', self::SUBJECT, 1, $this->event())['sequence']);
    }

    public function test_tenant_and_project_queries_never_cross_namespaces(): void
    {
        $store = new SqliteAuditStore($this->path); $tenant = hash('sha256', 'another-tenant');
        $store->append('shared', self::SUBJECT, 0, $this->event());
        self::assertSame([], $store->events($tenant, self::SUBJECT)); self::assertSame([], $store->subjects('shared', 'another'));
        $store->append($tenant, self::SUBJECT, 0, array_replace($this->event(), ['comment' => 'Separate tenant']));
        self::assertSame('Synthetic test', $store->events('shared', self::SUBJECT)[0]['comment']);
        self::assertSame('Separate tenant', $store->events($tenant, self::SUBJECT)[0]['comment']);
    }

    public function test_stream_filter_applies_before_pagination(): void
    {
        $store = new SqliteAuditStore($this->path);
        foreach (['a' => 'MODEL_IMPORT_REQUESTED', 'b' => 'REGISTER', 'c' => 'MODEL_IMPORT_REQUESTED', 'd' => 'REGISTER'] as $id => $type) {
            $store->append('shared', str_repeat($id, 64), 0, ['type' => $type] + $this->event());
        }
        self::assertSame(str_repeat('b', 64), $store->subjects('shared', 'project', 1, 0, 'REGISTER')[0]['subject']);
        self::assertSame(str_repeat('d', 64), $store->subjects('shared', 'project', 1, 1, 'REGISTER')[0]['subject']);
        self::assertCount(2, $store->subjects('shared', 'project', firstType: 'MODEL_IMPORT_REQUESTED'));
        self::assertCount(4, $store->subjects('shared', 'project'));
        $this->expectExceptionMessage('INVALID_AUDIT_STREAM_TYPE');
        $store->subjects('shared', 'project', firstType: "' OR 1=1 --");
    }

    public function test_duplicate_assertion_is_rejected_across_connections(): void
    {
        $nonce = bin2hex(random_bytes(32)); $store = new SqliteAuditStore($this->path); $store->consumeNonce($nonce, time() + 60);
        $this->expectExceptionMessage('GOVERNANCE_ASSERTION_REPLAYED'); (new SqliteAuditStore($this->path))->consumeNonce($nonce, time() + 60);
    }

    public function test_expired_or_long_lived_assertions_are_not_consumed(): void
    {
        $store = new SqliteAuditStore($this->path);
        foreach ([time() - 1, time() + 121] as $expires) {
            try { $store->consumeNonce(bin2hex(random_bytes(32)), $expires); self::fail('Invalid assertion'); }
            catch (\InvalidArgumentException $error) { self::assertSame('INVALID_GOVERNANCE_ASSERTION', $error->getMessage()); }
        }
    }

    public function test_external_database_corruption_is_detected(): void
    {
        $store = new SqliteAuditStore($this->path); $store->append('shared', self::SUBJECT, 0, $this->event());
        $database = new PDO('sqlite:' . $this->path); $database->exec('DROP TRIGGER immutable_governance_update; UPDATE governance_events SET event = \'{}\'');
        $this->expectExceptionMessage('GOVERNANCE_AUDIT_INTEGRITY_FAILED'); $store->events('shared', self::SUBJECT);
    }

    public function test_oversized_events_and_caller_assigned_audit_fields_are_rejected(): void
    {
        $store = new SqliteAuditStore($this->path);
        foreach ([array_replace($this->event(), ['comment' => str_repeat('x', 65536)]), $this->event() + ['timestamp' => 'forged']] as $event) {
            try { $store->append('shared', self::SUBJECT, 0, $event); self::fail('Invalid event accepted'); }
            catch (\InvalidArgumentException) { self::assertSame([], $store->events('shared', self::SUBJECT)); }
        }
    }

    public function test_database_symlinks_are_rejected(): void
    {
        mkdir($this->directory, 0700); file_put_contents($this->directory . '/target', ''); symlink($this->directory . '/target', $this->path);
        $this->expectExceptionMessage('INVALID_GOVERNANCE_DATABASE_PATH'); new SqliteAuditStore($this->path);
    }

    public function test_competing_processes_cannot_append_the_same_sequence(): void
    {
        new SqliteAuditStore($this->path);
        $script = 'require $argv[1]; try { $s=new OpenEHR\\Assistant\\Integrations\\Governance\\SqliteAuditStore($argv[2]); $s->append("shared",str_repeat("a",64),0,["project"=>"project","new_state"=>"DRAFT"]); exit(0); } catch (RuntimeException $e) { exit($e->getMessage()==="GOVERNANCE_REVISION_CONFLICT"?2:3); }';
        $processes = [];
        for ($i = 0; $i < 2; $i++) {
            $process = proc_open([PHP_BINARY, '-r', $script, dirname(__DIR__, 2) . '/vendor/autoload.php', $this->path], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
            self::assertIsResource($process); $processes[] = $process;
        }
        $exits = array_map('proc_close', $processes); sort($exits); self::assertSame([0, 2], $exits);
        self::assertCount(1, (new SqliteAuditStore($this->path))->events('shared', self::SUBJECT));
    }
}
