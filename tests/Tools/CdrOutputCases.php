<?php

declare(strict_types=1);

namespace OpenEHR\Assistant\Tests\Tools;

use OpenEHR\Assistant\Application\AqlWorkbench;
use OpenEHR\Assistant\Application\CdrWorkspace;
use OpenEHR\Assistant\Application\NativeModels;
use OpenEHR\Assistant\Configuration\Settings;
use OpenEHR\Assistant\Domain\Cdr\CdrAdapter;
use OpenEHR\Assistant\Domain\Governance\Actor;
use OpenEHR\Assistant\Domain\Modelling\OpenEhrEngine;
use OpenEHR\Assistant\Integrations\Cdr\CdrConnection;
use OpenEHR\Assistant\Integrations\Cdr\CdrHttp;
use OpenEHR\Assistant\Tools\CdrTools;

trait CdrOutputCases
{
    private function cdrCase(string $method): void
    {
        $directory = sys_get_temp_dir() . '/cdr-output-' . bin2hex(random_bytes(8)); mkdir($directory, 0700); file_put_contents($directory . '/key', str_repeat('a', 64));
        try {
            $settings = new Settings(['CDR_ENABLED' => 'true', 'CDR_DATA_DIR' => $directory, 'CDR_ENCRYPTION_KEY_FILE' => $directory . '/key']);
            $engine = $this->createStub(OpenEhrEngine::class);
            $engine->method('validate')->willReturn(['valid' => true, 'checks' => ['aql_syntax' => 'PASS'], 'ast' => ['select' => []], 'normalized_query' => 'SELECT e FROM EHR e']);
            $engine->method('inspect')->willReturn(['valid' => true, 'identifier' => 'example', 'inspection' => ['paths' => [['path' => '/', 'rm_type' => 'COMPOSITION']]]]);
            $models = new NativeModels($engine); $adapter = $this->createStub(CdrAdapter::class);
            $adapter->method('test')->willReturn(['ok' => true, 'checks' => ['aql' => 'PASS']]); $adapter->method('execute')->willReturn(['count' => 0, 'rows' => []]);
            $workspace = new CdrWorkspace($settings, new Actor('test', 'shared', [], true, 'interactive_local'), $adapter, new CdrConnection(new CdrHttp($settings)), $models);
            $connection = $workspace->saveConnection(['name' => 'Example', 'baseUrl' => 'https://cdr.example']);
            $saved = $workspace->saveQuery('Example', 'SELECT e FROM EHR e');
            $args = match ($method) { 'test', 'capabilities' => [$connection['id']], 'execute' => [$connection['id'], 'SELECT e FROM EHR e'], 'get' => [$saved['id']], 'save' => ['New', 'SELECT e FROM EHR e'], 'explain' => ['SELECT e FROM EHR e'], 'generate' => ['model', 'opt14'], default => [] };
            $this->assertConforms(new CdrTools($workspace, new AqlWorkbench($models)), $method, $args);
        } finally { foreach (glob($directory . '/*') as $path) { unlink($path); } rmdir($directory); }
    }
    public function test_cdr_connection_list_result_matches_output_schema(): void { $this->cdrCase('connections'); }
    public function test_cdr_connection_test_result_matches_output_schema(): void { $this->cdrCase('test'); }
    public function test_cdr_capabilities_result_matches_output_schema(): void { $this->cdrCase('capabilities'); }
    public function test_aql_explain_result_matches_output_schema(): void { $this->cdrCase('explain'); }
    public function test_aql_execute_result_matches_output_schema(): void { $this->cdrCase('execute'); }
    public function test_aql_history_result_matches_output_schema(): void { $this->cdrCase('history'); }
    public function test_aql_saved_list_result_matches_output_schema(): void { $this->cdrCase('saved'); }
    public function test_aql_saved_get_result_matches_output_schema(): void { $this->cdrCase('get'); }
    public function test_aql_saved_save_result_matches_output_schema(): void { $this->cdrCase('save'); }
    public function test_model_generate_aql_result_matches_output_schema(): void { $this->cdrCase('generate'); }
}
