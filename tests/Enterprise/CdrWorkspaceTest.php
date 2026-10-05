<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Enterprise;

use OpenEHR\Assistant\Application\CdrWorkspace;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Application\AqlWorkbench;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Cdr\CdrAdapter;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Integrations\Cdr\CdrConnection;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;
use OpenEHR\Assistant\Integrations\Cdr\EncryptedCdrStore;
use OpenEHR\Assistant\Tools\CdrTools;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\TestCase;

#[CoversNothing]
final class CdrWorkspaceTest extends TestCase
{
    private string $directory;
    private Settings $settings;
    private Actor $actor;
    private array $calls = [];
    private bool $cancelDuringRequest = false;
    private ?string $failure = null;
    private CdrWorkspace $workspace;
    public NativeModels $models;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . '/cdr-' . bin2hex(random_bytes(8));
        mkdir($this->directory, 0700);
        file_put_contents($this->directory . '/key', str_repeat('a', 64));
        $this->settings = new Settings(['CDR_ENABLED' => 'true', 'CDR_DATA_DIR' => $this->directory, 'CDR_ENCRYPTION_KEY_FILE' => $this->directory . '/key']);
        $this->actor = new Actor('alice', 'shared', [], true, 'interactive_local');
        $engine = $this->createStub(OpenEhrEngine::class);
        $engine->method('validate')->willReturnCallback(static function (string $query): array {
            $valid = str_starts_with($query, 'SELECT');
            preg_match('/LIMIT (\d+)/', $query, $limit);
            return ['valid' => $valid, 'checks' => ['aql_syntax' => $valid ? 'PASS' : 'FAIL'], 'normalized_query' => $query,
                'ast' => ['select' => [], 'limit' => isset($limit[1]) ? (int) $limit[1] : null]];
        });
        $engine->method('inspect')->willReturn(['valid' => true, 'identifier' => 'test_template', 'inspection' => ['paths' => [['path' => '/', 'rm_type' => 'COMPOSITION'], ['path' => '/content[at0001]', 'rm_type' => 'OBSERVATION']]]]);
        $this->models = new NativeModels($engine);
        $adapter = $this->createStub(CdrAdapter::class);
        $adapter->method('execute')->willReturnCallback(function (array $connection, string $query, array $parameters, ?int $fetch, ?int $offset, callable $cancelled): array {
            $this->calls[] = compact('connection', 'query', 'parameters', 'fetch', 'offset');
            if ($this->cancelDuringRequest) { $this->workspace->cancel(str_repeat('b', 32)); }
            if ($cancelled()) { throw new \RuntimeException('CDR_CANCELLED'); }
            if ($this->failure !== null) { throw new \RuntimeException($this->failure); }
            return ['columns' => [['name' => 'value']], 'rows' => [['synthetic-result-never-persist']], 'count' => 1];
        });
        $this->workspace = new CdrWorkspace($this->settings, $this->actor, $adapter, new CdrConnection(new CdrHttp($this->settings)), $this->models);
    }
    protected function tearDown(): void
    {
        foreach (glob($this->directory . '/*') as $path) { unlink($path); } rmdir($this->directory);
    }
    private function connection(string $name = 'Development'): array
    {
        return $this->workspace->saveConnection(['name' => $name, 'baseUrl' => 'https://cdr.example', 'auth' => 'bearer', 'secrets' => ['token' => 'private-fixture-token']]);
    }
    public function test_connections_are_private_encrypted_and_can_be_updated_without_resending_secrets(): void
    {
        $first = $this->connection(); $second = $this->connection('Test');
        self::assertNotSame($first['id'], $second['id']);
        self::assertCount(2, $this->workspace->connections()['items']);
        self::assertStringNotContainsString('private-fixture-token', json_encode($this->workspace->connections()));
        $this->workspace->saveConnection(['id' => $first['id'], 'name' => 'Changed', 'secrets' => ['token' => '']]);
        $stored = (new EncryptedCdrStore($this->settings, $this->actor))->read();
        self::assertSame('private-fixture-token', $stored['connections'][$first['id']]['secrets']['token']);
        foreach (glob($this->directory . '/*.json') as $path) { self::assertStringNotContainsString('private-fixture-token', file_get_contents($path)); self::assertSame(0600, fileperms($path) & 0777); }
        $bob = new EncryptedCdrStore($this->settings, new Actor('bob', 'shared', []));
        self::assertSame([], $bob->read()['connections']);
        $this->workspace->deleteConnection($first['id']); self::assertCount(1, $this->workspace->connections()['items']);
    }
    public function test_execution_returns_metadata_to_mcp_and_never_persists_results_or_parameters(): void
    {
        $id = $this->connection()['id'];
        $result = $this->workspace->execute($id, 'SELECT e/ehr_id/value FROM EHR e WHERE e/ehr_id/value = $ehr', ['ehr' => 'synthetic-parameter-never-persist'], 25, 5);
        self::assertSame(1, $result['count']); self::assertArrayNotHasKey('rows', $result);
        self::assertSame(25, $this->calls[0]['fetch']); self::assertSame(5, $this->calls[0]['offset']);
        $history = $this->workspace->history()['items']; self::assertSame(['ehr'], $history[0]['parameter_names']);
        $state = json_encode((new EncryptedCdrStore($this->settings, $this->actor))->read());
        self::assertStringNotContainsString('synthetic-result-never-persist', $state); self::assertStringNotContainsString('synthetic-parameter-never-persist', $state);
        $browser = $this->workspace->execute($id, 'SELECT e FROM EHR e LIMIT 10', includeResults: true);
        self::assertSame([['synthetic-result-never-persist']], $browser['rows']); self::assertNull($this->calls[1]['fetch']); self::assertNull($this->calls[1]['offset']);
    }
    public function test_ai_tools_cannot_execute_or_read_patient_literals_from_query_libraries(): void
    {
        $id = $this->connection()['id'];
        $saved = $this->workspace->saveQuery('Synthetic patient name', "SELECT e FROM EHR e WHERE e/ehr_id/value = 'synthetic-patient-id'");
        $tools = new CdrTools($this->workspace, new AqlWorkbench($this->models));
        foreach ([$tools->execute($id, 'SELECT e FROM EHR e'), $tools->history(), $tools->saved(), $tools->get($saved['id'])] as $denial) {
            self::assertFalse($denial['success']);
            self::assertSame('CDR_BROWSER_ONLY', $denial['error']['code']);
            self::assertNull($denial['result']);
            self::assertStringNotContainsString('synthetic-patient-id', json_encode($denial));
            self::assertStringNotContainsString('Synthetic patient name', json_encode($denial));
        }
        self::assertSame([], $this->calls);
        self::assertSame($saved, $this->workspace->saved($saved['id']));
    }
    public function test_query_syntax_bounds_and_pagination_fail_before_remote_call(): void
    {
        $id = $this->connection()['id'];
        foreach ([['DROP EHR', 100, 0], ['SELECT e FROM EHR e LIMIT 0', 100, 0], ['SELECT e FROM EHR e LIMIT 1001', 100, 0], ['SELECT e FROM EHR e LIMIT 10', 100, 5], ['SELECT e FROM EHR e', 1001, 0]] as [$query, $fetch, $offset]) {
            try { $this->workspace->execute($id, $query, [], $fetch, $offset); self::fail('Unsafe request accepted'); } catch (\InvalidArgumentException) { self::addToAssertionCount(1); }
        }
        self::assertSame([], $this->calls);
    }
    public function test_cancel_before_and_during_request_and_safe_failure_history(): void
    {
        $id = $this->connection()['id'];
        $this->workspace->cancel(str_repeat('c', 32));
        try { $this->workspace->execute($id, 'SELECT e FROM EHR e', job: str_repeat('c', 32)); self::fail(); } catch (\RuntimeException $error) { self::assertSame('CDR_CANCELLED', $error->getMessage()); }
        self::assertSame([], $this->calls);
        $this->cancelDuringRequest = true;
        try { $this->workspace->execute($id, 'SELECT e FROM EHR e', job: str_repeat('b', 32)); self::fail(); } catch (\RuntimeException $error) { self::assertSame('CDR_CANCELLED', $error->getMessage()); }
        self::assertSame('CANCELLED', $this->workspace->history()['items'][0]['status']);
        $this->cancelDuringRequest = false; $this->failure = 'Remote error reflecting a private-fixture-token';
        try { $this->workspace->execute($id, 'SELECT e FROM EHR e'); self::fail(); } catch (\RuntimeException $error) { self::assertSame('CDR_OPERATION_FAILED', $error->getMessage()); }
        self::assertStringNotContainsString('private-fixture-token', json_encode($this->workspace->history()));
    }
    public function test_saved_queries_and_model_generation_use_exact_paths(): void
    {
        $saved = $this->workspace->saveQuery('Example', 'SELECT e FROM EHR e');
        self::assertSame($saved, $this->workspace->saved($saved['id']));
        self::assertCount(1, $this->workspace->saved()['items']);
        $this->workspace->deleteQuery($saved['id']); self::assertSame([], $this->workspace->saved()['items']);
        $model = new AqlWorkbench($this->models);
        $generated = $model->generate('synthetic model', 'opt14', ['/content[at0001]']);
        self::assertStringContainsString('m/content[at0001]', $generated['query']); self::assertStringContainsString('$template_id', $generated['query']);
        $this->expectExceptionMessage('ENGINE_QUERY_PATH_NOT_IN_MODEL'); $model->generate('synthetic model', 'opt14', ['/invented']);
    }
    public function test_encrypted_state_is_authenticated_and_actor_bound(): void
    {
        $this->connection(); $file = glob($this->directory . '/*.json')[0];
        $value = json_decode(file_get_contents($file), true); $value['tag'] = base64_encode(str_repeat('0', 16)); file_put_contents($file, json_encode($value));
        $this->expectExceptionMessage('CDR_STORAGE_INVALID'); $this->workspace->connections();
    }
    public function test_central_cdr_does_not_share_query_libraries_between_users_or_environments(): void
    {
        file_put_contents($this->directory . '/central.json', json_encode(['connections' => [
            ['allowedActors' => ['alice', 'bob'], 'connection' => ['id' => 'central', 'name' => 'Central', 'baseUrl' => 'https://cdr.example']],
            ['allowedActors' => ['alice', 'bob'], 'connection' => ['id' => 'training', 'name' => 'Training', 'baseUrl' => 'https://training.example']],
        ]]));
        $settings = new Settings(['CDR_ENABLED' => 'true', 'CDR_DATA_DIR' => $this->directory,
            'CDR_ENCRYPTION_KEY_FILE' => $this->directory . '/key', 'CDR_CONNECTIONS_FILE' => $this->directory . '/central.json']);
        $workspace = fn (Actor $actor): CdrWorkspace => new CdrWorkspace($settings, $actor,
            $this->createStub(CdrAdapter::class), new CdrConnection(new CdrHttp($settings)), $this->models);
        $alice = $workspace($this->actor);
        $bob = $workspace(new Actor('bob', 'shared', [], true, 'interactive_local'));
        self::assertCount(2, $alice->connections()['items']); self::assertCount(2, $bob->connections()['items']);
        $one = $alice->saveQuery('Private central query', 'SELECT e FROM EHR e LIMIT 10', connectionId: 'central');
        $two = $alice->saveQuery('Training query', 'SELECT e FROM EHR e LIMIT 5', connectionId: 'training');
        $old = $alice->saveQuery('Unassigned query', 'SELECT e FROM EHR e LIMIT 1');
        self::assertSame([$one], $alice->saved(connectionId: 'central')['items']);
        self::assertSame([$two], $alice->saved(connectionId: 'training')['items']);
        self::assertSame([$old], $alice->saved(connectionId: '')['items']);
        self::assertSame([], $bob->saved(connectionId: 'central')['items']);
        foreach ([$bob, $workspace(new Actor('alice', str_repeat('b', 64), [], true, 'interactive_local'))] as $other) {
            try { $other->saved($one['id']); self::fail('Another identity read a saved query'); }
            catch (\RuntimeException $error) { self::assertSame('CDR_SAVED_QUERY_NOT_FOUND', $error->getMessage()); }
        }
        try { $alice->deleteQuery($one['id'], 'training'); self::fail('Cross-environment deletion accepted'); }
        catch (\RuntimeException $error) { self::assertSame('CDR_SAVED_QUERY_NOT_FOUND', $error->getMessage()); }
        self::assertSame($one, $alice->saved($one['id']));
        $store = new EncryptedCdrStore($settings, $this->actor);
        $store->update(static function (array $state): array {
            $state['history'] = [['connection_id' => 'central', 'query' => 'central query'], ['connection_id' => 'training', 'query' => 'training query']];
            return $state;
        });
        self::assertCount(1, $alice->history('central')['items']);
        $alice->clearHistory('central');
        self::assertSame('training query', $alice->history()['items'][0]['query']);
        self::assertSame([], $bob->history()['items']);
    }
}
